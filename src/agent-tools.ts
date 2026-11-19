import type { BackgroundTasks } from './background-tasks.js';
import { todoServer, type TodoList } from './todos.js';
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, query, tool, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildAgentEnv } from './auth.js';
import { CostTracker, type ModelTotals, type SdkModelUsage } from './cost.js';
import { PathGuard, pathGuardHook, childPermissionState, makeCanUseTool, PermissionQueue, type PermissionState, type CvpPermissionMode, type Asker } from './permissions.js';
import { SUBAGENT_TOOLS, subagentDefinitions } from './subagents.js';

type Worker = { id: string; role: 'explorer' | 'reviewer'; status: 'running' | 'completed' | 'error' | 'interrupted'; result?: string; error?: string; sessionId?: string; q?: Query; done?: Promise<void>; abort?: AbortController; permissions: PermissionState; background: boolean };
export const BACKGROUND_TOOL_NAMES = ['list_tasks','task_status','stop_task'].map(name=>`mcp__cvp_agents__${name}`);
export const AGENT_TOOL_NAMES = ['spawn_agent', 'send_message', 'wait_agent'].map((name) => `mcp__cvp_agents__${name}`);

export class AgentTools {
  private workers = new Map<string, Worker>();
  private closed = false;
  constructor(private o: { apiKey: string; cwd: string; guard: PathGuard; model: () => string; effort?: Options['effort']; tracker: CostTracker; permState: PermissionState; queue: PermissionQueue; ask?: Asker; beforePrompt?: () => void; write?: (s: string) => void; sandbox: boolean; agentsEnabled?: boolean; tasks?: BackgroundTasks; todos?: TodoList; notice?: (text:string)=>void; listTasks?:()=>unknown; readTask?:(id:string)=>unknown|Promise<unknown>; stopTask?:(id:string)=>unknown|Promise<unknown> }) {}

  private view(w: Worker) { return { agent_id: w.id, role: w.role, status: w.status, result: w.result, error: w.error, permission_mode: w.permissions.mode, background: w.background,
    remaining_budget_usd: this.o.tracker.remainingUsd, budget_limit_usd: this.o.tracker.limitUsd,
    estimated_session_cost_usd: this.o.tracker.sessionCost, budget_includes_in_flight: false,
    usage_complete: !this.o.tracker.ledger.usageIncomplete }; }
  private find(id: string): Worker {
    const w = this.workers.get(id);
    if (!w) throw new Error('알 수 없는 agent_id입니다. 현재 부모 세션이 생성한 ID를 사용하세요.');
    return w;
  }
  spawn(role: 'explorer' | 'reviewer', message: string, permissionMode?: CvpPermissionMode, background = false) {
    if (this.closed) throw new Error('에이전트 관리자가 종료되었습니다.');
    if (this.workers.size >= 16) throw new Error('세션당 최대 16개 에이전트까지 보관합니다. 기존 에이전트에 send_message를 사용하세요.');
    const w: Worker = { id: randomUUID(), role, status: 'completed', background, permissions: childPermissionState(this.o.permState, permissionMode) };
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
    w.status = 'running'; w.result = undefined; w.error = undefined;
    w.abort = new AbortController();
    w.done = this.run(w, message).catch((err) => { w.status = 'error'; w.error = (err as Error).message; });
  }
  private async run(w: Worker, message: string): Promise<void> {
    const tracker = this.o.tracker.createChildTracker(w.sessionId);
    const before = tracker.sessionCost;
    const byModelBefore = structuredClone(tracker.ledger.byModel);
    const timer = w.background ? undefined : setTimeout(() => { w.error = '서브에이전트 실행 제한 시간(120초)을 초과했습니다.'; w.abort?.abort(); w.q?.close(); }, 120000);
    let received = false;
    try {
      const definition = subagentDefinitions(this.o.effort)[w.role];
      const guardHook = pathGuardHook(this.o.guard, w.permissions);
      const q = w.q = query({ prompt: message, options: {
        model: this.o.model(), effort: this.o.effort, cwd: this.o.cwd, env: { ...buildAgentEnv(this.o.apiKey), ENABLE_TOOL_SEARCH: 'false' },
        resume: w.sessionId, tools: SUBAGENT_TOOLS.filter(name=>!name.startsWith('mcp__')),
        ...(this.o.todos?{mcpServers:{cvp_progress:todoServer(this.o.todos,w.id,this.o.notice)}}:{}),
        settingSources: [], permissionMode: 'default', maxTurns: 12,
        additionalDirectories: this.o.guard.roots.slice(1), systemPrompt: `${definition.prompt}\nAssigned permission mode: ${w.permissions.mode}. Parent supervision confirmed: ${w.permissions.supervised === true}. Runtime permission checks remain authoritative.`,
        abortController: w.abort,
        hooks: { PreToolUse: [{ onFailure: 'block', hooks: [(input, id, opts) => guardHook({ ...input, agent_id: w.id }, id, opts)] }] },
        sandbox: this.o.sandbox ? { enabled: true, failIfUnavailable: false } : undefined,
        canUseTool: makeCanUseTool({ guard: this.o.guard, state: w.permissions, queue: this.o.queue, ask: this.o.ask,
          beforePrompt: this.o.beforePrompt, allowModeChange: false,
          write: (text) => this.o.write?.(`[서브에이전트 ${w.id}] ${text}`),
        }),
      } });
      for await (const msg of q) {
        if(msg.type==='system')this.o.tasks?.observe(w.id,msg,(id)=>q.stopTask(id));
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
      if (timer) clearTimeout(timer);
      await this.o.tasks?.stopAll(w.id);
      try { w.q?.close(); } catch { /* already closed */ }
      w.q = undefined;
      const cost = Math.max(0, tracker.sessionCost - before);
      const delta: Record<string, ModelTotals> = structuredClone(tracker.ledger.byModel);
      for (const [model, totals] of Object.entries(delta)) {
        const previous = byModelBefore[model];
        if (previous) for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) totals[key] = Math.max(0, totals[key] - previous[key]);
      }
      if (!received) this.o.tracker.ledger.usageIncomplete = true;
      this.o.tracker.addDelegated(cost, delta);
      if(w.background)this.o.notice?.(`Background agent ${w.id}: ${w.status}`);
    }
  }
  has(id:string):boolean{return this.workers.has(id);}
  list(){return [...this.workers.values()].map(w=>this.view(w));}
  async stopOne(id:string){const w=this.find(id);if(w.status==='running'){w.abort?.abort();try{w.q?.close();}catch{}await w.done;}return this.view(w);}
  async stopForeground():Promise<void>{await this.stop(false);}
  async stop(includeBackground=true): Promise<void> {
    const selected=[...this.workers.values()].filter(w=>includeBackground||!w.background);
    for (const w of selected) if (w.status === 'running') {
      w.abort?.abort();
      try { w.q?.close(); } catch { /* already closed */ }
    }
    await Promise.allSettled(selected.map((w) => w.done));
  }
  async close(): Promise<void> { this.closed = true; await this.stop(); }

  server() {
    const result = async (action: () => unknown | Promise<unknown>) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
      catch (err) { return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] }; }
    };
    const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [
      tool('spawn_agent', 'Start an independent explorer or reviewer with file and shell tools subject to permission_mode. Omit permission_mode to inherit the parent; a higher mode than the parent is rejected. Set background=true to survive the parent turn; otherwise unfinished work is stopped when the parent turn ends. Returns agent_id immediately. Use wait_agent to collect its result.', { role: z.enum(['explorer', 'reviewer']), permission_mode: z.enum(['plan', 'default', 'acceptEdits', 'bypass', 'fullbypass']).optional(), background: z.boolean().optional(), message: z.string().trim().min(1).max(32000) }, (a) => result(() => this.spawn(a.role, a.message, a.permission_mode, a.background))),
      tool('send_message', 'Send follow-up work to a completed agent, resuming its conversation. Running agents reject messages; wait first.', { agent_id: z.string().uuid(), message: z.string().trim().min(1).max(32000) }, (a) => result(() => this.send(a.agent_id, a.message))),
      tool('wait_agent', 'Read agent status, final result, and estimated remaining session budget (in-flight costs excluded). Wait at most timeout_ms; running status means call again later.', { agent_id: z.string().uuid(), timeout_ms: z.number().int().min(0).max(60000).optional() }, (a) => result(() => this.wait(a.agent_id, a.timeout_ms ?? 10000))),
    ];
    const selected = this.o.agentsEnabled === false ? [] : tools;
    if(this.o.listTasks&&this.o.readTask&&this.o.stopTask) selected.push(
      tool('list_tasks','List background command and agent tasks in this CVP session.',{},()=>result(()=>this.o.listTasks!())),
      tool('task_status','Read status and bounded output for a known task_id.',{task_id:z.string().min(1).max(200)},a=>result(()=>this.o.readTask!(a.task_id))),
      tool('stop_task','Stop a known task from this CVP session.',{task_id:z.string().min(1).max(200)},a=>result(()=>this.o.stopTask!(a.task_id))),
    );
    return createSdkMcpServer({name:'cvp_agents',version:'1.0.0',tools:selected});
  }
}
