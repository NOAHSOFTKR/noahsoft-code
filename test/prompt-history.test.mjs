import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {InteractiveInput} from '../dist/interactive-ui.js';
import {PromptHistory} from '../dist/prompt-history.js';

test('new interactive sessions recall only submitted prompts for their workspace', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-history-'));
 const home = process.env.CVP_HOME;
 process.env.CVP_HOME = root;
 try {
   const cwd = path.join(root, 'workspace');
   const first = new InteractiveInput(new PromptHistory(cwd));
   first.insert('hello\nworld'); first.submit();
   first.insert('/help'); first.submit();
   const approval = first.ask('allow?');
   first.insert('n'); first.submit();
   assert.equal(await approval, 'n');
   first.insert('unsent'); first.close();

   const next = new InteractiveInput(new PromptHistory(cwd));
   next.key('', {upArrow:true});
   assert.equal(next.draft, 'hello\nworld');
   assert.deepEqual(next.queue, []);
   next.key('', {upArrow:true});
   next.key('', {upArrow:true});
   assert.equal(next.draft, 'hello\nworld');

   const other = new InteractiveInput(new PromptHistory(path.join(root, 'other')));
   other.key('', {upArrow:true});
   assert.equal(other.draft, '');
   next.close(); other.close();
 } finally {
   if (home === undefined) delete process.env.CVP_HOME;
   else process.env.CVP_HOME = home;
   fs.rmSync(root, {recursive:true, force:true});
 }
});

test('persistent history keeps the latest 100 entries and recovers from corrupt data', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp-history-'));
 const home = process.env.CVP_HOME;
 process.env.CVP_HOME = root;
 try {
   const history = new PromptHistory(root);
   history.append('seed');
   const dir = path.join(root, 'prompt-history');
   const file = path.join(dir, fs.readdirSync(dir)[0]);
   fs.writeFileSync(file, '{invalid');
   assert.deepEqual(history.load(), []);
   for (let i = 0; i < 101; i++) history.append('prompt ' + i);
   assert.equal(history.load().length, 100);
   assert.equal(history.load()[0], 'prompt 1');
   assert.equal(history.load().at(-1), 'prompt 100');
   history.append('x'.repeat(1024 * 1024));
   assert.equal(history.load().at(-1), 'prompt 100');
 } finally {
   if (home === undefined) delete process.env.CVP_HOME;
   else process.env.CVP_HOME = home;
   fs.rmSync(root, {recursive:true, force:true});
 }
});
