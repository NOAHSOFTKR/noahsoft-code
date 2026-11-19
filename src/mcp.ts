import fs from 'node:fs';
import path from 'node:path';
import { validateHeaderValue } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cvpHome } from './config.js';

const serverName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine(name => !/^(cvp_agents|cvp_progress)$/i.test(name) && !name.includes('__'));
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const serverConfig = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('http'),
    headerEnv: z.record(headerName, envName).optional(),
    url: z.url({ protocol: /^https?$/ }).refine(value => {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash;
    }),
  }),
  z.strictObject({
    type: z.literal('stdio'),
    command: z.string().min(1).refine(value => !value.includes('\0')),
    args: z.array(z.string().refine(value => !value.includes('\0'))),
  }),
]);
const registry = z.record(serverName, serverConfig);
const usage = '사용법: cvp mcp list | header-env <이름> <헤더> <환경변수> | remove <이름> | add <이름> http <URL> | add <이름> stdio <명령> [인자...]';

function loadRegistry(): z.infer<typeof registry> {
  try {
    return registry.parse(JSON.parse(fs.readFileSync(path.join(cvpHome(), 'mcp.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('CVP_HOME/mcp.json을 읽을 수 없거나 MCP 서버 설정이 올바르지 않습니다.');
  }
}

function allowsAuthHeaders(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function loadMcpServers() {
  return Object.fromEntries(Object.entries(loadRegistry()).map(([name, server]) => {
    if (server.type !== 'http') return [name, server] as const;
    const { headerEnv, ...config } = server;
    if (!headerEnv || !Object.keys(headerEnv).length) return [name, config] as const;
    if (!allowsAuthHeaders(config.url)) throw new Error(`MCP 서버 ${name}: 인증 헤더에는 HTTPS가 필요합니다.`);
    const headers = Object.fromEntries(Object.entries(headerEnv).map(([header, variable]) => {
      const value = process.env[variable];
      if (!value?.trim()) throw new Error(`MCP 서버 ${name}: 환경변수 ${variable}를 설정하세요.`);
      try { validateHeaderValue(header, value); }
      catch { throw new Error(`MCP 서버 ${name}: 환경변수 ${variable}에 유효한 HTTP 헤더 값이 필요합니다.`); }
      return [header, value];
    }));
    return [name, { ...config, headers }] as const;
  }));
}

export function runMcpCommand([action, name, type, value, ...args]: string[]): void {
  const servers = loadRegistry();
  if (action === 'list' && name === undefined) {
    for (const [id, server] of Object.entries(servers)) process.stdout.write(`${id}\t${server.type}\n`);
    if (Object.keys(servers).length === 0) process.stdout.write('등록된 외부 MCP 서버가 없습니다.\n');
    return;
  }
  if (!serverName.safeParse(name).success) throw new Error(usage);
  if (action === 'remove' && type === undefined) {
    if (!Object.hasOwn(servers, name)) throw new Error('등록된 MCP 서버를 찾을 수 없습니다.');
    delete servers[name];
  } else if (action === 'header-env' && headerName.safeParse(type).success && envName.safeParse(value).success && type !== undefined && value !== undefined && !args.length) {
    const server = servers[name];
    if (!Object.hasOwn(servers, name) || server.type !== 'http') throw new Error('등록된 HTTP MCP 서버를 찾을 수 없습니다.');
    if (!allowsAuthHeaders(server.url)) throw new Error('인증 헤더에는 HTTPS가 필요합니다. 로컬 테스트는 루프백 HTTP를 사용할 수 있습니다.');
    const headers = Object.entries(server.headerEnv ?? {}).filter(([header]) => header.toLowerCase() !== type.toLowerCase());
    server.headerEnv = Object.fromEntries([...headers, [type, value]]);
  } else if (action === 'add' && value !== undefined) {
    if (Object.hasOwn(servers, name)) throw new Error('이미 등록된 MCP 서버입니다.');
    const candidate = type === 'stdio' ? { type, command: value, args } : { type, url: value };
    const result = serverConfig.safeParse(candidate);
    if (!result.success || (type === 'http' && args.length)) throw new Error(usage);
    servers[name] = result.data;
  } else {
    throw new Error(usage);
  }

  const dir = cvpHome();
  fs.mkdirSync(dir, { recursive: true });
  const temporaryPath = path.join(dir, `mcp-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(servers, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, path.join(dir, 'mcp.json'));
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  process.stdout.write(`${name}: ${action === 'remove' ? '삭제됨' : '저장됨'} (다음 실행부터 적용)\n`);
}
