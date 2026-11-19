import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeStatus } from '../dist/runtime-status.js';

test('압축 상태·SDK 임계 여유·비활성·모델 전환 추정 무효화',()=>{
 const s=new RuntimeStatus();assert.equal(s.snapshot().context,null);
 s.observeContext({totalTokens:100,maxTokens:1000,rawMaxTokens:1000,autoCompactThreshold:900,isAutoCompactEnabled:true});
 assert.equal(s.snapshot().context.remaining_tokens,800);
 s.observeSystem({subtype:'status',status:'compacting'});assert.equal(s.snapshot().autocompact.state,'compacting');
 s.observeSystem({subtype:'compact_boundary',compact_metadata:{trigger:'auto',pre_tokens:900,post_tokens:200}});
 assert.equal(s.snapshot().autocompact.count,1);assert.equal(s.snapshot().context,null);
 s.observeContext({totalTokens:100,rawMaxTokens:1000,autoCompactThreshold:900,isAutoCompactEnabled:false});
 assert.equal(s.snapshot().context.remaining_tokens,null);s.invalidate();assert.equal(s.snapshot().context,null);
});

test('캐시 실측·재사용 추정·기본 TTL·혼합 TTL·만료',()=>{
 const s=new RuntimeStatus();const at=1000000;
 s.observeCache({input_tokens:100,cache_read_input_tokens:100,cache_creation_input_tokens:0},at);
 assert.equal(s.snapshot(at).cache.observed_read_ratio,0.5);assert.equal(s.snapshot(at).cache.reuse_estimate,'likely_warm');
 assert.equal(s.snapshot(at+300001).cache.reuse_estimate,'possibly_expired');
 s.observeCache({input_tokens:10,cache_creation_input_tokens:50,cache_creation:{ephemeral_1h_input_tokens:50,ephemeral_5m_input_tokens:0}},at);
 assert.equal(s.snapshot(at).cache.estimated_ttl_remaining_seconds,3600);assert.equal(s.snapshot(at).cache.ttl_seconds_assumed,null);
 s.observeCache({input_tokens:10,cache_creation_input_tokens:50,cache_creation:{ephemeral_1h_input_tokens:25,ephemeral_5m_input_tokens:25}},at);
 assert.equal(s.snapshot(at).cache.estimated_ttl_remaining_seconds,300);
 s.invalidate();assert.equal(s.snapshot(at).cache.reuse_estimate,'unknown');
});


test('캐시 delta 최종값은 원장의 실측값과 일치',async()=>{
 const {AgentSession}=await import('../dist/agent.js');const {CostTracker}=await import('../dist/cost.js');const {PathGuard,newPermissionState}=await import('../dist/permissions.js');
 const t=new CostTracker(undefined,1);const session=new AgentSession({apiKey:'test',model:'test',cwd:process.cwd(),tracker:t,guard:new PathGuard(process.cwd()),permState:newPermissionState(),sandbox:false,raw:true,out:()=>{}});
 session.handleStream({type:'message_start',message:{id:'x',model:'test',usage:{input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
 session.handleStream({type:'message_delta',usage:{cache_read_input_tokens:500,cache_creation_input_tokens:200}});session.handleStream({type:'message_stop'});
 assert.equal(session.runtimeStatus.snapshot().cache.read_tokens,500);assert.equal(session.runtimeStatus.snapshot().cache.write_tokens,200);assert.equal(t.ledger.requests[0].cacheReadTokens,500);await session.close();
});


test('백그라운드 응답은 다른 사용자 요청을 완료시키지 않음',async()=>{
 const {AgentSession}=await import('../dist/agent.js');const {CostTracker}=await import('../dist/cost.js');const {PathGuard,newPermissionState}=await import('../dist/permissions.js');
 const {tempWorkspace}=await import('./helpers.mjs');const ws=tempWorkspace(),oldHome=process.env.CVP_HOME;process.env.CVP_HOME=ws.home;
 const session=new AgentSession({apiKey:'test',model:'test',cwd:process.cwd(),tracker:new CostTracker(undefined,5),guard:new PathGuard(process.cwd()),permState:newPermissionState(),sandbox:false,raw:true,out:()=>{}});
 try {let resolved=false;session.pending={id:'current',resolve:()=>{resolved=true;}};session.busy=true;
 const result={type:'result',subtype:'success',session_id:'background-result-test',total_cost_usd:0,modelUsage:{},result:'old',is_error:false,user_message_uuid:'old'};
 await session.handleResult(result);assert.equal(resolved,false);assert.equal(session.busy,true);
 await session.handleResult({...result,user_message_uuid:undefined,queued_turn_count:0});assert.equal(resolved,false,'UUID 없는 백그라운드 응답은 대기 입력이 아직 SDK 큐에 없어도 새 요청을 끝내지 않음');assert.equal(session.busy,true);
 await session.handleResult({...result,user_message_uuid:'current'});assert.equal(resolved,true);assert.equal(session.busy,false);
 resolved=false;session.pending={id:'startup',resolve:()=>{resolved=true;}};session.busy=true;
 await session.handleResult({...result,subtype:'error_during_execution',user_message_uuid:undefined,startup_failure_reason:'config_file_invalid',errors:['invalid config']});assert.equal(resolved,true,'세션 시작 실패는 UUID 없이도 요청을 종료함');assert.equal(session.busy,false);
 }finally{await session.close();if(oldHome===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=oldHome;}
});
