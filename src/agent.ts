import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import { AgentTools, AGENT_TOOL_NAMES } from './agent-tools.js';
import { subagentDefinitions } from './subagents.js';
import { buildAgentEnv } from './auth.js';
import { CostTracker, type SdkModelUsage } from './cost.js';
import { classifyAgentError } from './errors.js';
import { enabledTools, makeCanUseTool, pathGuardHook, PathGuard, PermissionQueue, type Asker, type CvpPermissionMode, type PermissionState } from './permissions.js';
import { MarkdownStream, Spinner, ui } from './render.js';

/** 스트리밍 입력용 비동기 큐 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(m: SDKUserMessage): void {
    if (this.closed) throw new Error('세션 입력이 이미 닫혔습니다.');
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface AgentSessionOptions {
  apiKey: string;
  model: string;
  effort?: Options['effort'];
  subagentTools?: boolean;
  cwd: string;
  resume?: string;
  continueLast?: boolean;
  tracker: CostTracker;
  guard: PathGuard;
  permState: PermissionState;
  ask?: Asker;
  sandbox: boolean;
  raw: boolean;
  out?: (s: string) => void;
  /** 결과 출력 없이 조용히(-p --json) */
  quiet?: boolean;
  onModeChange?: (mode: CvpPermissionMode) => void;
}

export interface TurnOutcome {
  result?: SDKResultMessage;
  turnCostUsd: number;
  error?: string;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  let s = '';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      s = pick('command');
      break;
    case 'Agent':
    case 'Task':
      s = `${pick('subagent_type')}: ${pick('description')}`;
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
      s = pick('file_path');
      break;
    case 'Glob':
      s = pick('pattern');
      break;
    case 'Grep':
      s = `${pick('pattern')}${input.path ? ` in ${pick('path')}` : ''}`;
      break;
    default:
      s = JSON.stringify(input);
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/**
 * Claude Agent SDK query() 를 스트리밍 입력 모드로 감싼 다중 턴 세션.
 */
export class AgentSession {
  private q: Query | undefined;
  private agentTools?: AgentTools;
  private permissionQueue = new PermissionQueue();
  private turnStartCost = 0;
  private input = new InputQueue();
  private pending: { resolve: (o: TurnOutcome) => void } | undefined;
  private loop: Promise<void> | undefined;
  private spinner = new Spinner();
  private md: MarkdownStream;
  private out: (s: string) => void;
  private toolNames = new Map<string, string>();
  private printedHeader = false;
  sessionId: string | undefined;
  apiKeySource: string | undefined;
  activeModel: string;
  sdkVersion: string | undefined;
  tools: string[] = [];
  dead: string | undefined;
  busy = false;
  lastText = '';

  constructor(private o: AgentSessionOptions) {
    this.out = o.out ?? ((s) => process.stdout.write(s));
    this.md = new MarkdownStream(this.out, o.raw);
    this.activeModel = o.model;
    this.sessionId = o.resume;
  }

  private buildOptions(): Options {
    const { o } = this;
    const remaining = Math.max(0, o.tracker.limitUsd - o.tracker.sessionCost);
    if (o.subagentTools) this.agentTools ??= new AgentTools({ apiKey: o.apiKey, cwd: o.cwd, guard: o.guard, model: () => this.activeModel, effort: o.effort, budgetUsd: remaining / 2, tracker: o.tracker,
      permState: o.permState, queue: this.permissionQueue, ask: o.ask, sandbox: o.sandbox,
      beforePrompt: () => { this.spinner.stop(); this.md.flush(); }, write: this.out,
    });
    return {
      model: o.model,
      effort: o.effort,
      cwd: o.cwd,
      env: { ...buildAgentEnv(o.apiKey), ...(o.subagentTools ? { ENABLE_TOOL_SEARCH: 'false' } : {}) },
      resume: o.resume,
      continue: o.continueLast && !o.resume ? true : undefined,
      tools: o.subagentTools ? enabledTools().filter((name) => name !== 'Agent') : enabledTools(),
      ...(this.agentTools ? { mcpServers: { cvp_agents: this.agentTools.server() }, allowedTools: AGENT_TOOL_NAMES } : {}),
      agents: o.subagentTools ? undefined : subagentDefinitions(o.effort),
      disallowedTools: ['Agent(fork)'],
      // 파일 시스템 설정(~/.claude/settings.json, 프로젝트 .claude/)을 읽지 않음: 권한 규칙·훅·apiKeyHelper 격리
      settingSources: [],
      permissionMode: 'default',
      canUseTool: makeCanUseTool({
        guard: o.guard,
        state: o.permState,
        queue: this.permissionQueue,
        ask: o.ask,
        beforePrompt: () => {
          this.spinner.stop();
          this.md.flush();
        },
        write: this.out,
        onModeChange: o.onModeChange,
      }),
      hooks: { PreToolUse: [{ hooks: [pathGuardHook(o.guard, o.permState)], onFailure: 'block' }] },
      additionalDirectories: o.guard.roots.slice(1),
      includePartialMessages: true,
      // SDK 자체 예산 한도(이번 query() 시작 이후 지출 기준) — CLI 사전 차단과 이중으로 적용
      maxBudgetUsd: remaining > 0 ? remaining / (o.subagentTools ? 2 : 1) : 0.000001,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          (o.subagentTools ? 'Use the cvp_agents spawn_agent, send_message, and wait_agent tools for delegation. Spawn returns an ID; wait for completion before using the result or sending follow-up work. Workers may edit and execute commands under their assigned permission_mode, which cannot exceed your current mode. They cannot delegate. Assign non-overlapping files to concurrent workers. ' : '') +
          'You are running inside "CVP CLI", a terminal tool. Work only inside the current working directory unless the user explicitly asks otherwise. Answer in the user\'s language. Use explorer for code research and reviewer for independent review when useful or requested. Wait for their report before answering. Subagents must obey the assigned permission policy. Avoid concurrent edits to the same files.',
      },
      sandbox: o.sandbox ? { enabled: true, failIfUnavailable: false } : undefined,
      stderr: process.env.CVP_DEBUG ? (d) => process.stderr.write(chalk.dim(d)) : undefined,
    };
  }

  start(): void {
    this.q = query({ prompt: this.input, options: this.buildOptions() });
    this.loop = this.consume().catch((err) => {
      this.dead = err instanceof Error ? err.message : String(err);
      this.finishTurn({ turnCostUsd: 0, error: this.dead });
    });
  }

  private finishTurn(o: TurnOutcome): void {
    this.spinner.stop();
    this.md.flush();
    this.busy = false;
    const p = this.pending;
    this.pending = undefined;
    p?.resolve(o);
  }

  /** 프롬프트 전송 후 턴이 끝날 때까지 대기 */
  async send(text: string): Promise<TurnOutcome> {
    if (this.dead) throw new Error(`세션이 종료되었습니다: ${this.dead}`);
    this.o.tracker.assertWithinBudget();
    if (!this.q) this.start();
    this.turnStartCost = this.o.tracker.sessionCost;
    this.busy = true;
    this.lastText = '';
    const done = new Promise<TurnOutcome>((resolve) => (this.pending = { resolve }));
    this.spinner.start('응답 대기 중… (Ctrl+C 중단)');
    // plan 모드에서는 모델이 실행 대신 계획을 세우도록 짧은 안내를 덧붙인다
    const content =
      this.o.permState.mode === 'plan'
        ? `${text}

[CVP CLI 안내: 현재 plan(읽기 전용) 모드입니다. 파일을 수정하거나 명령을 실행하지 말고, 필요한 파일을 읽은 뒤 구체적인 변경 계획을 제시하세요.]`
        : text;
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    return done;
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.busy) return;
    this.spinner.stop();
    this.md.flush();
    this.out(ui.warn('\n⏹ 실행 중단 요청됨…\n'));
    this.interrupted = true;
    try {
      await Promise.allSettled([this.q.interrupt(), this.agentTools?.stop()]);
    } catch {
      /* 이미 끝난 경우 무시 */
    }
  }

  async setModel(model: string): Promise<void> {
    if (this.q) await this.q.setModel(model);
    this.o.model = model;
    this.activeModel = model;
  }

  async close(): Promise<void> {
    this.input.close();
    await this.agentTools?.close();
    try {
      this.q?.close();
    } catch {
      /* noop */
    }
    await this.loop?.catch(() => undefined);
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    for await (const msg of this.q) await this.handle(msg);
    if (this.pending) this.finishTurn({ turnCostUsd: 0, error: this.dead ?? '세션 프로세스가 종료되었습니다.' });
  }

  private async handle(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case 'system':
        return this.handleSystem(msg as SDKMessage & { type: 'system' });
      case 'stream_event':
        if (msg.parent_tool_use_id) return;
        return this.handleStream(msg.event as unknown as Record<string, any>);
      case 'assistant': {
        if (msg.parent_tool_use_id) return;
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            this.toolNames.set(block.id, block.name);
            this.spinner.stop();
            this.md.flush();
            this.out(`${ui.tool('●')} ${chalk.bold(block.name)}${chalk.dim(`(${toolSummary(block.name, block.input as Record<string, unknown>)})`)}\n`);
          }
        }
        if (msg.error) {
          const text = msg.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
          const e = classifyAgentError(msg.error, text);
          this.spinner.stop();
          this.lastApiError = e.category;
          this.out(ui.err(`\n✖ API 오류 [${e.category}]: ${e.message}\n`) + ui.dim(`  → ${e.hint}\n`));
        }
        return;
      }
      case 'user': {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content as unknown as Array<Record<string, any>>) {
          if (block.type !== 'tool_result') continue;
          const text = resultText(block.content).trim();
          const first = text.split('\n')[0] ?? '';
          const lines = text ? text.split('\n').length : 0;
          const label = block.is_error ? ui.err(`  ⎿ 실패: ${first.slice(0, 160)}`) : ui.dim(`  ⎿ 완료${lines ? ` (${lines}줄)` : ''}`);
          this.out(label + '\n');
        }
        this.spinner.start('작업 중… (Ctrl+C 중단)');
        return;
      }
      case 'result':
        return this.handleResult(msg);
      case 'rate_limit_event':
        if (msg.rate_limit_info.status === 'rejected') this.out(ui.err('\n✖ Rate Limit 거부됨. 잠시 후 다시 시도하세요.\n'));
        return;
      default:
        return;
    }
  }

  private handleSystem(msg: Record<string, any>): void {
    if (msg.subtype === 'init') {
      this.sessionId = msg.session_id;
      this.apiKeySource = msg.apiKeySource;
      this.activeModel = msg.model ?? this.activeModel;
      this.sdkVersion = msg.claude_code_version;
      this.tools = msg.tools ?? [];
      this.o.tracker.bindSession(msg.session_id);
      if (msg.apiKeySource !== 'ANTHROPIC_API_KEY') {
        // Console API 키 이외의 인증(구독 OAuth 등)이 쓰이는 것을 막는다
        this.dead = `인증 출처가 ANTHROPIC_API_KEY 가 아닙니다(apiKeySource=${msg.apiKeySource}). 안전을 위해 중단합니다.`;
        this.out(ui.err(`\n✖ ${this.dead}\n`));
        void this.q?.interrupt().catch(() => undefined);
        this.input.close();
      }
      return;
    }
    if (msg.subtype === 'api_retry') {
      const e = classifyAgentError(msg.error, undefined, msg.error_status);
      this.spinner.stop();
      this.out(ui.warn(`  ↻ API 재시도 ${msg.attempt}/${msg.max_retries} (${e.category}${msg.error_status ? ` ${msg.error_status}` : ''}), ${Math.round(msg.retry_delay_ms / 1000)}초 후\n`));
      this.spinner.start('재시도 대기 중…');
      return;
    }
    if (msg.subtype === 'permission_denied') {
      this.out(ui.warn(`  ⎿ 권한 거부됨: ${msg.tool_name}\n`));
    }
  }

  private handleStream(ev: Record<string, any>): void {
    switch (ev.type) {
      case 'message_start':
        this.o.tracker.onMessageStart(ev.message.id, ev.message.model, ev.message.usage);
        this.currentMessageId = ev.message.id;
        return;
      case 'content_block_start': {
        const t = ev.content_block?.type;
        if (t === 'thinking' || t === 'redacted_thinking') {
          this.spinner.stop();
          this.spinner.start('생각 중… (Ctrl+C 중단)');
        } else if (t === 'text') {
          this.spinner.stop();
          if (!this.printedHeader) {
            this.out(chalk.bold.blue('\n[Claude]\n'));
            this.printedHeader = true;
          }
        } else if (t === 'tool_use') {
          this.spinner.stop();
          this.md.flush();
        }
        return;
      }
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta') {
          this.spinner.stop();
          this.lastText += ev.delta.text;
          if (!this.o.quiet) this.md.push(ev.delta.text);
        }
        return;
      case 'content_block_stop':
        this.md.flush();
        return;
      case 'message_delta':
        if (this.currentMessageId) this.o.tracker.onMessageDelta(this.currentMessageId, ev.usage);
        return;
      case 'message_stop':
        if (this.currentMessageId) this.o.tracker.onMessageStop(this.currentMessageId);
        this.currentMessageId = undefined;
        this.lastText += '\n';
        return;
    }
  }
  private currentMessageId: string | undefined;
  private lastApiError: string | undefined;
  private interrupted = false;

  private async handleResult(msg: SDKResultMessage): Promise<void> {
    await this.agentTools?.stop();
    this.spinner.stop();
    this.md.flush();
    this.printedHeader = false;
    this.o.tracker.onResult(
      msg.session_id,
      msg.total_cost_usd,
      msg.modelUsage as unknown as Record<string, SdkModelUsage>,
    );
    this.sessionId = msg.session_id;
    let error: string | undefined;
    if (msg.subtype === 'error_max_budget_usd') {
      error = `SDK 예산 한도(maxBudgetUsd)에 도달하여 중단되었습니다. 세션 누적 $${this.o.tracker.sessionCost.toFixed(4)}`;
    } else if (this.interrupted) {
      error = '사용자가 실행을 중단했습니다.';
    } else if (msg.subtype !== 'success') {
      error = `실행 오류(${msg.subtype})`;
    } else if (msg.is_error) {
      const e = classifyAgentError(this.lastApiError, msg.result, msg.api_error_status ?? null);
      // 같은 오류를 assistant 메시지에서 이미 자세히 표시했다면 요약만
      error = this.lastApiError ? `요청 실패 [${e.category}]` : `[${e.category}] ${msg.result}\n  → ${e.hint}`;
    }
    this.lastApiError = undefined;
    this.interrupted = false;
    this.finishTurn({ result: msg, turnCostUsd: this.o.tracker.sessionCost - this.turnStartCost, error });
  }
}
