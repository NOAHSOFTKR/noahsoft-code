#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession } from './agent.js';
import { checkApiKey } from './auth.js';
import {
  agentConfigDir,
  configPath,
  loadDotEnv,
  loadFileConfig,
  resolveConfig,
  setConfigValue,
  unsetConfigValue,
  type ResolvedConfig,
} from './config.js';
import { BudgetExceededError, CostTracker, loadLedger } from './cost.js';
import { apiClient, checkKeyOnline, listModels, probeModel, retrieveModel } from './models.js';
import { newPermissionState, PathGuard } from './permissions.js';
import { ui } from './render.js';
import { runRepl } from './repl.js';

const VERSION = '0.1.0';

const USAGE = `
${chalk.bold('CVP CLI')} ${VERSION} — Claude Agent SDK 기반 터미널 에이전트 (Console API 키 전용)

${chalk.bold('사용법')}
  cvp                              대화형 모드
  cvp -p "프롬프트"                단일 프롬프트 실행 후 종료
  cvp models [--verify]            조회 가능한 모델 목록 (--verify: 실제 호출로 권한 검증)
  cvp verify [model-id]            API 키·조직·모델 접근 검증
  cvp sessions                     저장된 세션 목록
  cvp config set <key> <value>     설정 저장 (model, maxSessionCostUsd, permissionMode, sandbox, additionalDirectories, expectedOrgId)
  cvp config get [key] | unset <key> | path

${chalk.bold('옵션')}
  -m, --model <id>       사용할 모델 (CVP_MODEL / config 보다 우선)
  -r, --resume <id>      세션 재개
  -c, --continue         이 디렉터리의 가장 최근 세션 이어가기
  -b, --budget <usd>     세션 예상 비용 한도 (CVP_MAX_SESSION_COST_USD 보다 우선)
      --permission-mode <m> 권한 모드: default | acceptEdits | plan | bypass (CVP_PERMISSION_MODE)
      --cwd <dir>        작업 디렉터리
      --raw              Markdown 렌더링 없이 원문 스트리밍
      --json             (-p) 결과를 JSON 으로 출력
  -y, --yes              (models --verify) 확인 질문 생략
  -v, --version / -h, --help

${chalk.bold('환경변수')}
  ANTHROPIC_API_KEY  CVP_MODEL  CVP_MAX_SESSION_COST_USD  CVP_PERMISSION_MODE  CVP_EXPECTED_ORG_ID  CVP_HOME  CVP_DEBUG
`;

function fail(msg: string, code = 1): never {
  process.stderr.write(ui.err(`✖ ${msg}\n`));
  process.exit(code);
}

function requireKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  const c = checkApiKey(key);
  if (!c.ok) fail(c.message, 3);
  if (c.kind === 'unknown-format') process.stderr.write(ui.warn(`⚠ ${c.message}\n`));
  return key!.trim();
}

function requireModel(cfg: ResolvedConfig): string {
  if (!cfg.model) {
    fail(
      '사용할 모델이 설정되지 않았습니다. 모델 ID는 하드코딩하지 않습니다.\n' +
        '  1) cvp models 로 조회 가능한 모델 확인\n' +
        '  2) cvp verify <model-id> 로 실제 접근 권한 확인\n' +
        '  3) CVP_MODEL 환경변수, --model, 또는 cvp config set model <id> 로 지정',
      2,
    );
  }
  return cfg.model;
}

async function cmdModels(verify: boolean, yes: boolean, cfg: ResolvedConfig): Promise<void> {
  const client = apiClient(requireKey());
  let models;
  try {
    models = await listModels(client);
  } catch (err) {
    const { classifyApiError } = await import('./errors.js');
    const e = classifyApiError(err);
    fail(`모델 목록 조회 실패 [${e.category}]: ${e.message}\n  → ${e.hint}`);
  }
  process.stdout.write(chalk.bold(`조회 가능한 모델 ${models.length}개 (GET /v1/models)\n`));
  process.stdout.write(ui.dim('  ※ 목록에 보인다고 호출 권한이 있는 것은 아닙니다. CVP 승인이 모든 모델 접근을 보장하지 않습니다.\n'));
  if (!verify) {
    for (const m of models) {
      process.stdout.write(`  ${m.id === cfg.model ? chalk.green('*') : ' '} ${m.id.padEnd(30)} ${ui.dim(m.displayName)}\n`);
    }
    process.stdout.write(ui.dim('\n  권한 검증: cvp models --verify  또는  cvp verify <model-id>\n'));
    return;
  }
  if (!yes && process.stdin.isTTY) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`${models.length}개 모델에 각각 실제 요청(최대 64 출력 토큰)을 보냅니다. 소량 과금됩니다. 계속할까요? [y/N] `);
    rl.close();
    if (a.trim().toLowerCase() !== 'y') return;
  }
  for (const m of models) {
    const r = await probeModel(client, m.id);
    const status = r.ok ? ui.ok('✔ 사용 가능') : ui.err(`✖ ${r.error!.category}${r.error!.status ? ` (${r.error!.status})` : ''}`);
    process.stdout.write(`  ${m.id.padEnd(30)} ${status}${r.ok ? '' : ui.dim(`  ${r.error!.message.slice(0, 100)}`)}\n`);
  }
}

async function cmdVerify(modelArg: string | undefined, cfg: ResolvedConfig): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  const c = checkApiKey(key);
  process.stdout.write(chalk.bold('1) API 키 형식\n'));
  process.stdout.write(`   ${c.ok ? ui.ok('✔') : ui.err('✖')} ${c.masked ?? ''} ${c.message}\n`);
  if (!c.ok) process.exit(3);
  const client = apiClient(key!.trim());

  process.stdout.write(chalk.bold('2) 키 유효성 / 조직 (GET /v1/models, 과금 없음)\n'));
  const online = await checkKeyOnline(client);
  if (!online.ok) {
    process.stdout.write(`   ${ui.err('✖')} [${online.error.category}] ${online.error.message}\n   → ${online.error.hint}\n`);
    process.exit(3);
  }
  process.stdout.write(`   ${ui.ok('✔')} 유효한 키. 조회 가능 모델 ${online.modelCount}개\n`);
  const org = online.organizationId;
  process.stdout.write(`   조직 ID: ${org ?? ui.warn('(응답 헤더에 없음)')}\n`);

  process.stdout.write(chalk.bold('3) CVP 조직 확인\n'));
  if (cfg.expectedOrgId) {
    if (org && org === cfg.expectedOrgId) process.stdout.write(`   ${ui.ok('✔')} 기대 조직 ID(CVP_EXPECTED_ORG_ID)와 일치\n`);
    else {
      process.stdout.write(`   ${ui.err('✖')} 기대 조직 ID ${cfg.expectedOrgId} 와 다릅니다(${org ?? '알 수 없음'}). CVP 조직의 키가 아닐 수 있습니다.\n`);
      process.exitCode = 4;
    }
  } else {
    process.stdout.write(
      `   ${ui.warn('!')} CVP 승인 여부를 직접 조회하는 공식 API는 없습니다. Console에서 CVP 조직 ID를 확인해\n` +
        `     CVP_EXPECTED_ORG_ID 로 지정하면 위 조직 ID와 대조합니다. 아래 모델 접근 검증이 실질적인 확인입니다.\n`,
    );
  }

  const model = modelArg ?? cfg.model;
  process.stdout.write(chalk.bold('4) 모델 접근 (실제 Messages API 호출, 소량 과금)\n'));
  if (!model) {
    process.stdout.write(`   ${ui.warn('!')} 검증할 모델이 없습니다. cvp verify <model-id> 또는 CVP_MODEL 지정\n`);
    return;
  }
  const listed = await retrieveModel(client, model);
  process.stdout.write(
    `   목록 조회(GET /v1/models/${model}): ${listed.ok ? ui.ok('보임') : ui.warn(`보이지 않음 [${listed.error.category}]`)}\n`,
  );
  const r = await probeModel(client, model);
  if (r.ok) {
    process.stdout.write(
      `   ${ui.ok('✔')} ${model} 호출 성공 (stop_reason=${r.stopReason}, in ${r.inputTokens}/out ${r.outputTokens} 토큰${r.requestId ? `, request-id ${r.requestId}` : ''})\n`,
    );
  } else {
    process.stdout.write(
      `   ${ui.err('✖')} ${model} 사용 불가 [${r.error!.category}${r.error!.status ? ` ${r.error!.status}` : ''}]: ${r.error!.message}\n   → ${r.error!.hint}\n`,
    );
    process.exitCode = 5;
  }
}

async function cmdSessions(cfg: ResolvedConfig): Promise<void> {
  const list = await listSessions({ dir: cfg.cwd, limit: 30 });
  if (!list.length) {
    process.stdout.write('이 디렉터리에 저장된 세션이 없습니다.\n');
    return;
  }
  for (const s of list) {
    const cost = loadLedger(s.sessionId)?.costUsd;
    process.stdout.write(
      `${s.sessionId}  ${new Date(s.lastModified).toLocaleString()}  ${cost !== undefined ? `$${cost.toFixed(4)}` : ''}\n  ${ui.dim((s.customTitle ?? s.summary ?? '').slice(0, 90))}\n`,
    );
  }
}

function cmdConfig(args: string[]): void {
  const [sub, key, ...rest] = args;
  switch (sub) {
    case 'set':
      if (!key || !rest.length) fail('사용법: cvp config set <key> <value>');
      try {
        const r = setConfigValue(key, rest.join(' '));
        process.stdout.write(ui.ok(`✔ ${r.key} = ${JSON.stringify(r.value)} (${configPath()})\n`));
        if (r.key === 'model') process.stdout.write(ui.dim(`  접근 권한 확인: cvp verify ${r.value}\n`));
      } catch (err) {
        fail((err as Error).message);
      }
      return;
    case 'unset':
      if (!key) fail('사용법: cvp config unset <key>');
      process.stdout.write(ui.ok(`✔ ${unsetConfigValue(key)} 삭제\n`));
      return;
    case 'get':
    case 'list':
    case undefined: {
      const cfg = loadFileConfig() as Record<string, unknown>;
      process.stdout.write(JSON.stringify(key ? cfg[key] ?? null : cfg, null, 2) + '\n');
      return;
    }
    case 'path':
      process.stdout.write(configPath() + '\n');
      return;
    default:
      fail(`알 수 없는 config 하위 명령: ${sub}`);
  }
}

async function cmdPrint(prompt: string, cfg: ResolvedConfig, opts: { resume?: string; continueLast?: boolean; raw: boolean; json: boolean }) {
  const apiKey = requireKey();
  const model = requireModel(cfg);
  const tracker = new CostTracker(opts.resume, cfg.maxSessionCostUsd, cfg.pricing);
  let ask: ((q: string) => Promise<string>) | undefined;
  let rl: import('node:readline/promises').Interface | undefined;
  if (process.stdin.isTTY) {
    rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    ask = (q) => rl!.question(q);
  }
  const session = new AgentSession({
    apiKey,
    model,
    cwd: cfg.cwd,
    resume: opts.resume,
    continueLast: opts.continueLast,
    tracker,
    guard: new PathGuard(cfg.cwd, cfg.additionalDirectories),
    permState: newPermissionState(cfg.permissionMode),
    ask,
    sandbox: cfg.sandbox,
    raw: opts.raw || !process.stdout.isTTY,
    quiet: opts.json,
    out: opts.json ? () => undefined : undefined,
  });
  const onSig = () => void session.interrupt();
  process.on('SIGINT', onSig);
  rl?.on('SIGINT', onSig);
  let code = 0;
  try {
    const o = await session.send(prompt);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            session_id: session.sessionId,
            model: session.activeModel,
            result: o.result?.subtype === 'success' ? o.result.result : undefined,
            error: o.error,
            turn_cost_usd: o.turnCostUsd,
            session_cost_usd: tracker.sessionCost,
            usage: tracker.ledger.byModel,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      if (o.error) process.stderr.write(ui.err(`\n✖ ${o.error}\n`));
      process.stderr.write(
        ui.dim(`\n─ 예상 비용 $${o.turnCostUsd.toFixed(5)} · 세션 ${session.sessionId ?? '-'} (cvp --resume 로 이어가기)\n`),
      );
    }
    if (o.error) code = o.result?.subtype === 'error_max_budget_usd' ? 6 : 1;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      process.stderr.write(ui.err(`✖ ${err.message}\n`));
      code = 6;
    } else throw err;
  } finally {
    process.off('SIGINT', onSig);
    rl?.close();
    await session.close();
  }
  process.exit(code);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      resume: { type: 'string', short: 'r' },
      continue: { type: 'boolean', short: 'c' },
      budget: { type: 'string', short: 'b' },
      'permission-mode': { type: 'string' },
      cwd: { type: 'string' },
      raw: { type: 'boolean' },
      json: { type: 'boolean' },
      verify: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void process.stdout.write(USAGE);
  if (values.version) return void process.stdout.write(`cvp ${VERSION}\n`);

  if (values.cwd) {
    if (!fs.existsSync(values.cwd)) fail(`작업 디렉터리가 없습니다: ${values.cwd}`);
    process.chdir(values.cwd);
  }
  loadDotEnv(process.cwd());
  // Agent SDK의 세션 함수(listSessions 등)가 CLI 전용 설정 디렉터리를 보도록 설정
  process.env.CLAUDE_CONFIG_DIR = agentConfigDir();
  fs.mkdirSync(agentConfigDir(), { recursive: true });

  let budget: number | undefined;
  if (values.budget !== undefined) {
    budget = Number(values.budget);
    if (!Number.isFinite(budget) || budget < 0) fail(`--budget 값이 올바르지 않습니다: ${values.budget}`);
  }
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig({ model: values.model, budget, permissionMode: values['permission-mode'] });
  } catch (err) {
    fail((err as Error).message);
  }

  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case 'models':
      return cmdModels(!!values.verify, !!values.yes, cfg);
    case 'verify':
      return cmdVerify(rest[0], cfg);
    case 'sessions':
      return cmdSessions(cfg);
    case 'config':
      return cmdConfig(rest);
    case undefined:
      break;
    default:
      if (values.print === undefined) fail(`알 수 없는 명령: ${cmd}\n${USAGE}`);
  }

  if (values.print !== undefined) {
    let prompt = values.print;
    if (!prompt.trim() && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8');
    if (!prompt.trim()) fail('프롬프트가 비어 있습니다.');
    return cmdPrint(prompt, cfg, { resume: values.resume, continueLast: values.continue, raw: !!values.raw, json: !!values.json });
  }

  const apiKey = requireKey();
  const model = requireModel(cfg);
  await runRepl({ apiKey, cfg, model, resume: values.resume, continueLast: values.continue, raw: !!values.raw });
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(ui.err(`✖ ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`));
  process.exit(1);
});

