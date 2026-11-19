import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTools } from '../dist/agent-tools.js';
import { CostTracker } from '../dist/cost.js';
import { PathGuard, PermissionQueue, newPermissionState } from '../dist/permissions.js';
import { startMock } from './mock-server.mjs';
import { tempWorkspace, TEST_KEY } from './helpers.mjs';

test('개별 에이전트 제한: 동시 실행·실행 중 메시지·대기·종료·예산', async () => {
  const mock = await startMock();
  const ws = tempWorkspace();
  const oldBase = process.env.ANTHROPIC_BASE_URL;
  const oldHome = process.env.CVP_HOME;
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.CVP_HOME = ws.home;
  const tracker = new CostTracker(undefined, 1);
  tracker.bindSession('budget-cancel-test');
  const manager = new AgentTools({apiKey:TEST_KEY,cwd:ws.work,guard:new PathGuard(ws.work),model:()=> 'claude-sonnet-5-5',tracker,permState:newPermissionState(),queue:new PermissionQueue(),sandbox:false});
  try {
    assert.throws(()=>manager.spawn('explorer',' '), /메시지/);
    const first = manager.spawn('explorer','SLOW');
    manager.spawn('reviewer','SLOW');
    manager.spawn('explorer','SLOW');
    assert.throws(()=>manager.spawn('explorer','overflow'), /최대 3개/);
    assert.throws(()=>manager.send(first.agent_id,'follow-up'), /실행 중/);
    assert.equal((await manager.wait(first.agent_id,0)).status,'running');
    await assert.rejects(manager.wait('unknown',0), /알 수 없는/);
    await manager.close();
    assert.equal((await manager.wait(first.agent_id,0)).status,'interrupted');
    assert.equal(tracker.sessionCost,0, '중단된 실행에 예약 비용을 임의로 청구하지 않음');
    assert.equal(tracker.ledger.usageIncomplete,true);
    assert.equal(new CostTracker('budget-cancel-test',1).ledger.usageIncomplete,true);
    const status=await manager.wait(first.agent_id,0);
    assert.equal(status.remaining_budget_usd,1);
    assert.equal(status.usage_complete,false);
    assert.equal(status.budget_includes_in_flight,false);
    assert.throws(()=>manager.spawn('explorer','closed'), /종료/);
  } finally {
    await manager.close();
    mock.server.closeAllConnections(); mock.server.close();
    if(oldBase===undefined)delete process.env.ANTHROPIC_BASE_URL;else process.env.ANTHROPIC_BASE_URL=oldBase;
    if(oldHome===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=oldHome;
  }
});


test('서브에이전트 실제 SDK: 파일 수정·명령 실행과 부모 권한 상한', async () => {
  const mock = await startMock();
  const oldBase=process.env.ANTHROPIC_BASE_URL, oldHome=process.env.CVP_HOME;
  process.env.ANTHROPIC_BASE_URL=mock.url;
  try {
    const scenarios = [
      ['plan','WRITE_FILE',false], ['default','WRITE_FILE',false],
      ['bypass','WRITE_FILE',false,undefined,'plan'],
      ['bypass','WRITE_FILE',false,undefined,undefined,'plan'],
      ['acceptEdits','WRITE_FILE',true], ['acceptEdits','EDIT_FILE',true],
      ['acceptEdits','RUN_BASH',false], ['bypass','RUN_BASH',true],
      ['bypass','WRITE_OUTSIDE',false], ['bypass','DANGEROUS_COMMAND',false],
      ['fullbypass','WRITE_OUTSIDE',true], ['fullbypass','DANGEROUS_COMMAND',true],
      ['fullbypass','WRITE_OUTSIDE',false,undefined,'bypass'],
      ['default','WRITE_FILE',true,'y'], ['default','WRITE_FILE',false,'n'],
      ...(process.platform==='win32' ? [['bypass','RUN_POWERSHELL',true]] : []),
    ];
    for (const [mode,message,allowed,answer,requested,lowerTo] of scenarios) {
      const ws=tempWorkspace(); process.env.CVP_HOME=ws.home;
      const tracker=new CostTracker(undefined,20);
      const state=newPermissionState(mode,mode==='fullbypass');
      let asks=0;
      const manager=new AgentTools({apiKey:TEST_KEY,cwd:ws.work,guard:new PathGuard(ws.work),model:()=> 'claude-sonnet-5-5',
        tracker,permState:state,queue:new PermissionQueue(),sandbox:false,
        ask:answer ? async()=>{asks++;return answer;} : undefined,write:()=>{}});
      try {
        if(mode==='plan') assert.throws(()=>manager.spawn('explorer','WRITE_FILE','acceptEdits'), /부모 권한/);
        const worker=manager.spawn('explorer',message,requested);
        if(lowerTo)state.mode=lowerTo;
        const result=await manager.wait(worker.agent_id,10000);
        assert.equal(result.status,'completed',JSON.stringify(result));
        assert.equal(result.remaining_budget_usd,Math.max(0,20-tracker.sessionCost));
        if(message==='WRITE_FILE') assert.equal((await import('node:fs')).existsSync(ws.work+'/cvp-out.txt'),allowed,mode);
        else if(message==='EDIT_FILE') assert.match((await import('node:fs')).readFileSync(ws.work+'/README.md','utf8'), /# edited/);
        else if(message==='WRITE_OUTSIDE') assert.equal((await import('node:fs')).existsSync(ws.base+'/outside-write.txt'),allowed);
        else assert.equal(result.result.includes('tool_result:error'),!allowed,JSON.stringify(result));
        if(answer)assert.equal(asks,1);
      } finally {await manager.close();}
    }
  } finally {
    mock.server.closeAllConnections();mock.server.close();
    if(oldBase===undefined)delete process.env.ANTHROPIC_BASE_URL;else process.env.ANTHROPIC_BASE_URL=oldBase;
    if(oldHome===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=oldHome;
  }
});


test('서브에이전트 별도 예산 없음: 작은 세션 한도에도 결과 수집, 잔여 0 표시', async () => {
  const mock=await startMock(); const ws=tempWorkspace();
  const oldBase=process.env.ANTHROPIC_BASE_URL,oldHome=process.env.CVP_HOME;
  process.env.ANTHROPIC_BASE_URL=mock.url;process.env.CVP_HOME=ws.home;
  const tracker=new CostTracker(undefined,0.000001);
  const manager=new AgentTools({apiKey:TEST_KEY,cwd:ws.work,guard:new PathGuard(ws.work),model:()=> 'claude-sonnet-5-5',tracker,
    permState:newPermissionState(),queue:new PermissionQueue(),sandbox:false});
  try {
    const first=manager.spawn('explorer','Investigate sample');
    assert.equal(first.remaining_budget_usd,0.000001);
    const done=await manager.wait(first.agent_id,10000);
    assert.equal(done.status,'completed',JSON.stringify(done));
    assert.ok(tracker.sessionCost>tracker.limitUsd);
    assert.equal(done.remaining_budget_usd,0);assert.equal(done.usage_complete,true);
    assert.throws(()=>manager.spawn('explorer','next'), /한도/);
  } finally {
    await manager.close();mock.server.closeAllConnections();mock.server.close();
    if(oldBase===undefined)delete process.env.ANTHROPIC_BASE_URL;else process.env.ANTHROPIC_BASE_URL=oldBase;
    if(oldHome===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=oldHome;
  }
});
