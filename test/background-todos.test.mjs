import {spawnSync} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import { BackgroundTasks } from '../dist/background-tasks.js';import { TodoList } from '../dist/todos.js';
import { AgentSession } from '../dist/agent.js';import { CostTracker } from '../dist/cost.js';import { PathGuard,newPermissionState } from '../dist/permissions.js';
import { startMock } from './mock-server.mjs';import { tempWorkspace,mockEnv,TEST_KEY,runCli } from './helpers.mjs';

test('Todo 진행·owner 분리·저장 재개·검증·제어문자 제거',()=>{
 const ws=tempWorkspace(),old=process.env.CVP_HOME;process.env.CVP_HOME=ws.home;
 try{const t=new TodoList();t.bind('todo-session');t.update('main',[{content:'one',status:'in_progress'}]);t.update('child',[{content:'two',status:'completed'}]);
 assert.equal(t.snapshot()[0].completed,0);assert.equal(t.snapshot()[1].completed,1);
 const resumed=new TodoList();resumed.bind('todo-session');assert.equal(resumed.snapshot().length,2);
 assert.throws(()=>t.update('main',[{content:'bad',status:'invalid'}]));t.update('\x1b[31mowner',[{content:'\x1b[31mtext',status:'pending'}]);assert.ok(!t.lines().join('').includes('\x1b'));
 }finally{if(old===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=old;}
});

test('작업 이벤트: 패치·오래된 run 거부·전체목록·출력·중단·보관상한',async()=>{
 const tasks=new BackgroundTasks(),ws=tempWorkspace();let stopped=0;const stop=async()=>{stopped++;};
 tasks.observe('main',{subtype:'task_started',task_id:'job',run_id:'b',description:'old',is_backgrounded:true},stop);
 tasks.observe('main',{subtype:'task_updated',task_id:'job',run_id:'b',patch:{status:'killed',description:'new'}},stop);
 assert.equal(tasks.list()[0].status,'killed');assert.equal(tasks.list()[0].description,'new');
 tasks.observe('main',{subtype:'task_started',task_id:'job',run_id:'a'},stop);assert.equal(tasks.list()[0].status,'killed');
 tasks.observe('main',{subtype:'background_tasks_changed',tasks:[{task_id:'live',task_type:'local_bash',description:'live'}]},stop);
 assert.equal(tasks.list().find(t=>t.task_id==='live').status,'running');
 const output=path.join(ws.work,'out.txt');fs.writeFileSync(output,'safe-output');tasks.observe('main',{subtype:'task_notification',task_id:'live',status:'completed',output_file:output},stop);
 assert.equal(tasks.read('live').output,'safe-output');assert.throws(()=>tasks.read('../secret'));
 for(let i=0;i<105;i++)tasks.observe('main',{subtype:'task_started',task_id:`active${i}`},stop);
 assert.ok(tasks.has('active104'));await tasks.stop('active104');assert.equal(stopped,1);
 tasks.observe('main',{subtype:'background_tasks_changed',tasks:[]},stop);
 assert.equal(tasks.list().find(t=>t.task_id==='active1').status,'running','foreground unaffected by background set');
});

test('실제 SDK: 자동압축 summary·캐시토큰·todo 툴·수동 compact',async()=>{
 const m=await startMock({cacheReadTokens:100,cacheWriteTokens:20}),ws=tempWorkspace(),saved={...process.env};Object.assign(process.env,mockEnv(m.url,ws.home));
 const tracker=new CostTracker(undefined,5);const s=new AgentSession({apiKey:TEST_KEY,model:'claude-sonnet-5-5',cwd:ws.work,tracker,guard:new PathGuard(ws.work),permState:newPermissionState('plan'),sandbox:false,raw:true,out:()=>{}});
 try{const outcome=await s.send('TODO_UPDATE');assert.equal(outcome.error,undefined);assert.equal(s.todos.snapshot()[0]?.completed,2);
 const snapshot=s.runtimeStatus.snapshot();assert.equal(snapshot.autocompact.enabled,true);assert.ok(snapshot.context.window_tokens>0);assert.equal(snapshot.cache.read_tokens,100);assert.equal(snapshot.cache.write_tokens,20);
 assert.equal(m.log.filter(x=>x.path.includes('count_tokens')).length,0);
 const compact=await s.send('/compact keep decisions');assert.equal(compact.error,undefined);assert.equal(s.runtimeStatus.snapshot().autocompact.last?.trigger,'manual');
 }finally{await s.close();m.server.closeAllConnections();m.server.close();process.env=saved;}
});

test('실제 SDK: 백그라운드 명령은 부모 턴 후 유지·결과 조회·종료',async()=>{
 const m=await startMock(),ws=tempWorkspace(),saved={...process.env};Object.assign(process.env,mockEnv(m.url,ws.home));
 const s=new AgentSession({apiKey:TEST_KEY,model:'claude-sonnet-5-5',cwd:ws.work,tracker:new CostTracker(undefined,5),guard:new PathGuard(ws.work),permState:newPermissionState('bypass'),sandbox:false,raw:true,out:()=>{}});
 try{for(const prompt of ['RUN_BACKGROUND',...(process.platform==='win32'?['RUN_BACKGROUND_POWERSHELL']:[])]){
 const previous=new Set(s.listTasks().map(t=>t.task_id));const result=await s.send(prompt);assert.equal(result.error,undefined);
 const task=s.listTasks().find(t=>t.type==='command'&&!previous.has(t.task_id));assert.ok(task,JSON.stringify(s.listTasks()));const id=task.task_id;
 let done=await s.taskStatus(id);const until=Date.now()+10000;while(Date.now()<until&&!(done.output??'').includes('background-ready')){await new Promise(r=>setTimeout(r,100));done=await s.taskStatus(id);}assert.ok(['completed','ended'].includes(done.status),JSON.stringify(done));assert.match(done.output??'',/background-ready/);
 }await assert.rejects(s.stopTask('unknown'));
 }finally{await s.close();m.server.closeAllConnections();m.server.close();process.env=saved;}
});

test('CLI: runtime JSON와 /todos /tasks /context 표시',async()=>{
 const m=await startMock(),ws=tempWorkspace(),env=mockEnv(m.url,ws.home);
 try{const r=await runCli(['-p','TODO_UPDATE','--json'],{cwd:ws.work,env});assert.equal(r.code,0,r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.todos[0].completed,2);assert.equal(data.runtime_status.scope,'main_session');
 const repl=await runCli([],{cwd:ws.work,env,stdin:'hello\n/context\n/cache\n/todos\n/tasks\n/exit\n'});assert.equal(repl.code,0,repl.stderr);assert.match(repl.stdout,/AutoCompact:/);assert.match(repl.stdout,/Cache:/);assert.match(repl.stdout,/Todo:/);
 }finally{m.server.closeAllConnections();m.server.close();}
});


test('실제 SDK: 백그라운드 명령과 에이전트 명시 중단',async()=>{
 const m=await startMock(),ws=tempWorkspace(),saved={...process.env};Object.assign(process.env,mockEnv(m.url,ws.home));
 const s=new AgentSession({apiKey:TEST_KEY,model:'claude-sonnet-5-5',subagentTools:true,cwd:ws.work,tracker:new CostTracker(undefined,5),guard:new PathGuard(ws.work),permState:newPermissionState('bypass'),sandbox:false,raw:true,out:()=>{}});
 try{await s.send('RUN_BACKGROUND_LONG');const command=s.listTasks().find(t=>t.type==='command');assert.ok(command);assert.equal((await s.stopTask(command.task_id)).status,'stopped');
 await s.send('RUN_BACKGROUND_AGENT');const agent=s.listTasks().find(t=>t.type==='agent');assert.ok(agent?.background,JSON.stringify(s.listTasks()));assert.equal(agent.status,'running');
 assert.equal((await s.stopTask(agent.task_id)).status,'interrupted');
 }finally{await s.close();m.server.closeAllConnections();m.server.close();process.env=saved;}
});


test('작업 출력은 FIFO를 읽으며 멈추지 않고 거부', {skip:process.platform==='win32'},()=>{
 const ws=tempWorkspace(),file=path.join(ws.work,'output.fifo');
 const script=`import {execFileSync} from 'node:child_process';import {BackgroundTasks} from ${JSON.stringify(new URL('../dist/background-tasks.js',import.meta.url).href)};
 execFileSync('mkfifo',[${JSON.stringify(file)}]);const tasks=new BackgroundTasks();tasks.observe('main',{subtype:'task_notification',task_id:'fifo',status:'completed',output_file:${JSON.stringify(file)}},async()=>{});console.log(JSON.stringify(tasks.read('fifo')));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000});
 assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,child.stderr);assert.match(JSON.parse(child.stdout).output,/출력 조회 불가/);
});
