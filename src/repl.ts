import { PromptHistory } from './prompt-history.js';
import { parseModelInput } from './model-input.js';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { InteractiveInput, startInteractiveUi } from './interactive-ui.js';
import chalk from 'chalk';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { maskKey } from './auth.js';
import { BudgetExceededError, CostTracker, loadLedger } from './cost.js';
import { setConfigValue, type ResolvedConfig } from './config.js';
import { apiClient, listModels, probeModel } from './models.js';
import { CYCLE_MODES, MODE_INFO, newPermissionState, parsePermissionMode, PathGuard, PERMISSION_MODES, type CvpPermissionMode } from './permissions.js';
import { ui } from './render.js';

export interface ReplContext {
  apiKey: string;
  cfg: ResolvedConfig;
  model: string;
  resume?: string;
  continueLast?: boolean;
  raw: boolean;
}

const HELP = `
${chalk.bold('내부 명령어')}
  /help              명령어 안내 (작업 중 Alt+S: 현재 작업에 지시 추가)
  /ui                작업 모드 전환 (대기열·초안·기록·모델)
  /model [id]        현재 모델 조회 / 모델 변경(실제 API 호출로 권한 검증 후 적용)
  /mode [모드]       권한 모드 조회 / 변경 (default | acceptEdits | plan | bypass | fullbypass)
  /models            조회 가능한 모델 목록(GET /v1/models)
  /status            상태 패널 표시·숨기기 (파이프에서는 상태 출력)
  /usage             토큰 사용량 및 예상 비용
  /context /autocompact /cache  압축 여유·캐시 추정 상태
  /compact [지침]    현재 대화 수동 요약·압축
  /todos             에이전트 할 일과 진행도
  /tasks             백그라운드 작업 목록
  /task <id> /stop <id>  작업 상태·결과 조회 / 중단
  /clear             현재 대화 초기화(새 세션 시작)
  /sessions          저장된 세션 목록
  /resume [번호|ID]  이전 세션 재개
  /exit              CLI 종료

${chalk.bold('입력')}
  기본 Enter: 줄바꿈 · Ctrl+Enter: 대기 전송 · Shift+Enter: 중단 후 전송 (TTY)
  추가 끼어들기 키: cvp config set interruptKey ctrl+g (ctrl+k, ctrl+u 가능)
  cvp config set enterAction/ctrlEnterAction/shiftEnterAction 으로 변경 · 한 줄 /명령은 Enter 실행\n  줄 끝 \\ 연결 입력은 파이프에서 유지, Shift+Tab 으로 권한 모드 전환(default → acceptEdits → plan)
  Ctrl+C 로 실행 중단, 대기 중 Ctrl+C 두 번 또는 Ctrl+D 로 종료
`;

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 5 : 4)}`;
}

export async function runRepl(ctx: ReplContext): Promise<void> {
  const { cfg } = ctx;
  let atMainPrompt = false;
  const interactive = process.stdin.isTTY && process.stdout.isTTY ? new InteractiveInput(new PromptHistory(cfg.cwd)) : undefined;
  if (interactive) interactive.enhanced = cfg.workspaceMode;
  let disposeUi: (() => void) | undefined;
  const write = (text: string) => { if (interactive) interactive.write(text); else process.stdout.write(text); };
  const input = interactive ? new PassThrough() : process.stdin;
  const rl = readline.createInterface({ input, output: interactive ? new PassThrough() : process.stdout, terminal: false, historySize: 500 });
  const lines: string[] = [];
  const waiters: ((l: string | null) => void)[] = [];
  let closed = false;
  let discardLine = false;
  rl.on('line', (line) => {
    if(discardLine)return;
    const l = line;
    if (l === undefined) { rl.setPrompt(chalk.dim('… ')); rl.prompt(); return; }
    const w = waiters.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  const readLine = (prompt: string, signal?: AbortSignal, priority = false): Promise<string | null> => {
    if (interactive) return interactive.readLine(prompt, signal);
    if (signal?.aborted) return Promise.resolve(null);
    if (lines.length && !priority) {
      if (!process.stdin.isTTY) write(prompt);
      return Promise.resolve(lines.shift()!);
    }
    if (closed) return Promise.resolve(null);
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((resolve) => {
      const finish = (line: string | null) => { signal?.removeEventListener('abort', abort); resolve(line); };
      const abort = () => { const i = waiters.indexOf(finish); if (i >= 0) waiters.splice(i, 1); finish(null); };
      if(priority)waiters.unshift(finish);else waiters.push(finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  const clearInputLine = () => {
    if(process.env.TERM==='dumb'){
      discardLine=true;try{rl.write(null,{name:'return'});}finally{discardLine=false;}
    }else{rl.write(null,{ctrl:true,name:'a'});rl.write(null,{ctrl:true,name:'k'});}
  };
  const ask = async (q: string, signal?: AbortSignal) => {
    if (interactive) return (await interactive.ask(q, signal)) ?? 'n';
    const suspendedInput=waiters.length>0;
    const wasMain=atMainPrompt;
    const previousPrompt=rl.getPrompt();
    const draft=suspendedInput?rl.line:'';
    if(suspendedInput){atMainPrompt=false;clearInputLine();}
    try {return (await readLine(q,signal,suspendedInput))??'n';}
    finally {if(suspendedInput&&!closed){atMainPrompt=wasMain;rl.setPrompt(wasMain?mainPrompt():previousPrompt);if(draft)rl.write(draft);rl.prompt(true);}}
  };

  const guard = new PathGuard(cfg.cwd, cfg.additionalDirectories);
  const permState = newPermissionState(cfg.permissionMode, cfg.supervised);
  const modeTag = () => {
    const m = permState.mode;
    if (m === 'default') return '';
    const color = (m === 'bypass' || m === 'fullbypass') ? chalk.red : m === 'plan' ? chalk.cyan : chalk.yellow;
    return color(`[${MODE_INFO[m].label}] `);
  };
  const mainPrompt = () => modeTag() + chalk.bold.green('> ');
  const announceMode = () =>
    write(ui.dim(`권한 모드: ${chalk.bold(permState.mode)} — ${MODE_INFO[permState.mode].desc}\n`));
  let model = ctx.model;
  let session!: AgentSession;
  let tracker!: CostTracker;
  let orgId: string | undefined;

  const newSession = (resume?: string, continueLast?: boolean) => {
    tracker = new CostTracker(resume, cfg.maxSessionCostUsd, cfg.pricing);
    session = new AgentSession({
      apiKey: ctx.apiKey,
      model,
      effort: cfg.effort,
      subagentTools: cfg.subagentTools,
      cwd: cfg.cwd,
      resume,
      continueLast,
      tracker,
      guard,
      permState,
      ask,
      sandbox: cfg.sandbox,
      raw: ctx.raw,
      ...(interactive ? { out: write } : {}),
      onModeChange: () => {announceMode();if(atMainPrompt){rl.setPrompt(mainPrompt());rl.prompt(true);}},
      onBackgroundUpdate: () => { if(atMainPrompt)rl.prompt(true); },
    });
  };
  newSession(ctx.resume, ctx.continueLast);
  if (interactive) disposeUi = startInteractiveUi(interactive);

  let interruptPending: Promise<void> = Promise.resolve();
  const interrupt = () => { interruptPending = interruptPending.then(() => session.interrupt()); return interruptPending; };
  let sigintAt = 0;
  const onSigint = () => {
    if (session.busy) {
      void interrupt();
      return;
    }
    const now = Date.now();
    if (now - sigintAt < 1500) {
      if (interactive) interactive.close(); else rl.close();
      return;
    }
    interactive?.cancelDraft();
    clearInputLine();
    sigintAt = now;
    write(ui.dim('\n(한 번 더 Ctrl+C 를 누르면 종료합니다)\n'));
    rl.prompt();
  };
  rl.on('SIGINT', onSigint);
  if (interactive) {
    interactive.onWorkspaceModeChange = enabled => {
      try {
        setConfigValue('workspaceMode', String(enabled));
      } catch (error) {
        write(ui.warn(`화면 모드 설정 저장 실패: ${(error as Error).message}\n`));
      }
    };
    interactive.modelIds = [ctx.model];
    interactive.currentModel = () => session.activeModel;
    interactive.loadModelIds = async () => (await listModels(apiClient(ctx.apiKey))).map(item => item.id);
    interactive.summaryStatus = () => [
      `모델: ${session.activeModel}`,
      `권한: ${permState.mode}`,
      `남은 예산: ${fmtUsd(tracker.remainingUsd)}${tracker.ledger.usageIncomplete ? ' (추정)' : ''}`,
    ];
    interactive.onInterrupt = onSigint;
    interactive.enterAction = cfg.enterAction;
    interactive.ctrlEnterAction = cfg.ctrlEnterAction;
    interactive.interruptKey = cfg.interruptKey;
    interactive.shiftEnterAction = cfg.shiftEnterAction;
    interactive.slashEnterSubmit = cfg.slashEnterSubmit;
    interactive.onSteer = text => {
      try {
        return session.steer(text);
      } catch (error) {
        write(ui.warn(`Steer 전송 실패: ${(error as Error).message}\n`));
        return false;
      }
    };
    interactive.onInterruptPrompt = () => { if (session.busy) void interrupt(); };
    interactive.onCycle = () => { if (session.busy) return; const i = CYCLE_MODES.indexOf(permState.mode); permState.mode = CYCLE_MODES[(i + 1) % CYCLE_MODES.length]; announceMode(); };
    interactive.busy = () => session.busy;
    interactive.status = () => {
      const runtime = session.runtimeStatus.snapshot();
      return [
      `모델: ${session.activeModel}`, `Effort: ${cfg.effort ?? '기본'}`,
      `권한: ${permState.mode}`, `감독: ${permState.supervised ? '확인됨' : '없음'}`,
      `예산: ${fmtUsd(tracker.sessionCost)} / ${fmtUsd(cfg.maxSessionCostUsd)}`,
      `남은 예산: ${fmtUsd(tracker.remainingUsd)}${tracker.ledger.usageIncomplete ? ' (미집계 있음)' : ''}`,
      `AutoCompact: ${runtime.autocompact.state}`,
      `압축 여유(추정): ${runtime.context?.remaining_tokens?.toLocaleString() ?? '미확인'}`,
      `Cache: ${runtime.cache.reuse_estimate} (추정)`,
      `TTL 예상: ${runtime.cache.estimated_ttl_remaining_seconds ?? '?'}s`,
      `백그라운드 작업: ${session.listTasks().filter(task => task.status === 'running').length}개 실행 중`,
      ...session.todos.lines(),
      `API 키: ${maskKey(ctx.apiKey)}`, `SDK 인증: ${session.apiKeySource ?? '-'}`,
      `조직: ${orgId ?? '미확인'}`, `세션: ${session.sessionId ?? '-'}`,
      `작업 폴더: ${cfg.cwd}`, `허용 폴더: ${guard.roots.slice(1).join(', ') || '없음'}`,
      `샌드박스: ${cfg.sandbox ? '요청됨' : '비활성'}`, `SDK: ${session.sdkVersion ?? '-'}`,
      ...session.runtimeStatus.lines(),
    ]; };
  }
  // Shift+Tab: 입력 대기 중일 때 권한 모드 순환
  if (process.stdin.isTTY && !interactive) {
    input.on('keypress', (_s: string, key: { name?: string; shift?: boolean } | undefined) => {
      if (!atMainPrompt || session.busy || key?.name !== 'tab' || !key.shift) return;
      const i = CYCLE_MODES.indexOf(permState.mode);
      permState.mode = CYCLE_MODES[(i + 1) % CYCLE_MODES.length];
      write('\r\x1b[K');
      announceMode();
      rl.setPrompt(mainPrompt());
      rl.prompt(true);
    });
  }
  // 비 TTY(파이프) 입력에서는 readline 이 SIGINT 를 받지 않으므로 프로세스 시그널로 처리
  if (!process.stdin.isTTY) process.on('SIGINT', onSigint);

  write(
    `${chalk.bold.cyan('CVP CLI')}\n` +
      `Model: ${chalk.bold(model)}\n` +
      `Authentication: API Key ${ui.dim(`(${maskKey(ctx.apiKey)})`)}\n` +
      `Workspace: ${cfg.cwd}\n` +
      `Budget: ${fmtUsd(cfg.maxSessionCostUsd)} / session ${ui.dim('(CLI 자체 추정 한도 — 실제 청구 차단을 보장하지 않음)')}\n` +
      `Permission mode: ${chalk.bold(permState.mode)} ${ui.dim(`— ${MODE_INFO[permState.mode].desc}`)}\n` +
      (ctx.resume ? `Resume: ${ctx.resume}\n` : '') +
      ui.dim(`/help · Enter=${cfg.enterAction} / Ctrl+Enter=${cfg.ctrlEnterAction} / Shift+Enter=${cfg.shiftEnterAction} (승인 질문은 Enter)\n`),
  );

  const listRecent = async () => {
    const sessions = await listSessions({ dir: cfg.cwd, limit: 20 });
    return sessions;
  };

  const commands: Record<string, (arg: string) => Promise<boolean | void>> = {
    async context() { await session.refreshRuntimeStatus();write(session.runtimeStatus.lines().join('\n')+'\n'); },
    async autocompact() { await commands.context(''); },
    async cache() { write(session.runtimeStatus.lines()[1]+'\n'); },
    async compact(arg) {
      if(!session.sessionId){write('먼저 대화를 시작하거나 세션을 재개한 뒤 /compact를 사용하세요.\n');return;}
      const before=session.runtimeStatus.snapshot().autocompact.count;
      const outcome=await session.send(`/compact${arg?' '+arg:''}`);
      if(outcome.error)write(ui.err(outcome.error+'\n'));
      else if(session.runtimeStatus.snapshot().autocompact.count===before && outcome.result?.subtype==='success')write(outcome.result.result+'\n');
      write(session.runtimeStatus.lines().join('\n')+`\n압축 요청 예상 비용 $${outcome.turnCostUsd.toFixed(5)}\n`);
    },
    async todos() { write(session.todos.lines().join('\n')+'\n'); },
    async tasks() {const tasks=session.listTasks();write(tasks.length?JSON.stringify(tasks,null,2)+'\n':'등록된 백그라운드 작업이 없습니다.\n');},
    async task(id) {if(!id.trim())throw new Error('사용법: /task <id>');write(JSON.stringify(await session.taskStatus(id.trim()),null,2)+'\n');},
    async stop(id) {if(!id.trim())throw new Error('사용법: /stop <id>');write(JSON.stringify(await session.stopTask(id.trim()),null,2)+'\n');},
    async help() {
      write(HELP + `현재 입력 설정: Enter=${cfg.enterAction}, Ctrl+Enter=${cfg.ctrlEnterAction}, Shift+Enter=${cfg.shiftEnterAction}, slashEnterSubmit=${cfg.slashEnterSubmit}\n`);
    },
    async exit() {
      return true;
    },
    async quit() {
      return true;
    },
    async status() {
      if (interactive) { interactive.toggleStatusPanel(); return; }
      const base = process.env.ANTHROPIC_BASE_URL;
      write(
        [
          chalk.bold('상태'),
          `  인증 방식      : Console API 키 (ANTHROPIC_API_KEY ${maskKey(ctx.apiKey)})`,
          `  SDK 인증 출처  : ${session.apiKeySource ?? '(첫 요청 후 확인)'}`,
          `  조직 ID        : ${orgId ?? '(미확인 — /model 검증 또는 cvp verify 실행 시 확인)'}${cfg.expectedOrgId ? ` / 기대값 ${cfg.expectedOrgId}` : ''}`,
          `  모델           : ${session.activeModel}`,
          `  권한 모드      : ${permState.mode} (${MODE_INFO[permState.mode].desc})`,
          `  감독 확인      : ${permState.supervised ? '사용자 확인됨 (실제 감독 감지 없음)' : '없음'}`,
          `  세션 ID        : ${session.sessionId ?? '(첫 요청 후 생성)'}`,
          `  작업 디렉터리  : ${cfg.cwd}`,
          `  허용 디렉터리  : ${guard.roots.slice(1).join(', ') || '(없음)'}`,
          `  샌드박스       : ${cfg.sandbox ? 'SDK 샌드박스 요청됨(플랫폼 미지원 시 비활성)' : '비활성(애플리케이션 수준 경로 제한만 적용)'}`,
          `  Agent 런타임   : ${session.sdkVersion ?? '-'}`,
          ...session.runtimeStatus.lines().map(line=>`  ${line}`),
          `  예산           : ${fmtUsd(tracker.sessionCost)} / ${fmtUsd(cfg.maxSessionCostUsd)} · 남은 예산 ${fmtUsd(tracker.remainingUsd)}`,
          tracker.ledger.usageIncomplete ? ui.warn('  ※ 중단된 실행의 미집계 비용이 있어 남은 예산이 실제보다 크게 표시될 수 있습니다.') : '',
          base ? ui.warn(`  ⚠ ANTHROPIC_BASE_URL=${base} (공식 API가 아닌 엔드포인트)`) : '',
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      );
    },
    async usage() {
      const t = tracker.totals();
      const l = tracker.ledger;
      const rows = Object.entries(l.byModel)
        .map(
          ([m, u]) =>
            `  ${m.padEnd(28)} in ${String(u.inputTokens).padStart(8)}  out ${String(u.outputTokens).padStart(8)}  cache r/w ${u.cacheReadTokens}/${u.cacheWriteTokens}  ${fmtUsd(u.costUsd)}${u.costBasis === 'unknown' ? ui.warn(' (가격표 없음)') : ''}`,
        )
        .join('\n');
      const reqs = l.requests
        .slice(-10)
        .map((r) => `  ${r.at.slice(11, 19)} ${r.model}  in ${r.inputTokens} / out ${r.outputTokens} / cache r ${r.cacheReadTokens} w ${r.cacheWriteTokens}`)
        .join('\n');
      write(
        [
          chalk.bold('사용량 (이 세션)'),
          ...session.runtimeStatus.lines(),
          `  턴 수: ${l.turns}   입력 ${t.input} / 출력 ${t.output} / 캐시 읽기 ${t.cacheRead} / 캐시 쓰기 ${t.cacheWrite} 토큰`,
          `  예상 비용: ${fmtUsd(tracker.sessionCost)}  (한도 ${fmtUsd(cfg.maxSessionCostUsd)}, 남은 한도 ${fmtUsd(tracker.remainingUsd)})`,
          l.usageIncomplete ? ui.warn('  ※ 중단된 실행의 미집계 비용이 있어 남은 예산이 실제보다 크게 표시될 수 있습니다.') : '',
          rows ? chalk.bold('모델별') + '\n' + rows : '',
          reqs ? chalk.bold('최근 요청') + '\n' + reqs : '',
          ui.dim('  ※ 비용은 SDK 가격표 기반 추정치입니다. 실제 청구액·크레딧 잔액은 Console에서 확인하세요(잔액 조회 API 없음).'),
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      );
    },
    async clear() {
      await session.close();
      newSession();
      write(ui.ok('대화를 초기화했습니다. 다음 입력부터 새 세션이 시작됩니다.\n'));
    },
    async sessions() {
      const list = await listRecent();
      if (!list.length) {
        write('저장된 세션이 없습니다.\n');
        return;
      }
      list.forEach((s, i) => {
        const cost = loadLedger(s.sessionId)?.costUsd;
        write(
          `  ${String(i + 1).padStart(2)}. ${s.sessionId}  ${new Date(s.lastModified).toLocaleString()}  ${cost !== undefined ? fmtUsd(cost) : ''}\n      ${ui.dim((s.customTitle ?? s.summary ?? '').slice(0, 80))}\n`,
        );
      });
      write(ui.dim('  /resume <번호|ID> 로 재개\n'));
    },
    async resume(arg) {
      let id = arg.trim();
      if (!id) {
        await commands.sessions('');
        id = ((await ask('재개할 번호 또는 ID (빈 입력=취소): ')) ?? '').trim();
        if (!id) return;
      }
      if (/^\d+$/.test(id)) {
        const list = await listRecent();
        const s = list[Number(id) - 1];
        if (!s) {
          write(ui.err('해당 번호의 세션이 없습니다.\n'));
          return;
        }
        id = s.sessionId;
      }
      await session.close();
      newSession(id);
      write(ui.ok(`세션 ${id} 를 재개합니다. 누적 예상 비용 ${fmtUsd(tracker.sessionCost)}\n`));
    },
    async models() {
      const ms = await listModels(apiClient(ctx.apiKey));
      if (interactive) interactive.modelIds = [...new Set([session.activeModel, ...ms.map(item => item.id)])];
      write(chalk.bold('조회 가능한 모델 (권한 미검증)\n'));
      for (const m of ms) write(`  ${m.id === model ? '*' : ' '} ${m.id.padEnd(30)} ${ui.dim(m.displayName)}\n`);
      write(ui.dim('  실제 호출 권한은 /model <id> 또는 cvp models --verify 로 확인하세요.\n'));
    },
    async mode(arg) {
      const v = arg.trim();
      if (!v) {
        write(chalk.bold('권한 모드\n'));
        for (const m of PERMISSION_MODES) {
          write(`  ${m === permState.mode ? chalk.green('*') : ' '} ${m.padEnd(12)} ${ui.dim(MODE_INFO[m].desc)}\n`);
        }
        write(ui.dim('  변경: /mode <모드>  ·  Shift+Tab 으로 default/acceptEdits/plan 순환\n'));
        return;
      }
      let next: CvpPermissionMode;
      try {
        next = parsePermissionMode(v);
      } catch (err) {
        write(ui.err(`${(err as Error).message}\n`));
        return;
      }
      if (next === 'fullbypass' && permState.mode !== 'fullbypass') {
        write(ui.warn('fullbypass: 위험 명령과 작업 폴더 밖 파일 접근도 자동 승인합니다. 실행 내내 감독해야 합니다. 실제 감독 여부는 감지하지 않습니다.\n'));
        const confirmation = ((await ask('24시간 감독 중임을 확인하려면 SUPERVISED 입력: ')) ?? '').trim();
        if (confirmation !== 'SUPERVISED') { write('취소했습니다.\n'); return; }
        permState.supervised = true;
      }
      if (next === 'bypass' && permState.mode !== 'bypass') {
        write(
          ui.warn('⚠ bypass 모드에서는 작업 디렉터리 안의 파일 수정과 셸 명령이 확인 없이 실행됩니다.\n') +
            ui.dim('  위험 명령(rm -rf, git push --force 등)은 계속 확인을 받으며, 작업 디렉터리 밖 파일 도구 접근은 계속 차단됩니다.\n'),
        );
        const a = ((await ask('  전환할까요? [y/N] ')) ?? '').trim().toLowerCase();
        if (a !== 'y' && a !== 'yes') {
          write('취소했습니다.\n');
          return;
        }
      }
      permState.mode = next;
      announceMode();
    },
    async permissions(arg) {
      return commands.mode(arg);
    },
    async model(arg) {
      const id = parseModelInput(arg);
      if (!id) {
        write(`현재 모델: ${chalk.bold(session.activeModel)}\n${ui.dim('변경: /model <model-id> 또는 /model Provider: claude Model-Group: opus Model: 5.5  (목록: /models)')}\n`);
        return;
      }
      if (session.busy) return;
      write(ui.dim(`${id} 접근 권한을 실제 API 호출로 확인하는 중…(소량 과금)\n`));
      const r = await probeModel(apiClient(ctx.apiKey), id);
      if (r.organizationId) orgId = r.organizationId;
      if (!r.ok) {
        write(
          ui.err(`✖ ${id} 사용 불가 [${r.error!.category}${r.error!.status ? ` ${r.error!.status}` : ''}]: ${r.error!.message}\n`) +
            ui.dim(`  → ${r.error!.hint}\n  모델은 변경되지 않았습니다(현재: ${session.activeModel}).\n`),
        );
        return;
      }
      await session.setModel(id);
      model = id;
      if (interactive) {
        if (!interactive.modelIds.includes(id)) interactive.modelIds.push(id);
        interactive.recentModels = [id, ...interactive.recentModels.filter(item => item !== id)].slice(0, 10);
      }
      write(ui.ok(`✔ 모델을 ${id} 로 변경했습니다. (영구 저장: cvp config set model ${id})\n`));
    },
  };

  try {
    for (;;) {
      await interruptPending;
      if (interactive?.closed) break;
      atMainPrompt = true;
      let text = await readLine(mainPrompt());
      atMainPrompt = false;
      if (text === null) break;
      while (!interactive && text.endsWith('\\')) {
        const more = await readLine(chalk.dim('… '));
        if (more === null) break;
        text = text.slice(0, -1) + '\n' + more;
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('/')) {
        const [name, ...rest] = trimmed.slice(1).split(/\s+/);
        const fn = commands[name.toLowerCase()];
        if (!fn) {
          write(ui.err(`알 수 없는 명령어: /${name}  (/help)\n`));
          continue;
        }
        try {
          if (await fn(rest.join(' '))) break;
        } catch (err) {
          write(ui.err(`명령 실패: ${err instanceof Error ? err.message : String(err)}\n`));
        }
        continue;
      }
      try {
        await interruptPending;
        if (interactive?.closed) break;
        const outcome = await session.send(trimmed);
        if (outcome.error) write(ui.err(`\n✖ ${outcome.error}\n`));
        const r = outcome.result;
        const last = tracker.ledger.requests.at(-1);
        write(
          ui.dim(
            `\n─ 이번 턴 ${fmtUsd(outcome.turnCostUsd)}` +
              (last ? ` · 마지막 요청 in ${last.inputTokens}/out ${last.outputTokens} 토큰` : '') +
              ` · 세션 누적 ${fmtUsd(tracker.sessionCost)} / ${fmtUsd(cfg.maxSessionCostUsd)} · 남은 예산 ${fmtUsd(tracker.remainingUsd)}${tracker.ledger.usageIncomplete ? ' (미집계 비용 있음)' : ''}` +
              (r ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : '') +
              '\n' + session.runtimeStatus.lines().join('\n') + '\n',
          ),
        );
        if (tracker.sessionCost >= cfg.maxSessionCostUsd) {
          write(ui.warn('⚠ 세션 예산 한도에 도달했습니다. 추가 요청은 차단됩니다(/clear 로 새 세션 시작 또는 한도 조정).\n'));
        }
        if (session.dead) {
          write(ui.err(`세션이 종료되었습니다: ${session.dead}\n/clear 로 새 세션을 시작할 수 있습니다.\n`));
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) write(ui.err(`✖ ${err.message}\n`));
        else write(ui.err(`✖ ${err instanceof Error ? err.message : String(err)}\n`));
      }
    }
  } finally {
    try { await session.close(); }
    finally {
      rl.close();
      disposeUi?.();
      if (!process.stdin.isTTY) process.off('SIGINT', onSigint);
    }
  }
  process.stdout.write(ui.dim(`\n종료합니다.${session.sessionId ? ` 세션 ID: ${session.sessionId} (cvp --resume ${session.sessionId})` : ''}\n`));
}
