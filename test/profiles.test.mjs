import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempWorkspace, runCli, mockEnv } from './helpers.mjs';
import { startMock } from './mock-server.mjs';
import { loadProfile, saveProfile, profilePath, listProfiles, deleteProfile } from '../dist/profiles.js';
import { resolveConfig } from '../dist/config.js';

test('프로필 저장·검증·우선순위: 실행 설정만 저장, 비밀/감독 제외',()=>{
  const ws=tempWorkspace();const saved={...process.env};process.env.CVP_HOME=ws.home;
  try {
    process.env.CVP_MODEL='env-model';process.env.CVP_EFFORT='medium';
    const cfg=resolveConfig({model:'profile-model',effort:'high',permissionMode:'fullbypass',budget:2,cwd:ws.work,supervised:true});
    saveProfile('개발',cfg);
    const raw=JSON.parse(fs.readFileSync(profilePath('개발'),'utf8'));
    assert.deepEqual(Object.keys(raw).sort(),['version','model','effort','permissionMode','maxSessionCostUsd','cwd'].sort());
    const profile=loadProfile('개발');const applied=resolveConfig({},profile);
    assert.equal(applied.model,'profile-model');assert.equal(applied.modelSource,'profile');assert.equal(applied.effort,'high');
    assert.equal(applied.supervised,false);assert.equal(applied.permissionMode,'fullbypass');assert.equal(applied.cwd,ws.work);
    const override=resolveConfig({model:'flag-model',budget:3,permissionMode:'plan',effort:'low'},profile);
    assert.equal(override.model,'flag-model');assert.equal(override.maxSessionCostUsd,3);assert.equal(override.permissionMode,'plan');assert.equal(override.effort,'low');
    assert.deepEqual(listProfiles(),['개발']);
    for(const name of ['../escape','a/b','CON','COM¹','a.',' bad','..'])assert.throws(()=>profilePath(name));
    fs.writeFileSync(profilePath('invalid'),'{}');assert.throws(()=>loadProfile('invalid'),/프로필/);
    fs.writeFileSync(profilePath('invalid'),JSON.stringify({...profile,supervised:true}));assert.throws(()=>loadProfile('invalid'),/프로필/);
    deleteProfile('개발');assert.ok(!listProfiles().includes('개발'));
  } finally {process.env=saved;}
});

test('프로필 CLI: 저장·목록·실행·cwd/옵션 덮어쓰기·감독 확인·삭제',async()=>{
  const mock=await startMock();const ws=tempWorkspace();const nested=path.join(ws.work,'nested');fs.mkdirSync(nested);
  const env=mockEnv(mock.url,ws.home);
  try {
    const save=await runCli(['profile','save','dev','--model','profile-model','--effort','high','--permission-mode','plan','--budget','2','--cwd','nested'],{cwd:ws.work,env});
    assert.equal(save.code,0,save.stderr);
    const show=await runCli(['profile','show','dev'],{cwd:ws.work,env});const profile=JSON.parse(show.stdout);
    assert.equal(profile.cwd,nested);assert.equal(profile.model,'profile-model');
    assert.match((await runCli(['profile','list'],{cwd:ws.work,env})).stdout,/dev/);
    const interactive=await runCli(['profile','run','dev'],{cwd:ws.work,env,stdin:'/status\n/exit\n'});
    assert.equal(interactive.code,0,interactive.stderr);assert.ok(interactive.stdout.includes(nested));assert.ok(interactive.stdout.includes('profile-model'));
    const run=await runCli(['profile','run','dev','--model','claude-sonnet-5-5','--cwd',ws.work,'-p','RECALL','--json'],{cwd:ws.work,env});
    assert.equal(run.code,0,run.stderr);assert.equal(JSON.parse(run.stdout).model,'claude-sonnet-5-5');
    const fullSave=await runCli(['profile','save','full','--permission-mode','fullbypass'],{cwd:ws.work,env});assert.equal(fullSave.code,0,fullSave.stderr);
    const denied=await runCli(['profile','run','full','-p','test'],{cwd:ws.work,env});assert.notEqual(denied.code,0);assert.match(denied.stderr,/supervised/);
    const allowed=await runCli(['profile','run','full','--supervised','-p','test','--json'],{cwd:ws.work,env});assert.equal(allowed.code,0,allowed.stderr);
    const missing=await runCli(['profile','run','missing'],{cwd:ws.work,env});assert.notEqual(missing.code,0);
    const del=await runCli(['profile','delete','dev'],{cwd:ws.work,env});assert.equal(del.code,0,del.stderr);
  } finally {mock.server.closeAllConnections();mock.server.close();}
});
