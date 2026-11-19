import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { mockEnv, runCli, tempWorkspace } from './helpers.mjs';
import { startMock } from './mock-server.mjs';

function tunnelUrl(ssh) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a public Pinggy HTTPS URL.')), 25_000);
    ssh.once('error', error => { clearTimeout(timer); reject(error); });
    ssh.once('exit', code => { clearTimeout(timer); reject(new Error(`SSH tunnel exited (${code}).`)); });
    const read = chunk => {
      output = (output + chunk).slice(-8192);
      const url = output.match(/https:\/\/[a-z0-9-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)\b/i)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    };
    ssh.stdout.on('data', read);
    ssh.stderr.on('data', read);
  });
}

const authorization = 'Bearer ' + randomBytes(32).toString('hex');
const clientKey = randomBytes(32).toString('hex');
const route = '/mcp/' + randomUUID();
const marker = 'cvp-https-result-' + randomUUID();
const methods = new Set();
let rejections = 0;
const server = createServer(async (req, res) => {
  if (req.url !== route) return res.writeHead(404).end();
  if (req.headers.authorization !== authorization || req.headers['x-client-key'] !== clientKey) {
    rejections++;
    return res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    methods.add(method);
    if (id === undefined) return res.writeHead(202).end();
    const results = {
      initialize: {
        protocolVersion: params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'cvp-https-test', version: '1.0.0' },
      },
      'tools/list': {
        tools: [{ name: 'hello', description: 'Read-only verification', inputSchema: { type: 'object' } }],
      },
      'tools/call': { content: [{ type: 'text', text: marker }] },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] ?? {} }));
  } catch {
    res.writeHead(400).end();
  }
});

const ws = tempWorkspace();
let mock;
let ssh;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  ssh = spawn('ssh', [
    '-T', '-p', '443', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(ws.base, 'known_hosts')}`,
    '-o', 'ExitOnForwardFailure=yes', '-R', `0:127.0.0.1:${server.address().port}`, 'a.pinggy.io',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = (await tunnelUrl(ssh)) + route;
  const probe = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  assert.equal(probe.status, 401, 'Public HTTPS endpoint must reject unauthenticated requests');
  await probe.arrayBuffer();

  mock = await startMock();
  const env = mockEnv(mock.url, ws.home, { CVP_MCP_TEST_AUTH: '', CVP_MCP_TEST_CLIENT: '' });
  const cli = async (args, options = {}) => {
    const run = await runCli(args, { cwd: ws.work, env, timeoutMs: 60_000, ...options });
    assert.equal(run.code, 0, `CVP failed during ${args.slice(0, 2).join(' ') || 'the authenticated session'}`);
  };
  const discovered = row => row.body?.tools?.some(tool => tool.name === 'mcp__remote__hello');

  await cli(['mcp', 'add', 'remote', 'http', endpoint]);
  const before = rejections;
  await cli(['-p', 'RUN_HTTP_MCP']);
  assert.ok(rejections > before, 'The unauthenticated CVP request must reach the HTTPS origin and receive 401');
  assert.ok(!mock.log.some(discovered), 'Unauthenticated CVP must not expose the MCP tool');
  console.log('PASS: unauthenticated public HTTPS and CVP requests received 401.');

  await cli(['mcp', 'header-env', 'remote', 'Authorization', 'CVP_MCP_TEST_AUTH']);
  await cli(['mcp', 'header-env', 'remote', 'X-Client-Key', 'CVP_MCP_TEST_CLIENT']);
  const config = fs.readFileSync(path.join(ws.home, 'mcp.json'), 'utf8');
  assert.ok(!config.includes(authorization) && !config.includes(clientKey), 'Secrets must not be persisted');
  await cli([], {
    env: { ...env, CVP_MCP_TEST_AUTH: authorization, CVP_MCP_TEST_CLIENT: clientKey },
    stdin: 'RUN_HTTP_MCP\ny\n/exit\n',
  });
  for (const method of ['initialize', 'tools/list', 'tools/call']) assert.ok(methods.has(method), method);
  assert.ok(mock.log.some(discovered), 'CVP must expose the discovered tool');
  const replies = mock.log.flatMap(row => row.body?.messages ?? [])
    .flatMap(message => Array.isArray(message.content) ? message.content : []);
  assert.ok(replies.some(reply => reply.type === 'tool_result' && !reply.is_error &&
    JSON.stringify(reply.content).includes(marker)), 'CVP must receive the authenticated tool result');
  console.log('PASS: authenticated HTTPS initialize, tools/list, approved tools/call, and tool result.');
} finally {
  ssh?.kill();
  server.closeAllConnections();
  server.close();
  mock?.server.closeAllConnections();
  mock?.server.close();
  fs.rmSync(ws.base, { recursive: true, force: true });
}
