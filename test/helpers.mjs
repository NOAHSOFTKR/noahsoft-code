import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'dist', 'index.js');
export const TEST_KEY = 'sk-ant-api03-mock-test-key-0000000000000000';

export function tempWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-test-'));
  const work = path.join(base, 'work');
  const home = path.join(base, 'home');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# sample\n');
  return { base, work, home };
}

/** CLI 실행. stdin 은 파이프(비 TTY) */
export function runCli(args, { cwd, env = {}, stdin = '', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export function mockEnv(url, home, extra = {}) {
  // 사용자 환경의 다른 인증 수단이 섞이지 않도록 제거한 상태로 실행
  return {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: TEST_KEY,
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CVP_HOME: home,
    CVP_MODEL: 'claude-sonnet-5-5',
    CVP_MAX_SESSION_COST_USD: '1.00',
    CVP_EXPECTED_ORG_ID: '',
    CVP_PERMISSION_MODE: '',
    ...extra,
  };
}
