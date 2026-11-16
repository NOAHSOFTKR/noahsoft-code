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
  const manager = new AgentTools({apiKey:TEST_KEY,cwd:ws.work,guard:new PathGuard(ws.work),model:()=> 'claude-sonnet-5-5',budgetUsd:0.5,tracker,permState:newPermissionState(),queue:new PermissionQueue(),sandbox:false});
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
    assert.ok(Math.abs(tracker.sessionCost-0.5)<1e-9, 'cancelled reservations are charged conservatively');
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
      ['default','WRITE_FILE',true,'y'], ['default','WRITE_FILE',false,'n'],
      ...(process.platform==='win32' ? [['bypass','RUN_POWERSHELL',true]] : []),
    ];
    for (const [mode,message,allowed,answer,requested,lowerTo] of scenarios) {
      const ws=tempWorkspace(); process.env.CVP_HOME=ws.home;
      const tracker=new CostTracker(undefined,20);
      const state=newPermissionState(mode);
      let asks=0;
      const manager=new AgentTools({apiKey:TEST_KEY,cwd:ws.work,guard:new PathGuard(ws.work),model:()=> 'claude-sonnet-5-5',
        budgetUsd:10,tracker,permState:state,queue:new PermissionQueue(),sandbox:false,
        ask:answer ? async()=>{asks++;return answer;} : undefined,write:()=>{}});
      try {
        if(mode==='plan') assert.throws(()=>manager.spawn('explorer','WRITE_FILE','acceptEdits'), /부모 권한/);
        const worker=manager.spawn('explorer',message,requested);
        if(lowerTo)state.mode=lowerTo;
        const result=await manager.wait(worker.agent_id,10000);
        assert.equal(result.status,'completed',JSON.stringify(result));
        if(message==='WRITE_FILE') assert.equal((await import('node:fs')).existsSync(ws.work+'/cvp-out.txt'),allowed,mode);
        else if(message==='EDIT_FILE') assert.match((await import('node:fs')).readFileSync(ws.work+'/README.md','utf8'), /# edited/);
        else if(message==='WRITE_OUTSIDE') assert.equal((await import('node:fs')).existsSync(ws.base+'/outside-write.txt'),false);
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
