import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCanUseTool, newPermissionState, PathGuard } from '../dist/permissions.js';
import { startMock } from './mock-server.mjs';
import { mockEnv, runCli, tempWorkspace } from './helpers.mjs';

test('등록된 stdio MCP 도구가 모델에 전달된다', async () => {
  const mock = await startMock();
  const ws = tempWorkspace();
  const env = mockEnv(mock.url, ws.home);
  const serverPath = path.join(ws.work, 'mcp-fixture.cjs');
  fs.writeFileSync(serverPath, `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined) return;
      let result;
      if (method === 'initialize') result = {
        protocolVersion: params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      };
      else if (method === 'tools/list') result = {
        tools: [{ name: 'hello', description: 'Test tool', inputSchema: { type: 'object' } }],
      };
      else result = {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    });
  `);
  const cli = args => runCli(args, { cwd: ws.work, env });
  try {
    const add = await cli(['mcp', 'add', 'fixture', 'stdio', process.execPath, serverPath]);
    assert.equal(add.code, 0, add.stderr);
    assert.match((await cli(['mcp', 'list'])).stdout, /fixture\s+stdio/);
    const result = await cli(['-p', 'hello']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(mock.log.some(request => request.body?.tools?.some(tool => tool.name === 'mcp__fixture__hello')));
    assert.equal((await cli(['mcp', 'remove', 'fixture'])).code, 0);
    assert.doesNotMatch((await cli(['mcp', 'list'])).stdout, /fixture/);
  } finally {
    mock.server.closeAllConnections();
    mock.server.close();
  }
});

test('외부 MCP 도구는 명시적으로 승인한 대화형 호출만 허용한다', async () => {
  const tool = 'mcp__fixture__hello';
  const ctx = { signal: new AbortController().signal };
  const check = (mode, ask) => makeCanUseTool({
    state: newPermissionState(mode, true),
    guard: new PathGuard(process.cwd()),
    write: () => {},
    ask,
  })(tool, {}, ctx);
  assert.equal((await check('fullbypass')).behavior, 'deny');
  assert.equal((await check('fullbypass', async () => 'n')).behavior, 'deny');
  assert.equal((await check('default', async () => 'y')).behavior, 'allow');
  assert.equal((await check('plan', async () => 'y')).behavior, 'deny');
});

test('Streamable HTTP MCP sends environment-backed headers and returns an approved tool result', async () => {
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const authorization = `Bearer ${randomUUID()}`;
  const clientKey = randomUUID();
  const methods = [];
  const remote = createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (req.headers.authorization !== authorization || req.headers['x-client-key'] !== clientKey) {
      return res.writeHead(401).end();
    }
    if (req.method !== 'POST') return res.writeHead(405).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    methods.push(method);
    if (id === undefined) return res.writeHead(202).end();
    const results = {
      initialize: {
        protocolVersion: params?.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'authenticated-fixture', version: '1.0.0' },
      },
      'tools/list': {
        tools: [{ name: 'hello', description: 'Test tool', inputSchema: { type: 'object' } }],
      },
      'tools/call': { content: [{ type: 'text', text: 'authenticated-http-result' }] },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] ?? {} }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const mock = await startMock();
  const ws = tempWorkspace();
  const env = mockEnv(mock.url, ws.home, { CVP_MCP_TEST_AUTH: '', CVP_MCP_TEST_CLIENT: '' });
  const cli = (args, options = {}) => runCli(args, { cwd: ws.work, env, ...options });
  try {
    const url = `http://127.0.0.1:${remote.address().port}/mcp`;
    for (const args of [
      ['mcp', 'add', 'remote', 'http', url],
      ['mcp', 'header-env', 'remote', 'Authorization', 'CVP_MCP_TEST_AUTH'],
      ['mcp', 'header-env', 'remote', 'X-Client-Key', 'CVP_MCP_TEST_CLIENT'],
    ]) {
      const result = await cli(args);
      assert.equal(result.code, 0, result.stderr);
    }
    const registry = JSON.parse(fs.readFileSync(path.join(ws.home, 'mcp.json'), 'utf8'));
    assert.deepEqual(registry.remote.headerEnv, {
      Authorization: 'CVP_MCP_TEST_AUTH', 'X-Client-Key': 'CVP_MCP_TEST_CLIENT',
    });
    const missing = await cli(['-p', 'RUN_HTTP_MCP']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /CVP_MCP_TEST_AUTH/);
    assert.deepEqual(methods, []);

    const result = await cli([], {
      env: { ...env, CVP_MCP_TEST_AUTH: authorization, CVP_MCP_TEST_CLIENT: clientKey },
      stdin: 'RUN_HTTP_MCP\ny\n/exit\n',
    });
    assert.equal(result.code, 0, result.stderr);
    for (const method of ['initialize', 'tools/list', 'tools/call']) assert.ok(methods.includes(method), method);
    assert.ok(mock.log.some(request => JSON.stringify(request.body)?.includes('authenticated-http-result')));
    assert.ok(!JSON.stringify(mock.log).includes(clientKey));
    assert.ok(!JSON.stringify(result).includes(authorization));
  } finally {
    remote.closeAllConnections();
    remote.close();
    mock.server.closeAllConnections();
    mock.server.close();
  }
});
