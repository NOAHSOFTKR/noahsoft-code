import { delegationInput, SUBAGENT_TOOLS } from './subagents.js';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { CanUseTool, HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/** 이 CLI가 모델에 노출하는 SDK 내장 도구 */
export function enabledTools(platform = process.platform): string[] {
  const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent'];
  // Windows에서는 SDK의 PowerShell 도구도 함께 제공(Bash 도구는 Git Bash 필요)
  if (platform === 'win32') tools.push('PowerShell');
  return tools;
}

const FILE_TOOLS_PATH_KEY: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'path',
  Grep: 'path',
};
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function realish(p: string): string {
  // 존재하는 가장 가까운 상위 경로까지 realpath 로 정규화(심볼릭 링크 우회 방지)
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const r = fs.realpathSync.native(cur);
      return tail.length ? path.join(r, ...tail.reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(target: string, root: string, platform = process.platform): boolean {
  const norm = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(realish(root)), norm(realish(target)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PathGuard {
  readonly roots: string[];
  constructor(cwd: string, additional: string[] = []) {
    this.roots = [cwd, ...additional].map((d) => path.resolve(d));
  }
  allows(p: string, cwd = this.roots[0]): boolean {
    const abs = path.resolve(cwd, p);
    return this.roots.some((r) => isInside(abs, r));
  }
  /** 파일 도구 입력에서 대상 경로를 추출(없으면 cwd) */
  targetOf(toolName: string, input: Record<string, unknown>): string | undefined {
    const key = FILE_TOOLS_PATH_KEY[toolName];
    if (!key) return undefined;
    const v = input[key];
    return typeof v === 'string' && v.trim() ? v : this.roots[0];
  }
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(del|erase)\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bgit\s+(push\s+.*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)/,
  /\b(mkfs|fdisk|diskpart|format)\b/i,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i,
  /(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression)/i,
  /\bchmod\s+-R\s+777\b/,
  />\s*\/dev\/sd[a-z]/,
  /\bsudo\b/,
  /\bnpm\s+publish\b/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

export type Asker = (question: string, signal?: AbortSignal) => Promise<string>;

/**
 * 권한 모드
 * - default     : 파일 수정·명령 실행 모두 승인 요청
 * - acceptEdits : 작업 디렉터리 안 파일 수정은 자동 승인, 명령 실행은 승인 요청
 * - plan        : 읽기 전용. 파일 수정·명령 실행 거부(계획만 세움)
 * - bypass      : 작업 디렉터리 안 수정·명령 자동 승인. 위험 명령은 여전히 승인 요청(비대화형이면 거부)
 * 모든 모드에서 작업 디렉터리 밖 파일 도구 접근은 거부된다.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypass'] as const;
export type CvpPermissionMode = (typeof PERMISSION_MODES)[number];

/** Shift+Tab 순환 대상(bypass 는 실수로 켜지지 않도록 제외) */
export const CYCLE_MODES: CvpPermissionMode[] = ['default', 'acceptEdits', 'plan'];

const MODE_ALIASES: Record<string, CvpPermissionMode> = {
  default: 'default',
  ask: 'default',
  normal: 'default',
  acceptedits: 'acceptEdits',
  'accept-edits': 'acceptEdits',
  edits: 'acceptEdits',
  plan: 'plan',
  readonly: 'plan',
  'read-only': 'plan',
  bypass: 'bypass',
  bypasspermissions: 'bypass',
  yolo: 'bypass',
};

export function parsePermissionMode(v: string): CvpPermissionMode {
  const m = MODE_ALIASES[v.trim().toLowerCase()];
  if (!m) throw new Error(`알 수 없는 권한 모드: ${v} (사용 가능: ${PERMISSION_MODES.join(', ')})`);
  return m;
}

export const MODE_INFO: Record<CvpPermissionMode, { label: string; desc: string }> = {
  default: { label: '기본', desc: '파일 수정·명령 실행 모두 승인 요청' },
  acceptEdits: { label: '편집 자동승인', desc: '작업 디렉터리 안 파일 수정 자동 승인, 명령 실행은 승인 요청' },
  plan: { label: '계획(읽기 전용)', desc: '파일 수정·명령 실행 거부, 읽기와 계획만' },
  bypass: { label: '전체 자동승인', desc: '작업 디렉터리 안 수정·명령 자동 승인(위험 명령은 승인 요청)' },
};

export interface PermissionState {
  mode: CvpPermissionMode;
  /** 세션 동안 승인된 Bash/PowerShell 명령(정확히 일치) */
  allowedCommands: Set<string>;
}

export function newPermissionState(mode: CvpPermissionMode = 'default'): PermissionState {
  return { mode, allowedCommands: new Set() };
}

const PLAN_DENY =
  'CVP CLI: 현재 plan(읽기 전용) 모드라 파일 수정과 명령 실행이 거부됩니다. 파일을 바꾸지 말고, 읽은 내용을 바탕으로 변경 계획을 제시하세요. 실행하려면 사용자가 /mode 로 모드를 바꿔야 합니다.';

function preview(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

export function describeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return `명령: ${String(input.command ?? '')}${input.description ? chalk.dim(`\n설명: ${input.description}`) : ''}`;
    case 'Write':
      return `파일: ${input.file_path}\n${chalk.dim(preview(String(input.content ?? ''), 600))}`;
    case 'Edit':
      return (
        `파일: ${input.file_path}\n` +
        chalk.red(preview(String(input.old_string ?? '').replace(/^/gm, '- '), 500)) +
        '\n' +
        chalk.green(preview(String(input.new_string ?? '').replace(/^/gm, '+ '), 500))
      );
    default:
      return preview(JSON.stringify(input, null, 2), 600);
  }
}

/**
 * 애플리케이션 수준 접근 제한(PreToolUse 훅):
 * 작업 디렉터리(및 허용 디렉터리) 밖의 파일 도구 호출을 거부한다.
 * 이것은 SDK 샌드박스(OS 수준 격리)와 다르다 — 셸 명령이 바깥 경로에 접근하는 것은 막지 못한다.
 */
export function pathGuardHook(guard: PathGuard, state?: PermissionState): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (input.agent_id && !SUBAGENT_TOOLS.includes(input.tool_name)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'CVP CLI: 서브에이전트에는 허용된 파일·명령 도구만 제공됩니다.' } };
    }
    if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
      const updatedInput = delegationInput(toolInput);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: updatedInput ? 'allow' : 'deny',
        permissionDecisionReason: 'CVP CLI: explorer/reviewer의 로컬 동기 실행만 허용됩니다.', ...(updatedInput ? { updatedInput } : {}) } };
    }
    const target = guard.targetOf(input.tool_name, toolInput);
    if (target && !guard.allows(target, input.cwd)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `CVP CLI 정책: 작업 디렉터리 밖 경로(${target})에는 접근할 수 없습니다.`,
        },
      };
    }
    const mutating = SHELL_TOOLS.has(input.tool_name) || WRITE_TOOLS.has(input.tool_name);
    if (mutating && state?.mode === 'plan') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_DENY } };
    }
    // 런타임이 '읽기 전용'으로 분류해 자동 승인하는 명령(예: echo, ls)도 포함해
    // 모든 셸 명령과 파일 수정은 반드시 canUseTool(사용자 승인)을 거치게 한다.
    if (mutating) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'CVP CLI 정책: 파일 수정·명령 실행은 사용자 승인이 필요합니다.',
        },
      };
    }
    return { continue: true };
  };
}

const MODE_RANK: Record<CvpPermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, bypass: 3 };

export function childPermissionState(parent: PermissionState, requested?: CvpPermissionMode): PermissionState {
  if (requested && MODE_RANK[requested] > MODE_RANK[parent.mode]) {
    throw new Error(`부모 권한(${parent.mode})보다 높은 자식 권한(${requested})은 부여할 수 없습니다.`);
  }
  return {
    get mode() { return requested && MODE_RANK[requested] < MODE_RANK[parent.mode] ? requested : parent.mode; },
    set mode(_mode: CvpPermissionMode) { /* child cannot raise its assigned ceiling */ },
    allowedCommands: new Set<string>(),
  };
}

/** Parent and child permission prompts share one queue. */
export class PermissionQueue {
  private pending: Promise<void> = Promise.resolve();
  run(action: () => Promise<PermissionResult>): Promise<PermissionResult> {
    const result = this.pending.then(action);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface CanUseToolDeps {
  guard: PathGuard;
  state: PermissionState;
  queue?: PermissionQueue;
  allowModeChange?: boolean;
  /** 사용자에게 묻는 함수. 없으면(비대화형) 위험 작업은 거부 */
  ask?: Asker;
  /** 프롬프트 표시 전/후 UI 정리(스피너 정지 등) */
  beforePrompt?: () => void;
  write?: (s: string) => void;
  /** 승인 프롬프트에서 모드가 바뀌었을 때 알림 */
  onModeChange?: (mode: CvpPermissionMode) => void;
}

/** SDK canUseTool 콜백: 파일 수정·명령 실행 전 사용자 승인 */
export function makeCanUseTool(deps: CanUseToolDeps): CanUseTool {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const queue = deps.queue ?? new PermissionQueue();
  return (toolName, input, opts): Promise<PermissionResult> => queue.run(async () => {
    if (opts.signal.aborted) return { behavior: 'deny', message: '중단됨', interrupt: true };
    if (toolName === 'Agent' || toolName === 'Task') {
      const updatedInput = delegationInput(input);
      return updatedInput ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: 'explorer/reviewer의 로컬 동기 실행만 허용됩니다.' };
    }
    const target = deps.guard.targetOf(toolName, input);
    if (target && !deps.guard.allows(target)) {
      return { behavior: 'deny', message: `작업 디렉터리 밖 경로(${target})는 허용되지 않습니다.` };
    }
    const isShell = SHELL_TOOLS.has(toolName);
    const isWrite = WRITE_TOOLS.has(toolName);
    const command = isShell ? String(input.command ?? '') : '';
    const dangerous = isShell && isDangerousCommand(command);

    const mode = deps.state.mode;
    if ((isShell || isWrite) && mode === 'plan') return { behavior: 'deny', message: PLAN_DENY };
    if (isWrite && (mode === 'acceptEdits' || mode === 'bypass')) return { behavior: 'allow', updatedInput: input };
    if (isShell && !dangerous && mode === 'bypass') return { behavior: 'allow', updatedInput: input };
    if (isShell && !dangerous && deps.state.allowedCommands.has(command)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (!isShell && !isWrite) {
      // 읽기 도구가 SDK 기본 정책상 확인을 요구한 경우(예: 민감 파일) — 작업 디렉터리 안이면 허용
      if (!deps.ask) return { behavior: 'allow', updatedInput: input };
    }
    if (!deps.ask) {
      return {
        behavior: 'deny',
        message: dangerous
          ? '위험 명령으로 분류되어 승인이 필요하지만, 비대화형 실행이라 승인을 받을 수 없어 거부했습니다.'
          : '비대화형 실행에서는 파일 수정/명령 실행 승인을 받을 수 없어 거부했습니다. 대화형 모드(cvp)에서 실행하거나 --permission-mode 를 지정하세요.',
      };
    }

    deps.beforePrompt?.();
    const title = opts.title ?? `${toolName} 실행 요청`;
    write(
      '\n' +
        (dangerous ? chalk.bgRed.white.bold(' 위험 ') + ' ' : chalk.yellow.bold('? ')) +
        chalk.bold(title) +
        '\n' +
        describeToolInput(toolName, input).replace(/^/gm, '  ') +
        '\n' +
        (opts.decisionReason ? chalk.dim(`  사유: ${opts.decisionReason}\n`) : '') +
        (isShell ? chalk.dim('  ※ 셸 명령은 작업 디렉터리 격리가 적용되지 않습니다(샌드박스 비활성 시).\n') : ''),
    );
    const always = dangerous ? '' : isShell ? ' / a=이 명령 세션 동안 허용' : isWrite && deps.allowModeChange !== false ? ' / a=편집 자동승인 모드로 전환' : '';
    for (;;) {
      if (opts.signal.aborted) return { behavior: 'deny', message: '중단됨', interrupt: true };
      const ans = (await deps.ask(chalk.bold(`  허용할까요? [y=허용 / n=거부${always}] `), opts.signal)).trim().toLowerCase();
      if (opts.signal.aborted) return { behavior: 'deny', message: '중단됨', interrupt: true };
      if (target && !deps.guard.allows(target)) return { behavior: 'deny', message: '승인 대기 중 경로가 변경되어 거부했습니다.' };
      if ((isShell || isWrite) && deps.state.mode === 'plan') return { behavior: 'deny', message: PLAN_DENY };
      if (ans === 'y' || ans === 'yes') return { behavior: 'allow', updatedInput: input };
      if (ans === 'a' && always) {
        if (isShell) deps.state.allowedCommands.add(command);
        else if (isWrite) {
          deps.state.mode = 'acceptEdits';
          deps.onModeChange?.('acceptEdits');
        }
        return { behavior: 'allow', updatedInput: input };
      }
      if (ans === 'n' || ans === 'no' || ans === '') {
        return { behavior: 'deny', message: '사용자가 이 작업을 거부했습니다. 다른 방법을 제안하거나 사용자에게 확인하세요.' };
      }
    }
  });
}
