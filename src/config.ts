import type { ExecutionProfile } from './profiles.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePermissionMode, type CvpPermissionMode } from './permissions.js';

/** CLI 전용 홈 디렉터리. CVP_HOME으로 바꿀 수 있다. */
export function cvpHome(): string {
  return process.env.CVP_HOME ? path.resolve(process.env.CVP_HOME) : path.join(os.homedir(), '.cvp');
}

export function configPath(): string {
  return path.join(cvpHome(), 'config.json');
}

/**
 * Agent SDK(Claude Code 런타임)가 사용할 격리된 설정 디렉터리.
 * 사용자의 ~/.claude(구독 로그인 자격 증명, 설정, 훅)를 읽지 않도록 분리한다.
 */
export function agentConfigDir(): string {
  return path.join(cvpHome(), 'agent');
}

export type InputAction = 'newline' | 'queue' | 'interrupt';

export type InterruptKey = 'ctrl+g' | 'ctrl+k' | 'ctrl+u';

function parseInterruptKey(value: unknown): InterruptKey {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'ctrl+g' || normalized === 'ctrl+k' || normalized === 'ctrl+u') return normalized;
  throw new Error('interruptKey에는 ctrl+g, ctrl+k, ctrl+u 중 하나가 필요합니다.');
}

export interface FileConfig {
  interruptKey?: InterruptKey;
  enterAction?: InputAction;
  ctrlEnterAction?: InputAction;
  shiftEnterAction?: InputAction;
  slashEnterSubmit?: boolean;
  model?: string;
  subagentTools?: boolean;
  effort?: EffortLevel;
  maxSessionCostUsd?: number;
  /** SDK 샌드박스(Linux bubblewrap / macOS seatbelt) 사용 여부. Windows에서는 지원되지 않는다. */
  sandbox?: boolean;
  /** 작업 디렉터리 외에 접근을 허용할 디렉터리(절대 경로). */
  additionalDirectories?: string[];
  /** SDK 기본 가격표에 없는 모델의 단가(USD / 1M tokens). 비용 추정에만 사용된다. */
  pricing?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  expectedOrgId?: string;
  /** 기본 권한 모드: default | acceptEdits | plan | bypass | fullbypass */
  permissionMode?: string;
}

const CONFIG_KEYS: Record<string, 'string' | 'number' | 'boolean' | 'list' | 'mode' | 'effort' | 'inputAction' | 'interruptKey'> = {
  interruptKey: 'interruptKey',
  enterAction: 'inputAction',
  ctrlEnterAction: 'inputAction',
  shiftEnterAction: 'inputAction',
  slashEnterSubmit: 'boolean',
  model: 'string',
  subagentTools: 'boolean',
  effort: 'effort',
  maxSessionCostUsd: 'number',
  sandbox: 'boolean',
  additionalDirectories: 'list',
  expectedOrgId: 'string',
  permissionMode: 'mode',
};
/** `cvp config set` 에서 쓰는 별칭 */
const KEY_ALIASES: Record<string, string> = {
  'max-session-cost-usd': 'maxSessionCostUsd',
  budget: 'maxSessionCostUsd',
  'additional-directories': 'additionalDirectories',
  'expected-org-id': 'expectedOrgId',
  'permission-mode': 'permissionMode',
  mode: 'permissionMode',
};

export function loadFileConfig(): FileConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

export function saveFileConfig(cfg: FileConfig): void {
  fs.mkdirSync(cvpHome(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function setConfigValue(rawKey: string, rawValue: string): { key: string; value: unknown } {
  const key = KEY_ALIASES[rawKey] ?? rawKey;
  const kind = CONFIG_KEYS[key];
  if (!kind) {
    throw new Error(`알 수 없는 설정 키: ${rawKey} (사용 가능: ${Object.keys(CONFIG_KEYS).join(', ')})`);
  }
  let value: unknown;
  switch (kind) {
    case 'number': {
      const n = Number(rawValue);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${key}에는 0 이상의 숫자가 필요합니다.`);
      value = n;
      break;
    }
    case 'boolean':
      if (!['true', 'false'].includes(rawValue)) throw new Error(`${key}에는 true 또는 false가 필요합니다.`);
      value = rawValue === 'true';
      break;
    case 'interruptKey':
      value = parseInterruptKey(rawValue);
      break;
    case 'inputAction':
      value = parseInputAction(rawValue);
      break;
    case 'effort':
      value = parseEffort(rawValue);
      break;
    case 'mode':
      value = parsePermissionMode(rawValue);
      break;
    case 'list':
      value = rawValue.split(',').map((s) => path.resolve(s.trim())).filter(Boolean);
      break;
    default:
      if (!rawValue.trim()) throw new Error(`${key} 값이 비어 있습니다.`);
      value = rawValue.trim();
  }
  const cfg = loadFileConfig() as Record<string, unknown>;
  cfg[key] = value;
  if (['enterAction', 'ctrlEnterAction', 'shiftEnterAction'].includes(key) &&
      [cfg.enterAction ?? 'newline', cfg.ctrlEnterAction ?? 'queue', cfg.shiftEnterAction ?? 'interrupt'].every(action => action === 'newline')) {
    throw new Error('Enter 계열 키 중 적어도 하나에는 queue 또는 interrupt 전송 동작을 지정해야 합니다.');
  }
  saveFileConfig(cfg as FileConfig);
  return { key, value };
}

export function unsetConfigValue(rawKey: string): string {
  const key = KEY_ALIASES[rawKey] ?? rawKey;
  const cfg = loadFileConfig() as Record<string, unknown>;
  delete cfg[key];
  saveFileConfig(cfg as FileConfig);
  return key;
}

/** 작업 디렉터리의 .env 를 읽는다(이미 설정된 환경변수는 덮어쓰지 않음). */
export function loadDotEnv(cwd: string): string | undefined {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return undefined;
  try {
    process.loadEnvFile(file);
    return file;
  } catch {
    return undefined;
  }
}

export interface ResolvedConfig {
  interruptKey?: InterruptKey;
  enterAction: InputAction;
  ctrlEnterAction: InputAction;
  shiftEnterAction: InputAction;
  slashEnterSubmit: boolean;
  model?: string;
  subagentTools?: boolean;
  effort?: EffortLevel;
  modelSource: 'flag' | 'profile' | 'env' | 'config' | 'none';
  maxSessionCostUsd: number;
  budgetSource: 'flag' | 'profile' | 'env' | 'config' | 'default';
  sandbox: boolean;
  additionalDirectories: string[];
  pricing: FileConfig['pricing'];
  expectedOrgId?: string;
  permissionMode: CvpPermissionMode;
  supervised: boolean;
  permissionModeSource: 'flag' | 'profile' | 'env' | 'config' | 'default';
  cwd: string;
}

export function parseInputAction(value: unknown): InputAction {
  if (typeof value !== 'string' || !['newline', 'queue', 'interrupt'].includes(value)) {
    throw new Error('입력 동작에는 newline, queue, interrupt 중 하나가 필요합니다.');
  }
  return value as InputAction;
}

export function parseEffort(value: unknown): EffortLevel {
  if (typeof value !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new Error('effort에는 low, medium, high, xhigh, max 중 하나가 필요합니다.');
  }
  return value as EffortLevel;
}

export const DEFAULT_BUDGET_USD = 1.0;

export function resolveConfig(flags: { supervised?: boolean; subagentTools?: boolean; model?: string; effort?: string; budget?: number; cwd?: string; permissionMode?: string }, profile?: ExecutionProfile): ResolvedConfig {
  const file = loadFileConfig();
  const env = process.env;
  let model: string | undefined;
  let modelSource: ResolvedConfig['modelSource'] = 'none';
  if (flags.model) [model, modelSource] = [flags.model, 'flag'];
  else if (profile?.model) [model, modelSource] = [profile.model, 'profile'];
  else if (env.CVP_MODEL?.trim()) [model, modelSource] = [env.CVP_MODEL.trim(), 'env'];
  else if (file.model) [model, modelSource] = [file.model, 'config'];

  let budget = DEFAULT_BUDGET_USD;
  let budgetSource: ResolvedConfig['budgetSource'] = 'default';
  const envBudget = env.CVP_MAX_SESSION_COST_USD?.trim();
  if (flags.budget !== undefined) [budget, budgetSource] = [flags.budget, 'flag'];
  else if (profile) [budget, budgetSource] = [profile.maxSessionCostUsd, 'profile'];
  else if (envBudget) {
    const n = Number(envBudget);
    if (!Number.isFinite(n) || n < 0) throw new Error(`CVP_MAX_SESSION_COST_USD 값이 올바르지 않습니다: ${envBudget}`);
    [budget, budgetSource] = [n, 'env'];
  } else if (typeof file.maxSessionCostUsd === 'number') [budget, budgetSource] = [file.maxSessionCostUsd, 'config'];

  let permissionMode: CvpPermissionMode = 'default';
  let permissionModeSource: ResolvedConfig['permissionModeSource'] = 'default';
  if (flags.permissionMode) [permissionMode, permissionModeSource] = [parsePermissionMode(flags.permissionMode), 'flag'];
  else if (profile) [permissionMode, permissionModeSource] = [profile.permissionMode, 'profile'];
  else if (env.CVP_PERMISSION_MODE?.trim()) [permissionMode, permissionModeSource] = [parsePermissionMode(env.CVP_PERMISSION_MODE), 'env'];
  else if (file.permissionMode) [permissionMode, permissionModeSource] = [parsePermissionMode(file.permissionMode), 'config'];

  const enterAction = parseInputAction(file.enterAction ?? 'newline');
  const ctrlEnterAction = parseInputAction(file.ctrlEnterAction ?? 'queue');
  const shiftEnterAction = parseInputAction(file.shiftEnterAction ?? 'interrupt');
  if ([enterAction, ctrlEnterAction, shiftEnterAction].every(action => action === 'newline')) {
    throw new Error('Enter 계열 키 중 적어도 하나에는 queue 또는 interrupt 전송 동작을 지정해야 합니다.');
  }
  if (file.slashEnterSubmit !== undefined && typeof file.slashEnterSubmit !== 'boolean') {
    throw new Error('slashEnterSubmit에는 true 또는 false가 필요합니다.');
  }
  return {
    interruptKey: file.interruptKey === undefined ? undefined : parseInterruptKey(file.interruptKey),
    enterAction, ctrlEnterAction, shiftEnterAction, slashEnterSubmit: file.slashEnterSubmit ?? true,
    model,
    modelSource,
    subagentTools: flags.subagentTools ?? file.subagentTools ?? false,
    effort: flags.effort !== undefined ? parseEffort(flags.effort)
      : profile?.effort !== undefined ? profile.effort
      : env.CVP_EFFORT !== undefined ? parseEffort(env.CVP_EFFORT)
      : file.effort !== undefined ? parseEffort(file.effort) : undefined,
    permissionMode,
    permissionModeSource,
    supervised: flags.supervised === true,
    maxSessionCostUsd: budget,
    budgetSource,
    sandbox: file.sandbox ?? false,
    additionalDirectories: file.additionalDirectories ?? [],
    pricing: file.pricing,
    expectedOrgId: env.CVP_EXPECTED_ORG_ID?.trim() || file.expectedOrgId,
    cwd: path.resolve(flags.cwd ?? profile?.cwd ?? process.cwd()),
  };
}
