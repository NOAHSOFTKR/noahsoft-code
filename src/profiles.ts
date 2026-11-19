import fs from 'node:fs';
import path from 'node:path';
import { cvpHome, parseEffort, type ResolvedConfig } from './config.js';
import { parsePermissionMode, type CvpPermissionMode } from './permissions.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export interface ExecutionProfile {
  version: 1;
  model?: string;
  effort?: EffortLevel;
  permissionMode: CvpPermissionMode;
  maxSessionCostUsd: number;
  cwd: string;
}

export function profilePath(name: string): string {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('프로필 이름은 문자·숫자로 시작하는 1~64자의 문자·숫자·밑줄·하이픈·점이어야 합니다. 경로와 Windows 예약명은 사용할 수 없습니다.');
  }
  return path.join(cvpHome(), 'profiles', `${name}.json`);
}

export function loadProfile(name: string): ExecutionProfile {
  const file = profilePath(name);
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`프로필을 읽을 수 없습니다: ${name} (${(err as Error).message})`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`잘못된 프로필: ${name}`);
  const p = data as Record<string, unknown>;
  const keys = ['version', 'model', 'effort', 'permissionMode', 'maxSessionCostUsd', 'cwd'];
  if (Object.keys(p).some((key) => !keys.includes(key)) || p.version !== 1 ||
      (p.model !== undefined && (typeof p.model !== 'string' || !p.model.trim())) ||
      typeof p.permissionMode !== 'string' || typeof p.maxSessionCostUsd !== 'number' ||
      !Number.isFinite(p.maxSessionCostUsd) || p.maxSessionCostUsd < 0 ||
      typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)) throw new Error(`잘못된 프로필 설정: ${name}`);
  return { version: 1, model: p.model as string | undefined,
    effort: p.effort === undefined ? undefined : parseEffort(p.effort),
    permissionMode: parsePermissionMode(p.permissionMode), maxSessionCostUsd: p.maxSessionCostUsd, cwd: p.cwd };
}

export function saveProfile(name: string, cfg: ResolvedConfig): ExecutionProfile {
  const file = profilePath(name);
  const profile: ExecutionProfile = { version: 1, model: cfg.model, effort: cfg.effort,
    permissionMode: cfg.permissionMode, maxSessionCostUsd: cfg.maxSessionCostUsd, cwd: cfg.cwd };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return profile;
}

export function listProfiles(): string[] {
  const dir = path.join(cvpHome(), 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5)).sort();
}

export function deleteProfile(name: string): void { fs.unlinkSync(profilePath(name)); }
