import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { AgentSession } from '../dist/agent.js';
import { CostTracker } from '../dist/cost.js';
import { PathGuard, newPermissionState } from '../dist/permissions.js';
import { mockEnv, tempWorkspace, TEST_KEY } from './helpers.mjs';
import { startMock } from './mock-server.mjs';

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const withTool of [true, false]) {
  test(`SDK Steer ${withTool ? 'folds between tool rounds' : 'settles in a follow-up turn when the first reply has no tools'}`, { timeout: 35_000 }, async () => {
    const started = gate();
    const release = gate();
    const mock = await startMock({
      beforeNoToolResponse: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const ws = tempWorkspace();
    const env = { ...process.env };
    Object.assign(process.env, mockEnv(mock.url, ws.home));
    let output = '';
    const session = new AgentSession({
      apiKey: TEST_KEY,
      cwd: ws.work,
      model: 'claude-sonnet-5-5',
      tracker: new CostTracker(undefined, 5),
      guard: new PathGuard(ws.work),
      permState: newPermissionState('default'),
      sandbox: false,
      raw: true,
      out: text => { output += text; },
      ask: async () => {
        started.resolve();
        await release.promise;
        return 'y';
      },
    });
    try {
      assert.equal(session.steer('before startup'), false);
      const done = session.send(withTool ? 'WRITE_FILE' : 'STEER_NO_TOOL_ROOT');
      await Promise.race([started.promise, done.then(() => { throw new Error('first turn finished before the test gate'); })]);
      assert.equal(session.steer('/compact'), false);
      assert.equal(session.steer('STEER_TEST_INPUT'), true);
      assert.equal(session.busy, true);
      await assert.rejects(session.send('not ready'), /아직 실행 중/);
      // Keep the initial operation in flight while the child reads the Steer message.
      await new Promise(resolve => setTimeout(resolve, 250));
      release.resolve();
      const outcome = await done;
      assert.equal(outcome.error, undefined, output);
      assert.match(output, /Steer #1 · SDK에 전송/);
      assert.match(output, withTool ? /Steer #1 · 같은 턴에서 처리됨/ : /Steer #1 · 후속 턴에서 처리됨/);
      assert.equal(outcome.result?.user_message_uuids?.length, withTool ? 2 : 1);
      assert.ok(mock.log.some(entry => JSON.stringify(entry.body?.messages ?? []).includes('STEER_TEST_INPUT')));
      assert.equal(session.busy, false);
      assert.equal(session.steer('after completion'), false);
    } finally {
      release.resolve();
      await session.close();
      mock.server.closeAllConnections();
      mock.server.close();
      process.env = env;
      const root = ws.base;
      if (root.startsWith(process.env.TEMP + '\\') || root.startsWith(process.env.TMPDIR + '/')) rmSync(root, { recursive: true, force: true });
    }
  });
}
