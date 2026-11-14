// Mock API 기반 통합 테스트: 실제 cvp 바이너리 → Claude Agent SDK → (Mock) Messages API
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMock } from './mock-server.mjs';
import { runCli, mockEnv, tempWorkspace, TEST_KEY } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({
    inputTokens: 1000,
    outputTokens: 50,
    status: {
      'claude-nocredit': [400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'],
    },
  });
});
after(() => {
  mock.server.closeAllConnections();
  mock.server.close();
});

const mainCalls = () => mock.log.filter((r) => r.path === '/v1/messages' && Array.isArray(r.body?.tools) && r.body.tools.length);
const toolResults = () =>
  mainCalls()
    .flatMap((r) => r.body.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result');

test('단일 프롬프트(-p): 스트리밍 응답, API 키 인증, 비용 표시', async () => {
  const ws = tempWorkspace();
  const before = mock.log.length;
  const r = await runCli(['-p', '프로젝트 구조를 분석해줘'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /분석 결과/);
  assert.match(r.stdout, /console\.log/);
  assert.match(r.stderr, /예상 비용 \$0\.00250/);
  const reqs = mock.log.slice(before).filter((x) => x.path === '/v1/messages');
  assert.ok(reqs.length >= 1);
  for (const q of reqs) {
    assert.equal(q.headers['x-api-key'], TEST_KEY, 'Console API 키(x-api-key)로 인증');
    assert.equal(q.headers.authorization, undefined, 'OAuth Bearer 토큰 미사용');
  }
  assert.ok(reqs.some((q) => q.body.model === 'claude-sonnet-5-5'), '설정한 모델로 요청');
});

test('단일 프롬프트 --json: 토큰/비용 필드', async () => {
  const ws = tempWorkspace();
  const r = await runCli(['-p', 'hello', '--json'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.result, /분석 결과/);
  assert.ok(j.session_id);
  assert.equal(j.session_cost_usd.toFixed(4), '0.0025');
  assert.equal(j.usage['claude-sonnet-5-5'].inputTokens, 1000);
  assert.equal(j.usage['claude-sonnet-5-5'].outputTokens, 50);
});

test('모델 미설정 시 하드코딩 기본값 없이 안내 후 종료', async () => {
  const ws = tempWorkspace();
  const r = await runCli(['-p', 'x'], { cwd: ws.work, env: mockEnv(mock.url, ws.home, { CVP_MODEL: '' }) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /모델이 설정되지 않았습니다/);
});

test('구독 OAuth 토큰은 거부', async () => {
  const ws = tempWorkspace();
  const r = await runCli(['-p', 'x'], { cwd: ws.work, env: mockEnv(mock.url, ws.home, { ANTHROPIC_API_KEY: 'sk-ant-oat01-xxxxxxxxxxxxxxxxxxxx' }) });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /OAuth/);
});

test('cvp models / verify: 목록과 실제 권한 구분, 조직 ID 대조', async () => {
  const ws = tempWorkspace();
  const env = mockEnv(mock.url, ws.home);
  const list = await runCli(['models'], { cwd: ws.work, env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /claude-denied-model/);
  assert.match(list.stdout, /권한/);

  const verified = await runCli(['models', '--verify', '--yes'], { cwd: ws.work, env });
  assert.match(verified.stdout, /claude-sonnet-5-5\s+✔ 사용 가능/);
  assert.match(verified.stdout, /claude-denied-model\s+✖ permission \(403\)/);

  const ok = await runCli(['verify'], { cwd: ws.work, env: { ...env, CVP_EXPECTED_ORG_ID: 'org-mock-cvp' } });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /기대 조직 ID\(CVP_EXPECTED_ORG_ID\)와 일치/);
  assert.match(ok.stdout, /claude-sonnet-5-5 호출 성공/);

  const wrongOrg = await runCli(['verify'], { cwd: ws.work, env: { ...env, CVP_EXPECTED_ORG_ID: 'org-other' } });
  assert.equal(wrongOrg.code, 4);

  const denied = await runCli(['verify', 'claude-denied-model'], { cwd: ws.work, env });
  assert.equal(denied.code, 5);
  assert.match(denied.stdout, /사용 불가 \[permission 403\]/);
  assert.match(denied.stdout, /CVP 승인이 모든 모델 접근을 보장하지 않습니다/);

  const credit = await runCli(['verify', 'claude-nocredit'], { cwd: ws.work, env });
  assert.match(credit.stdout, /\[credit 400\]/);
});

test('대화형: 다중 턴, /status, /usage, /model 권한 실패 시 모델 유지', async () => {
  const ws = tempWorkspace();
  const stdin = ['첫 질문', 'BANANA 라는 단어를 기억해', 'RECALL', '/status', '/usage', '/model claude-denied-model', '/model', '/exit', ''].join('\n');
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^CVP CLI/m);
  assert.match(r.stdout, /Authentication: API Key/);
  assert.match(r.stdout, /기억: BANANA 발견/, '다중 턴 문맥 유지');
  assert.match(r.stdout, /SDK 인증 출처\s+: ANTHROPIC_API_KEY/);
  assert.match(r.stdout, /턴 수: 3/);
  assert.match(r.stdout, /claude-sonnet-5-5\s+in\s+\d+/);
  assert.match(r.stdout, /사용 불가 \[permission 403\]/);
  assert.match(r.stdout, /모델은 변경되지 않았습니다\(현재: claude-sonnet-5-5\)/);
  assert.match(r.stdout, /현재 모델: claude-sonnet-5-5/);
});

test('도구 실행 승인: Bash 실행 결과가 모델에 전달됨', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'RUN_BASH\ny\n/exit\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /허용할까요\?/);
  const tr = toolResults().slice(n);
  assert.ok(tr.some((c) => JSON.stringify(c.content).includes('hello-cvp') && !c.is_error), JSON.stringify(tr));
});

test('도구 실행 거부: 명령이 실행되지 않음', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'RUN_BASH\nn\n/exit\n' });
  assert.equal(r.code, 0, r.stderr);
  const tr = toolResults().slice(n);
  assert.ok(tr.length >= 1);
  assert.ok(tr.every((c) => !JSON.stringify(c.content).includes('hello-cvp')), '거부된 명령은 실행되지 않음');
  assert.ok(tr.some((c) => JSON.stringify(c.content).includes('거부')));
});

test('파일 쓰기 승인/거부', async () => {
  const ws = tempWorkspace();
  const target = path.join(ws.work, 'cvp-out.txt');
  await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'WRITE_FILE\nn\n/exit\n' });
  assert.ok(!fs.existsSync(target), '거부 시 파일 미생성');
  await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'WRITE_FILE\ny\n/exit\n' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'written by mock\n');
});

test('작업 디렉터리 밖 파일 읽기는 애플리케이션 정책으로 차단', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const r = await runCli(['-p', 'READ_OUTSIDE'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  assert.equal(r.code, 0, r.stderr);
  const tr = toolResults().slice(n);
  assert.ok(tr.some((c) => c.is_error && JSON.stringify(c.content).includes('작업 디렉터리 밖')), JSON.stringify(tr));
});

test('-p 비대화형에서 명령 실행은 승인 불가로 거부', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  await runCli(['-p', 'RUN_BASH'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  const tr = toolResults().slice(n);
  assert.ok(tr.some((c) => JSON.stringify(c.content).includes('비대화형')), JSON.stringify(tr));
});

test('세션 저장·목록·재개(문맥 및 누적 비용 유지)', async () => {
  const ws = tempWorkspace();
  const env = mockEnv(mock.url, ws.home);
  const first = await runCli(['-p', 'BANANA 를 기억해', '--json'], { cwd: ws.work, env });
  const { session_id: sid, session_cost_usd: c1 } = JSON.parse(first.stdout);
  assert.ok(sid);

  const list = await runCli(['sessions'], { cwd: ws.work, env });
  assert.match(list.stdout, new RegExp(sid));

  const resumed = await runCli(['--resume', sid, '-p', 'RECALL', '--json'], { cwd: ws.work, env });
  const j = JSON.parse(resumed.stdout);
  assert.match(j.result, /BANANA 발견/);
  assert.equal(j.session_id, sid);
  assert.ok(j.session_cost_usd > c1, `누적 비용 증가 ${c1} → ${j.session_cost_usd}`);

  const interactive = await runCli([], { cwd: ws.work, env, stdin: '/sessions\n/resume 1\nRECALL\n/exit\n' });
  assert.match(interactive.stdout, /세션 .* 를 재개합니다/);
  assert.match(interactive.stdout, /기억: BANANA 발견/);
});

test('/clear: 새 세션으로 문맥 초기화', async () => {
  const ws = tempWorkspace();
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'BANANA\n/clear\nRECALL\n/exit\n' });
  assert.match(r.stdout, /대화를 초기화했습니다/);
  assert.match(r.stdout, /기억: 없음/);
});

test('예산 한도: 초과 후 추가 요청 차단', async () => {
  const ws = tempWorkspace();
  const env = mockEnv(mock.url, ws.home, { CVP_MAX_SESSION_COST_USD: '0.003' });
  const r = await runCli([], { cwd: ws.work, env, stdin: '하나\n둘\n셋\n/exit\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /한도 \$0\.00\d* 에 도달하여 추가 요청을 차단합니다|SDK 예산 한도/);
  // 첫 턴 $0.0025, 둘째 턴에서 한도($0.003) 초과 → 셋째는 CLI가 전송 전 차단
  const blocked = (r.stdout.match(/추가 요청을 차단합니다/g) ?? []).length;
  assert.ok(blocked >= 1, r.stdout);

  const p = await runCli(['-p', 'x', '--budget', '0'], { cwd: ws.work, env });
  assert.equal(p.code, 6);
});

test('API 오류 처리: 권한 없는 모델 / 크레딧 부족', async () => {
  const ws = tempWorkspace();
  const denied = await runCli(['-p', 'x'], { cwd: ws.work, env: mockEnv(mock.url, ws.home, { CVP_MODEL: 'claude-denied-model' }), timeoutMs: 180_000 });
  assert.notEqual(denied.code, 0);
  assert.match(denied.stdout + denied.stderr, /permission|권한|access/i);

  const credit = await runCli(['-p', 'x'], { cwd: ws.work, env: mockEnv(mock.url, ws.home, { CVP_MODEL: 'claude-nocredit' }), timeoutMs: 180_000 });
  assert.notEqual(credit.code, 0);
  assert.match(credit.stdout + credit.stderr, /credit|크레딧/i);
});

test('권한 모드 plan: 질문 없이 명령·수정 거부, 계획 안내 전달', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const before = mainCalls().length;
  const r = await runCli(['--permission-mode', 'plan'], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'RUN_BASH\nWRITE_FILE\n/exit\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Permission mode: plan/);
  assert.match(r.stdout, /\[계획\(읽기 전용\)\] > /);
  assert.ok(!r.stdout.includes('허용할까요?'), 'plan 모드는 승인 질문 없이 거부');
  const tr = toolResults().slice(n);
  assert.ok(tr.every((c) => !JSON.stringify(c.content).includes('hello-cvp')));
  assert.ok(tr.some((c) => JSON.stringify(c.content).includes('plan(읽기 전용)')));
  assert.ok(!fs.existsSync(path.join(ws.work, 'cvp-out.txt')));
  const sent = mainCalls().slice(before).map((q) => JSON.stringify(q.body.messages));
  assert.ok(sent.some((m) => m.includes('CVP CLI 안내: 현재 plan')));
});

test('권한 모드 acceptEdits: 파일 수정은 자동, 명령은 질문', async () => {
  const ws = tempWorkspace();
  const r = await runCli([], {
    cwd: ws.work,
    env: mockEnv(mock.url, ws.home, { CVP_PERMISSION_MODE: 'acceptEdits' }),
    stdin: 'WRITE_FILE\nRUN_BASH\nn\n/exit\n',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(ws.work, 'cvp-out.txt'), 'utf8'), 'written by mock\n');
  assert.equal((r.stdout.match(/허용할까요\?/g) ?? []).length, 1, 'Bash 에 대해서만 질문');
});

test('권한 모드 bypass: -p 비대화형에서도 일반 명령 실행', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const r = await runCli(['-p', 'RUN_BASH', '--permission-mode', 'bypass'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(toolResults().slice(n).some((c) => JSON.stringify(c.content).includes('hello-cvp') && !c.is_error));
});

test('/mode: 조회·전환, bypass 확인, 잘못된 모드', async () => {
  const ws = tempWorkspace();
  const n = toolResults().length;
  const stdin = ['/mode', '/mode plan', 'RUN_BASH', '/mode bypass', 'n', '/mode nonsense', '/mode bypass', 'y', 'RUN_BASH', '/status', '/exit', ''].join('\n');
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\* default/);
  assert.match(r.stdout, /권한 모드: plan/);
  assert.match(r.stdout, /취소했습니다/);
  assert.match(r.stdout, /알 수 없는 권한 모드: nonsense/);
  assert.match(r.stdout, /권한 모드: bypass/);
  assert.match(r.stdout, /권한 모드\s+: bypass/);
  assert.ok(!r.stdout.includes('허용할까요?'), 'plan 에서는 거부, bypass 에서는 자동 승인');
  const tr = toolResults().slice(n);
  assert.equal(tr.filter((c) => JSON.stringify(c.content).includes('hello-cvp')).length, 1, 'bypass 전환 후 1회만 실행');
});

test('승인 프롬프트의 a: 편집 자동승인 모드로 전환', async () => {
  const ws = tempWorkspace();
  const r = await runCli([], { cwd: ws.work, env: mockEnv(mock.url, ws.home), stdin: 'WRITE_FILE\na\n/mode\n/exit\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /권한 모드: acceptEdits/);
  assert.match(r.stdout, /\* acceptEdits/);
  assert.ok(fs.existsSync(path.join(ws.work, 'cvp-out.txt')));
});

test('잘못된 --permission-mode 는 시작 시 오류', async () => {
  const ws = tempWorkspace();
  const r = await runCli(['-p', 'x', '--permission-mode', 'all'], { cwd: ws.work, env: mockEnv(mock.url, ws.home) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /알 수 없는 권한 모드/);
});

test('Ctrl+C 중단: interrupt() 로 진행 중 턴 중단', async () => {
  const ws = tempWorkspace();
  process.env.CVP_HOME = ws.home;
  const { AgentSession } = await import('../dist/agent.js');
  const { CostTracker } = await import('../dist/cost.js');
  const { PathGuard, newPermissionState } = await import('../dist/permissions.js');
  const saved = { ...process.env };
  Object.assign(process.env, mockEnv(mock.url, ws.home));
  let out = '';
  const s = new AgentSession({
    apiKey: TEST_KEY,
    model: 'claude-sonnet-5-5',
    cwd: ws.work,
    tracker: new CostTracker(undefined, 1),
    guard: new PathGuard(ws.work),
    permState: newPermissionState(),
    sandbox: false,
    raw: true,
    out: (x) => (out += x),
  });
  const t0 = Date.now();
  const p = s.send('SLOW');
  await new Promise((r) => {
    const iv = setInterval(() => {
      if (out.includes('tick3')) {
        clearInterval(iv);
        r();
      }
    }, 50);
  });
  await s.interrupt();
  const o = await p;
  const elapsed = Date.now() - t0;
  await s.close();
  process.env = saved;
  assert.ok(elapsed < 15_000, `중단까지 ${elapsed}ms (전체 스트림은 20초)`);
  assert.ok(!out.includes('tick150'));
  assert.ok(o.result, '중단 후에도 결과 메시지 수신');
  assert.equal(o.error, '사용자가 실행을 중단했습니다.');
});
