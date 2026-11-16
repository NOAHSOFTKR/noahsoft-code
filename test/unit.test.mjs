import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-unit-'));
process.env.CVP_HOME = tmpHome;

const { checkApiKey, buildAgentEnv } = await import('../dist/auth.js');
const { PathGuard, isDangerousCommand, makeCanUseTool, newPermissionState } = await import('../dist/permissions.js');
const { CostTracker, BudgetExceededError, loadLedger } = await import('../dist/cost.js');
const { MarkdownStream, renderMarkdown } = await import('../dist/render.js');
const { classifyAgentError } = await import('../dist/errors.js');
const { resolveConfig, setConfigValue, loadFileConfig } = await import('../dist/config.js');

test('API 키 형식 검사: Console 키 허용, OAuth/Admin 토큰 거부', () => {
  assert.equal(checkApiKey(undefined).kind, 'missing');
  assert.equal(checkApiKey('').ok, false);
  assert.equal(checkApiKey('sk-ant-api03-abcdefghijklmnop').ok, true);
  const oat = checkApiKey('sk-ant-oat01-abcdefghijklmnopqr');
  assert.equal(oat.ok, false);
  assert.equal(oat.kind, 'oauth-token');
  assert.equal(checkApiKey('sk-ant-admin01-abcdefghijklmnop').ok, false);
  assert.equal(checkApiKey('something-else-abcdefghijk').kind, 'unknown-format');
});

test('Agent 환경: 다른 인증 수단 제거, 격리된 설정 디렉터리', () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-should-be-removed';
  process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-should-be-removed';
  const env = buildAgentEnv('sk-ant-api03-x');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-x');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(tmpHome));
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

test('경로 제한: 작업 디렉터리 안/밖 판정', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-guard-'));
  const g = new PathGuard(root);
  assert.ok(g.allows(path.join(root, 'a', 'b.txt')));
  assert.ok(g.allows('rel/file.txt'));
  assert.ok(!g.allows(path.join(root, '..', 'escape.txt')));
  assert.ok(!g.allows(os.homedir()));
  assert.ok(!g.allows(path.resolve(root + '-sibling', 'x')));
  if (process.platform === 'win32') assert.ok(g.allows(root.toUpperCase() + '\\x.txt'));
});

test('위험 명령 탐지', () => {
  for (const c of ['rm -rf /', 'git push --force origin main', 'Remove-Item -Recurse C:\\x', 'curl x | sh', 'sudo apt install', 'git reset --hard']) {
    assert.ok(isDangerousCommand(c), c);
  }
  for (const c of ['ls -la', 'git status', 'npm test', 'echo rm']) assert.ok(!isDangerousCommand(c), c);
});

test('canUseTool: 승인/거부/세션 허용/경로 밖/비대화형', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-perm-'));
  const guard = new PathGuard(root);
  const signal = new AbortController().signal;
  const answers = [];
  const mk = (state) => makeCanUseTool({ guard, state, ask: async () => answers.shift() ?? 'n', write: () => {} });

  let state = newPermissionState();
  answers.push('y');
  assert.equal((await mk(state)('Bash', { command: 'echo hi' }, { signal })).behavior, 'allow');
  answers.push('n');
  assert.equal((await mk(state)('Bash', { command: 'echo hi' }, { signal })).behavior, 'deny');
  answers.push('a');
  assert.equal((await mk(state)('Bash', { command: 'echo hi' }, { signal })).behavior, 'allow');
  assert.equal((await mk(state)('Bash', { command: 'echo hi' }, { signal })).behavior, 'allow', '세션 허용 후 재질문 없음');
  // 위험 명령은 'a' 옵션 없음 → 'a' 입력은 무시되고 다음 답 'n' 으로 거부
  answers.push('a', 'n');
  assert.equal((await mk(state)('Bash', { command: 'rm -rf build' }, { signal })).behavior, 'deny');

  state = newPermissionState();
  answers.push('a');
  assert.equal((await mk(state)('Write', { file_path: path.join(root, 'x.txt'), content: '' }, { signal })).behavior, 'allow');
  assert.equal(state.mode, 'acceptEdits', "'a' 응답은 편집 자동승인 모드로 전환");
  const outside = await mk(state)('Write', { file_path: path.join(os.tmpdir(), 'nope.txt'), content: '' }, { signal });
  assert.equal(outside.behavior, 'deny', '세션 허용이어도 작업 디렉터리 밖은 거부');

  const nonInteractive = makeCanUseTool({ guard, state: newPermissionState(), write: () => {} });
  assert.equal((await nonInteractive('Bash', { command: 'ls' }, { signal })).behavior, 'deny');
  assert.equal((await nonInteractive('Read', { file_path: path.join(root, 'a') }, { signal })).behavior, 'allow');
});

test('권한 모드: default / acceptEdits / plan / bypass', async () => {
  const { parsePermissionMode, pathGuardHook } = await import('../dist/permissions.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-mode-'));
  const guard = new PathGuard(root);
  const signal = new AbortController().signal;
  const inFile = { file_path: path.join(root, 'a.txt'), content: 'x' };
  const outFile = { file_path: path.join(os.tmpdir(), 'cvp-outside.txt'), content: 'x' };
  let asked = 0;
  const run = (mode, tool, input, interactive = true) =>
    makeCanUseTool({
      guard,
      state: newPermissionState(mode),
      ask: interactive ? async () => (asked++, 'n') : undefined,
      write: () => {},
    })(tool, input, { signal });

  // acceptEdits: 수정 자동 승인, 명령은 질문
  asked = 0;
  assert.equal((await run('acceptEdits', 'Write', inFile)).behavior, 'allow');
  assert.equal(asked, 0);
  assert.equal((await run('acceptEdits', 'Bash', { command: 'ls' })).behavior, 'deny');
  assert.equal(asked, 1, 'acceptEdits 에서도 명령은 승인 요청');

  // plan: 수정·명령 모두 질문 없이 거부
  asked = 0;
  assert.equal((await run('plan', 'Write', inFile)).behavior, 'deny');
  assert.equal((await run('plan', 'Bash', { command: 'ls' })).behavior, 'deny');
  assert.equal(asked, 0);

  // bypass: 수정·일반 명령 자동 승인, 위험 명령은 질문 / 비대화형이면 거부
  asked = 0;
  assert.equal((await run('bypass', 'Write', inFile)).behavior, 'allow');
  assert.equal((await run('bypass', 'Bash', { command: 'npm test' }, false)).behavior, 'allow');
  assert.equal(asked, 0);
  assert.equal((await run('bypass', 'Bash', { command: 'rm -rf dist' })).behavior, 'deny');
  assert.equal(asked, 1, 'bypass 여도 위험 명령은 승인 요청');
  const risky = await run('bypass', 'Bash', { command: 'git push --force' }, false);
  assert.equal(risky.behavior, 'deny');
  assert.match(risky.message, /위험 명령/);

  // 모든 모드에서 작업 디렉터리 밖은 거부
  for (const m of ['default', 'acceptEdits', 'plan', 'bypass']) {
    assert.equal((await run(m, 'Write', outFile)).behavior, 'deny', m);
  }

  // 훅: plan 은 거부, 나머지는 ask 로 canUseTool 강제
  const hookIn = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: root, session_id: 's', transcript_path: '', tool_use_id: 't' });
  const planHook = pathGuardHook(guard, newPermissionState('plan'));
  assert.equal((await planHook(hookIn('Bash', { command: 'ls' }))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await planHook(hookIn('Read', { file_path: inFile.file_path }))).continue, true, 'plan 에서도 읽기는 허용');
  const byHook = pathGuardHook(guard, newPermissionState('bypass'));
  assert.equal((await byHook(hookIn('Bash', { command: 'ls' }))).hookSpecificOutput.permissionDecision, 'ask');

  assert.equal(parsePermissionMode('accept-edits'), 'acceptEdits');
  assert.equal(parsePermissionMode('READONLY'), 'plan');
  assert.throws(() => parsePermissionMode('everything'));
});

test('비용 추적: 누적, 턴 증분, 예산 차단, 원장 저장', () => {
  const t = new CostTracker('11111111-1111-1111-1111-111111111111', 0.01);
  const mu = (cost, input) => ({ 'claude-x': { inputTokens: input, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } });
  assert.equal(t.onResult('11111111-1111-1111-1111-111111111111', 0.004, mu(0.004, 100)).toFixed(4), '0.0040');
  assert.equal(t.onResult('11111111-1111-1111-1111-111111111111', 0.007, mu(0.007, 200)).toFixed(4), '0.0030');
  assert.doesNotThrow(() => t.assertWithinBudget());
  t.onResult('11111111-1111-1111-1111-111111111111', 0.012, mu(0.012, 300));
  assert.throws(() => t.assertWithinBudget(), BudgetExceededError);
  assert.equal(loadLedger('11111111-1111-1111-1111-111111111111').costUsd.toFixed(3), '0.012');

  // 재개: SDK 누적값이 이전 합계를 포함하지 않는 경우(오프셋 적용)
  const r1 = new CostTracker('11111111-1111-1111-1111-111111111111', 1);
  r1.onResult('11111111-1111-1111-1111-111111111111', 0.002, mu(0.002, 50));
  assert.equal(r1.sessionCost.toFixed(3), '0.014');
  // 재개: SDK가 이전 합계를 이어받은 경우(오프셋 없음)
  const r2 = new CostTracker('11111111-1111-1111-1111-111111111111', 1);
  r2.onResult('11111111-1111-1111-1111-111111111111', 0.016, mu(0.016, 400));
  assert.equal(r2.sessionCost.toFixed(3), '0.016');
});

test('요청별 토큰 추적(스트림 이벤트)', () => {
  const t = new CostTracker(undefined, 1);
  t.onMessageStart('m1', 'claude-x', { input_tokens: 120, cache_read_input_tokens: 30 });
  t.onMessageDelta('m1', { output_tokens: 45 });
  const r = t.onMessageStop('m1');
  assert.deepEqual([r.inputTokens, r.outputTokens, r.cacheReadTokens], [120, 45, 30]);
  assert.equal(t.ledger.requests.length, 1);
});

test('가격표 없는 모델: config 단가로만 추정', () => {
  const t = new CostTracker(undefined, 1, { 'my-model': { input: 1, output: 2 } });
  t.onResult('s', 0, { 'my-model': { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, costBasis: 'unknown' } });
  assert.equal(t.sessionCost, 2);
  const u = new CostTracker(undefined, 1);
  u.onResult('s2', 0, { 'other': { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, costBasis: 'unknown' } });
  assert.equal(u.sessionCost, 0, '단가 없으면 임의 계산하지 않음');
});

test('스트리밍 Markdown: 닫히지 않은 코드 블록은 보류, 닫히면 렌더링', () => {
  let out = '';
  const s = new MarkdownStream((x) => (out += x));
  s.push('# 제목\n\n본문 ');
  assert.match(out, /제목/);
  const before = out;
  s.push('계속\n\n```js\nconst a = 1;\n');
  const mid = out;
  assert.ok(!mid.slice(before.length).includes('const a'), '열린 코드 펜스는 출력 보류');
  s.push('```\n');
  assert.match(out, /const a = 1/);
  s.push('마지막');
  s.flush();
  assert.match(out, /마지막/);
  assert.match(renderMarkdown('**굵게**'), /굵게/);
});

test('Agent 오류 분류', () => {
  assert.equal(classifyAgentError('billing_error').category, 'credit');
  assert.equal(classifyAgentError('rate_limit').category, 'rate_limit');
  assert.equal(classifyAgentError(undefined, 'Your credit balance is too low', 400).category, 'credit');
  assert.equal(classifyAgentError(undefined, 'nope', 403).category, 'permission');
  assert.equal(classifyAgentError('model_not_found').category, 'model_not_found');
});

test('설정 우선순위: flag > env > config', () => {
  setConfigValue('model', 'from-config');
  setConfigValue('budget', '2.5');
  assert.equal(loadFileConfig().maxSessionCostUsd, 2.5);
  delete process.env.CVP_MODEL;
  delete process.env.CVP_MAX_SESSION_COST_USD;
  assert.equal(resolveConfig({}).model, 'from-config');
  process.env.CVP_MODEL = 'from-env';
  assert.equal(resolveConfig({}).model, 'from-env');
  assert.equal(resolveConfig({ model: 'from-flag' }).model, 'from-flag');
  assert.equal(resolveConfig({}).maxSessionCostUsd, 2.5);
  process.env.CVP_MAX_SESSION_COST_USD = '0.5';
  assert.equal(resolveConfig({}).maxSessionCostUsd, 0.5);
  assert.throws(() => setConfigValue('nope', 'x'));
  assert.equal(resolveConfig({}).permissionMode, 'default');
  setConfigValue('permissionMode', 'plan');
  assert.equal(resolveConfig({}).permissionMode, 'plan');
  process.env.CVP_PERMISSION_MODE = 'acceptEdits';
  assert.equal(resolveConfig({}).permissionMode, 'acceptEdits');
  assert.equal(resolveConfig({ permissionMode: 'bypass' }).permissionMode, 'bypass');
  assert.throws(() => setConfigValue('permissionMode', 'whatever'));
  delete process.env.CVP_PERMISSION_MODE;
  delete process.env.CVP_MODEL;
  delete process.env.CVP_MAX_SESSION_COST_USD;
});


test('effort: flag > env > config, validation and SDK options', async () => {
  const old = process.env.CVP_EFFORT;
  const previous = fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8');
  try {
    delete process.env.CVP_EFFORT;
    setConfigValue('effort', 'low');
    assert.equal(resolveConfig({}).effort, 'low');
    process.env.CVP_EFFORT = 'medium';
    assert.equal(resolveConfig({}).effort, 'medium');
    assert.equal(resolveConfig({ effort: 'high' }).effort, 'high');
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(resolveConfig({ effort }).effort, effort);
    }
    assert.throws(() => setConfigValue('effort', 'invalid'), /effort/);
    assert.throws(() => resolveConfig({ effort: '' }), /effort/);
    process.env.CVP_EFFORT = 'invalid';
    assert.throws(() => resolveConfig({}), /effort/);
    delete process.env.CVP_EFFORT;
    fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ effort: 123 }));
    assert.throws(() => resolveConfig({}), /effort/);
    fs.writeFileSync(path.join(tmpHome, 'config.json'), '{}');
    assert.equal(resolveConfig({}).effort, undefined);
    const { AgentSession } = await import('../dist/agent.js');
    const oldSdkEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    try {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = 'low';
      assert.equal(buildAgentEnv('test').CLAUDE_CODE_EFFORT_LEVEL, undefined);
    } finally {
      if (oldSdkEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = oldSdkEffort;
    }
    const session = new AgentSession({ model: 'test', effort: 'high', apiKey: 'test', cwd: tmpHome,
      tracker: new CostTracker(undefined, 1), guard: new PathGuard(tmpHome),
      permState: newPermissionState('default'), sandbox: false, raw: true });
    assert.equal(session.buildOptions().effort, 'high');
  } finally {
    fs.writeFileSync(path.join(tmpHome, 'config.json'), previous);
    if (old === undefined) delete process.env.CVP_EFFORT;
    else process.env.CVP_EFFORT = old;
  }
});


test('서브에이전트 정책: 허용 도구·동기 실행·경로 및 재위임 차단', async () => {
  const { subagentDefinitions, delegationInput } = await import('../dist/subagents.js');
  const { pathGuardHook, enabledTools } = await import('../dist/permissions.js');
  assert.ok(enabledTools().includes('Agent'));
  for (const agent of Object.values(subagentDefinitions('high'))) {
    assert.ok(['Read','Glob','Grep','Write','Edit','Bash'].every((tool) => agent.tools.includes(tool)));
    assert.equal(agent.model, 'inherit');
    assert.equal(agent.effort, 'high');
  }
  const input = { subagent_type: 'explorer', prompt: 'Inspect code', description: 'Inspect', model: 'haiku', mode: 'bypassPermissions' };
  assert.deepEqual(delegationInput(input), { subagent_type: 'explorer', prompt: 'Inspect code', description: 'Inspect', run_in_background: false });
  for (const change of [{subagent_type:'fork'}, {subagent_type:'general-purpose'}, {run_in_background:true}, {isolation:'remote'}, {prompt:''}]) {
    assert.equal(delegationInput({...input, ...change}), undefined);
  }
  const hook = pathGuardHook(new PathGuard(tmpHome), newPermissionState('bypass'));
  const event = { hook_event_name:'PreToolUse', cwd:tmpHome, tool_use_id:'test', session_id:'test', transcript_path:'test' };
  const run = (tool_name, tool_input, agent_id) => hook({...event, tool_name, tool_input, agent_id}, undefined, {});
  assert.equal((await run('Agent', input)).hookSpecificOutput.updatedInput.run_in_background, false);
  assert.equal((await run('Write', {file_path:path.join(tmpHome,'x')}, 'child')).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal((await run('Agent', input, 'child')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run('Read', {file_path:path.join(tmpHome,'..','outside')}, 'child')).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await run('Read', {file_path:path.join(tmpHome,'x')}, 'child')).continue, true);
});


test('자식 비용은 부모 SDK 누적값과 재개 기준을 덮어쓰지 않음', () => {
  const usage = (n,cost) => ({inputTokens:n,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:cost});
  const child = {inputTokens:10,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0.2};
  const id = 'delegation-cost-test';
  const t = new CostTracker(undefined,10);
  t.onResult(id,0.1,{model:usage(5,0.1)});
  t.addDelegated(0.2,{model:child});
  t.onResult(id,0.3,{model:usage(15,0.3)});
  assert.ok(Math.abs(t.sessionCost-0.5)<1e-9);
  assert.equal(t.ledger.byModel.model.inputTokens,25);
  const resumed = new CostTracker(id,10);
  resumed.onResult(id,0.4,{model:usage(20,0.4)});
  assert.ok(Math.abs(resumed.sessionCost-0.6)<1e-9);
  assert.equal(resumed.ledger.byModel.model.inputTokens,30);
  const reset = new CostTracker(id,10);
  reset.onResult(id,0.1,{model:usage(5,0.1)});
  assert.ok(Math.abs(reset.sessionCost-0.7)<1e-9);
  assert.equal(reset.ledger.byModel.model.inputTokens,35);
});


test('서브에이전트 권한: 상속·상한·동적 하향·plan·비대화형 정책', async () => {
  const { childPermissionState, PermissionQueue } = await import('../dist/permissions.js');
  const parent = newPermissionState('plan');
  assert.throws(() => childPermissionState(parent,'acceptEdits'), /부모 권한/);
  assert.throws(() => childPermissionState(parent,'default'), /부모 권한/);
  const inherited = childPermissionState(parent);
  parent.mode = 'bypass';
  assert.equal(inherited.mode, 'bypass');
  const restricted = childPermissionState(parent,'acceptEdits');
  parent.mode = 'plan';
  assert.equal(restricted.mode, 'plan');
  parent.mode = 'bypass';
  assert.equal(restricted.mode,'acceptEdits');
  const guard = new PathGuard(tmpHome);
  const opts = { signal: new AbortController().signal };
  for (const [mode,write,shell] of [['plan','deny','deny'],['default','deny','deny'],['acceptEdits','allow','deny'],['bypass','allow','allow']]) {
    parent.mode = mode;
    const check = makeCanUseTool({guard,state:childPermissionState(parent),queue:new PermissionQueue(),allowModeChange:false,write:()=>{}});
    assert.equal((await check('Write',{file_path:path.join(tmpHome,'child.txt'),content:'x'},opts)).behavior,write);
    assert.equal((await check('Bash',{command:'echo child'},opts)).behavior,shell);
    assert.equal((await check('Write',{file_path:path.join(tmpHome,'..','outside')},opts)).behavior,'deny');
    assert.equal((await check('Bash',{command:'echo rm -rf example'},opts)).behavior,'deny');
  }
});

test('부모·자식 승인 직렬화 및 대기 중 권한 하향·취소', async () => {
  const { childPermissionState, PermissionQueue } = await import('../dist/permissions.js');
  const state = newPermissionState();
  const queue = new PermissionQueue();
  let release;
  let started;
  const ready = new Promise((resolve)=>started=resolve);
  let asks=0;
  const ask = () => {asks++; started(); return new Promise((resolve)=>release=resolve);};
  const deps={guard:new PathGuard(tmpHome),queue,ask,write:()=>{}};
  const parent = makeCanUseTool({...deps,state});
  const child = makeCanUseTool({...deps,state:childPermissionState(state),allowModeChange:false});
  const opts={signal:new AbortController().signal};
  const first=parent('Write',{file_path:path.join(tmpHome,'one')},opts);
  await ready;
  const abort=new AbortController();
  const second=child('Write',{file_path:path.join(tmpHome,'two')},{signal:abort.signal});
  abort.abort();
  state.mode='plan';
  release('y');
  assert.equal((await first).behavior,'deny');
  assert.equal((await second).behavior,'deny');
  assert.equal(asks,1);
});
