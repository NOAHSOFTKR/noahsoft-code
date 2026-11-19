import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tempWorkspace} from './helpers.mjs';
import {resolveConfig,setConfigValue,unsetConfigValue,saveFileConfig} from '../dist/config.js';

test('Enter key actions: defaults, persisted customization and invalid configuration',()=>{
 const saved=process.env.CVP_HOME, ws=tempWorkspace(); process.env.CVP_HOME=ws.home;
 try {
  let cfg=resolveConfig({});
  assert.equal(cfg.workspaceMode, false);
  setConfigValue('workspaceMode','true');
  assert.equal(resolveConfig({}).workspaceMode, true);
  setConfigValue('workspaceMode','false');
  assert.equal(resolveConfig({}).workspaceMode, false);
  assert.deepEqual([cfg.enterAction,cfg.ctrlEnterAction,cfg.shiftEnterAction,cfg.slashEnterSubmit],['newline','queue','interrupt',true]);
  setConfigValue('enterAction','queue');setConfigValue('ctrlEnterAction','interrupt');setConfigValue('shiftEnterAction','newline');setConfigValue('slashEnterSubmit','false');
  cfg=resolveConfig({});
  assert.deepEqual([cfg.enterAction,cfg.ctrlEnterAction,cfg.shiftEnterAction,cfg.slashEnterSubmit],['queue','interrupt','newline',false]);
  assert.throws(()=>setConfigValue('enterAction','execute'),/newline/);
  assert.throws(()=>setConfigValue('slashEnterSubmit','yes'),/true/);
  saveFileConfig({enterAction:'newline',ctrlEnterAction:'newline',shiftEnterAction:'newline'});
  assert.throws(()=>resolveConfig({}),/적어도 하나/);
  unsetConfigValue('ctrlEnterAction');assert.equal(resolveConfig({}).ctrlEnterAction,'queue');
  saveFileConfig({enterAction:'invalid'});assert.throws(()=>resolveConfig({}),/newline/);
  saveFileConfig({slashEnterSubmit:'false'});assert.throws(()=>resolveConfig({}),/true/);
 }finally{if(saved===undefined)delete process.env.CVP_HOME;else process.env.CVP_HOME=saved;fs.rmSync(ws.base,{recursive:true,force:true});}
});
import {runCli} from './helpers.mjs';
test('config command can repair manually invalid Enter mapping',async()=>{
 const ws=tempWorkspace();fs.mkdirSync(ws.home,{recursive:true});
 fs.writeFileSync(ws.home+'/config.json',JSON.stringify({enterAction:'newline',ctrlEnterAction:'newline',shiftEnterAction:'newline'}));
 try{
  const result=await runCli(['config','unset','ctrlEnterAction'],{cwd:ws.work,env:{CVP_HOME:ws.home}});
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(ws.home+'/config.json','utf8')).ctrlEnterAction,undefined);
 }finally{fs.rmSync(ws.base,{recursive:true,force:true});}
});
