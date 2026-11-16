import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, query, tool, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildAgentEnv } from './auth.js';
import { CostTracker, type ModelTotals, type SdkModelUsage } from './cost.js';
import { PathGuard, pathGuardHook, childPermissionState, makeCanUseTool, PermissionQueue, type PermissionState, type CvpPermissionMode, type Asker } from './permissions.js';
import { SUBAGENT_TOOLS, subagentDefinitions } from './subagents.js';

type Worker = { id: string; role: 'explorer' | 'reviewer'; status: 'running' | 'completed' | 'error' | 'interrupted'; result?: string; error?: string; sessionId?: string; q?: Query; done?: Promise<void>; abort?: AbortController; permissions: PermissionState };
export const AGENT_TOOL_NAMES = ['spawn_agent', 'send_message', 'wait_agent'].map((name) => `mcp__cvp_agents__${name}`);

export class AgentTools {
  private workers = new Map<string, Worker>();
  private reserved = 0;
  private spent = 0;
  private closed = false;
  constructor(private o: { apiKey: string; cwd: string; guard: PathGuard; model: () => string; effort?: Options['effort']; budgetUsd: number; tracker: CostTracker; permState: PermissionState; queue: PermissionQueue; ask?: Asker; beforePrompt?: () => void; write?: (s: string) => void; sandbox: boolean }) {}

  private view(w: Worker) { return { agent_id: w.id, role: w.role, status: w.status, result: w.result, error: w.error, permission_mode: w.permissions.mode }; }
  private find(id: string): Worker {
    const w = this.workers.get(id);
    if (!w) throw new Error('알 수 없는 agent_id입니다. 현재 부모 세션이 생성한 ID를 사용하세요.');
    return w;
  }
  spawn(role: 'explorer' | 'reviewer', message: string, permissionMode?: CvpPermissionMode) {
    if (this.closed) throw new Error('에이전트 관리자가 종료되었습니다.');
    if (this.workers.size >= 16) throw new Error('세션당 최대 16개 에이전트까지 보관합니다. 기존 에이전트에 send_message를 사용하세요.');
    const w: Worker = { id: randomUUID(), role, status: 'completed', permissions: childPermissionState(this.o.permState, permissionMode) };
    this.launch(w, message);
    this.workers.set(w.id, w);
    return this.view(w);
  }
  send(id: string, message: string) {
    const w = this.find(id);
    if (w.status === 'running') throw new Error('실행 중인 에이전트입니다. wait_agent로 완료를 확인한 뒤 메시지를 보내세요.');
    if (!w.sessionId) throw new Error('재개할 세션이 없습니다. 새 에이전트를 생성하세요.');
    this.launch(w, message);
    return this.view(w);
  }
  async wait(id: string, timeoutMs: number) {
    const w = this.find(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (w.status === 'running' && timeoutMs > 0) await Promise.race([w.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.view(w);
    } finally { if (timer) clearTimeout(timer); }
  }
  private launch(w: Worker, message: string): void {
    if (this.closed) throw new Error('에이전트 관리자가 종료되었습니다.');
    if (!message.trim() || message.length > 32000) throw new Error('메시지는 1~32000자여야 합니다.');
    if ([...this.workers.values()].filter((x) => x.status === 'running').length >= 3) throw new Error('동시에 최대 3개 에이전트만 실행할 수 있습니다.');
    this.o.tracker.assertWithinBudget();
    const budget = Math.min(this.o.budgetUsd / 3, this.o.budgetUsd - this.spent - this.reserved);
    if (budget <= 0.000001) throw new Error('서브에이전트 예산이 소진되었습니다.');
    this.reserved += budget;
    w.status = 'running'; w.result = undefined; w.error = undefined;
    w.abort = new AbortController();
    w.done = this.run(w, message, budget).catch((err) => { w.status = 'error'; w.error = (err as Error).message; });
  }
  private async run(w: Worker, message: string, budget: number): Promise<void> {
    const tracker = this.o.tracker.createChildTracker(w.sessionId);
    const before = tracker.sessionCost;
    const byModelBefore = structuredClone(tracker.ledger.byModel);
    tracker.limitUsd = before + budget;
    const timer = setTimeout(() => { w.error = '서브에이전트 실행 제한 시간(120초)을 초과했습니다.'; w.abort?.abort(); w.q?.close(); }, 120000);
    let received = false;
    try {
      const definition = subagentDefinitions(this.o.effort)[w.role];
      const guardHook = pathGuardHook(this.o.guard, w.permissions);
      const q = w.q = query({ prompt: message, options: {
        model: this.o.model(), effort: this.o.effort, cwd: this.o.cwd, env: { ...buildAgentEnv(this.o.apiKey), ENABLE_TOOL_SEARCH: 'false' },
        resume: w.sessionId, tools: [...SUBAGENT_TOOLS],
        settingSources: [], permissionMode: 'default', maxTurns: 12, maxBudgetUsd: budget,
        additionalDirectories: this.o.guard.roots.slice(1), systemPrompt: definition.prompt,
        abortController: w.abort,
        hooks: { PreToolUse: [{ onFailure: 'block', hooks: [(input, id, opts) => guardHook({ ...input, agent_id: w.id }, id, opts)] }] },
        sandbox: this.o.sandbox ? { enabled: true, failIfUnavailable: false } : undefined,
        canUseTool: makeCanUseTool({ guard: this.o.guard, state: w.permissions, queue: this.o.queue, ask: this.o.ask,
          beforePrompt: this.o.beforePrompt, allowModeChange: false,
          write: (text) => this.o.write?.(`[서브에이전트 ${w.id}] ${text}`),
        }),
      } });
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (msg.apiKeySource !== 'ANTHROPIC_API_KEY') throw new Error('서브에이전트 인증 출처가 올바르지 않습니다.');
          w.sessionId = msg.session_id;
        }
        if (msg.type === 'result') {
          received = true;
          tracker.onResult(msg.session_id, msg.total_cost_usd, msg.modelUsage as unknown as Record<string, SdkModelUsage>);
          if (msg.subtype !== 'success' || msg.is_error) throw new Error(`서브에이전트 실행 실패: ${msg.subtype}`);
          w.result = msg.result.slice(0, 32000);

        }
      }
      if (!received) throw new Error('서브에이전트가 결과 없이 종료되었습니다.');
      w.status = 'completed';
    } catch (err) {
      w.status = w.abort?.signal.aborted ? 'interrupted' : 'error';
      w.error ??= (err as Error).message;
    } finally {
      clearTimeout(timer);
      try { w.q?.close(); } catch { /* already closed */ }
      w.q = undefined;
      const cost = Math.max(0, tracker.sessionCost - before);
      const delta: Record<string, ModelTotals> = structuredClone(tracker.ledger.byModel);
      for (const [model, totals] of Object.entries(delta)) {
        const previous = byModelBefore[model];
        if (previous) for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) totals[key] = Math.max(0, totals[key] - previous[key]);
      }
      // Missing final usage after cancellation: keep the full reservation charged conservatively.
      const charged = received ? cost : Math.max(cost, budget);
      this.spent += charged;
      this.reserved -= budget;
      this.o.tracker.addDelegated(charged, delta);
    }
  }
  async stop(): Promise<void> {
    for (const w of this.workers.values()) if (w.status === 'running') {
      w.abort?.abort();
      try { w.q?.close(); } catch { /* already closed */ }
    }
    await Promise.allSettled([...this.workers.values()].map((w) => w.done));
  }
  async close(): Promise<void> { this.closed = true; await this.stop(); }

  server() {
    const result = async (action: () => unknown | Promise<unknown>) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
      catch (err) { return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }; }
    };
    return createSdkMcpServer({ name: 'cvp_agents', version: '1.0.0', tools: [
      tool('spawn_agent', 'Start an independent explorer or reviewer with file and shell tools subject to permission_mode. Omit permission_mode to inherit the parent; a higher mode than the parent is rejected. Returns agent_id immediately. Use wait_agent to collect its result.', { role: z.enum(['explorer', 'reviewer']), permission_mode: z.enum(['plan', 'default', 'acceptEdits', 'bypass']).optional(), message: z.string().trim().min(1).max(32000) }, (a) => result(() => this.spawn(a.role, a.message, a.permission_mode))),
      tool('send_message', 'Send follow-up work to a completed agent, resuming its conversation. Running agents reject messages; wait first.', { agent_id: z.string().uuid(), message: z.string().trim().min(1).max(32000) }, (a) => result(() => this.send(a.agent_id, a.message))),
      tool('wait_agent', 'Read agent status and final result. Wait at most timeout_ms; running status means call again later.', { agent_id: z.string().uuid(), timeout_ms: z.number().int().min(0).max(60000).optional() }, (a) => result(() => this.wait(a.agent_id, a.timeout_ms ?? 10000))),
    ] });
  }
}
