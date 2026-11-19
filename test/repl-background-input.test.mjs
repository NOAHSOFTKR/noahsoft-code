import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {PassThrough} from 'node:stream';
import {runRepl} from '../dist/repl.js';import {resolveConfig} from '../dist/config.js';import {startMock} from './mock-server.mjs';import {tempWorkspace,mockEnv,TEST_KEY} from './helpers.mjs';

for(const term of ['xterm-256color','dumb'])test(`TTY ${term}: background 승인 답변과 부모 입력 초안을 분리·복원`,async()=>{
 const mock=await startMock(),ws=tempWorkspace(),saved={...process.env};Object.assign(process.env,mockEnv(mock.url,ws.home));process.env.TERM=term;
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=(mode)=>{input.isRaw=mode;return input;};
 const output=new PassThrough();output.isTTY=true;output.columns=100;let screen='';output.on('data',data=>screen+=data);
 const oldInput=Object.getOwnPropertyDescriptor(process,'stdin'),oldOutput=Object.getOwnPropertyDescriptor(process,'stdout');
 Object.defineProperty(process,'stdin',{configurable:true,value:input});Object.defineProperty(process,'stdout',{configurable:true,value:output});
 let running;
 const waitFor=async(check)=>{const until=Date.now()+20000;while(!check()){if(Date.now()>until)throw new Error('TTY flow timeout: '+screen.slice(-1200));await new Promise(r=>setTimeout(r,20));}};
 try{
  const cfg=resolveConfig({model:'claude-sonnet-5-5',cwd:ws.work,budget:5,subagentTools:true});
  running=runRepl({apiKey:TEST_KEY,cfg,model:cfg.model,raw:true});await waitFor(()=>screen.includes('> '));
  input.write('RUN_BACKGROUND_AGENT_WRITE');input.write('\x1b[13;5u');
  await waitFor(()=>screen.includes('AutoCompact:'));input.write('draft text');
  await waitFor(()=>screen.includes('허용할까요?'));input.write('y');await new Promise(r=>setTimeout(r,30));input.write('\r');
  await waitFor(()=>fs.existsSync(ws.work+'/cvp-out.txt'));
  input.write('\x1b[13;5u');await waitFor(()=>mock.log.some(x=>x.body?.messages?.some(m=>m.role==='user'&&m.content==='draft text')));
  await waitFor(()=>screen.split('AutoCompact:').length>=3);
  input.write('/exit');input.write('\x1b[13;5u');await running;
  assert.ok(!mock.log.some(x=>x.body?.messages?.some(m=>m.role==='user'&&m.content==='y')),'승인 y가 새 프롬프트로 전송되지 않음');
 }finally{
  input.end();if(running)await Promise.race([running.catch(()=>{}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('REPL did not close')),5000))]);
  Object.defineProperty(process,'stdin',oldInput);Object.defineProperty(process,'stdout',oldOutput);process.env=saved;
  mock.server.closeAllConnections();mock.server.close();
 }
});

test('Ink: busy 입력 FIFO와 Shift+Enter 중단 후 우선 전송, legacy Ctrl+Enter', async()=>{
 const mock=await startMock(),ws=tempWorkspace(),saved={...process.env};Object.assign(process.env,mockEnv(mock.url,ws.home));process.env.TERM='xterm-256color';
 const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=mode=>{input.isRaw=mode;return input;};
 const output=new PassThrough();output.isTTY=true;output.columns=100;output.rows=30;let screen='';output.on('data',data=>screen+=data);
 const oldInput=Object.getOwnPropertyDescriptor(process,'stdin'),oldOutput=Object.getOwnPropertyDescriptor(process,'stdout');
 Object.defineProperty(process,'stdin',{configurable:true,value:input});Object.defineProperty(process,'stdout',{configurable:true,value:output});
 let running;
 const waitFor=async(check)=>{const until=Date.now()+20000;while(!check()){if(Date.now()>until)throw new Error('busy flow timeout: '+screen.slice(-1500));await new Promise(r=>setTimeout(r,20));}};
 const prompts=()=>mock.log.filter(x=>x.body?.messages).map(x=>x.body.messages.findLast(m=>m.role==='user')?.content).map(x=>typeof x==='string'?x:Array.isArray(x)?x.filter(b=>b.type==='text').map(b=>b.text).join('\n'):'').map(text=>['PRIORITY_NOW','QUEUED_NEXT','SLOW'].find(marker=>text.includes(marker))??text);
 try{
  const cfg=resolveConfig({model:'claude-sonnet-5-5',cwd:ws.work,budget:5,subagentTools:true});
  running=runRepl({apiKey:TEST_KEY,cfg,model:cfg.model,raw:true});await waitFor(()=>screen.includes('> '));
  input.write('SLOW');input.write('\x1b[27;5;13~');await waitFor(()=>prompts().includes('SLOW'));
  input.write('QUEUED_NEXT');input.write('\x1b[13;5u');await waitFor(()=>screen.includes('전송 대기 1개'));
  assert.ok(!prompts().includes('QUEUED_NEXT'),'실행 중에는 후속 입력을 큐에 보관');
  input.write('PRIORITY_NOW');input.write('\x1b[27;2;13~');
  await waitFor(()=>prompts().includes('QUEUED_NEXT'));
  const sent=prompts();assert.ok(sent.indexOf('PRIORITY_NOW')>sent.indexOf('SLOW'));assert.ok(sent.indexOf('PRIORITY_NOW')<sent.indexOf('QUEUED_NEXT'));
  input.write('/exit');await new Promise(r=>setTimeout(r,30));input.write('\r');await running;
 }finally{
  input.write('\x04');input.end();if(running)await Promise.race([running.catch(()=>{}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('busy REPL did not close')),5000))]);
  Object.defineProperty(process,'stdin',oldInput);Object.defineProperty(process,'stdout',oldOutput);process.env=saved;mock.server.closeAllConnections();mock.server.close();
 }
});
