import test from 'node:test';
import assert from 'node:assert/strict';
import {InteractiveInput} from '../dist/interactive-ui.js';
const enter={return:true}, ctrlEnter={return:true,ctrl:true}, shiftEnter={return:true,shift:true};

test('busy input keeps FIFO submissions and next draft while interrupt gets priority',async()=>{
 const ui=new InteractiveInput();let interrupted=0;ui.onInterruptPrompt=()=>interrupted++;
 ui.insert('first');ui.key('',ctrlEnter);ui.insert('second');ui.key('',ctrlEnter);
 ui.insert('urgent');ui.key('',shiftEnter);ui.insert('unfinished');
 assert.equal(interrupted,1);assert.deepEqual(ui.queue,['urgent','first','second']);
 for(const value of ['urgent','first','second'])assert.equal(await ui.readLine('> '),value);
 assert.equal(ui.draft,'unfinished');ui.close();
});
test('normal Enter, CtrlJ fallback and configurable swap dispatch correct actions',async()=>{
 const ui=new InteractiveInput();ui.insert('one');ui.key('',enter);assert.equal(ui.draft,'one\n');
 ui.key('j',{ctrl:true});assert.equal(await ui.readLine('> '),'one\n');
 let count=0;ui.onInterruptPrompt=()=>count++;ui.ctrlEnterAction='interrupt';ui.shiftEnterAction='newline';ui.enterAction='queue';
 ui.insert('two');ui.key('',shiftEnter);assert.equal(ui.draft,'two\n');ui.key('',ctrlEnter);assert.equal(count,1);
 assert.equal(await ui.readLine('> '),'two\n');ui.insert('three');ui.key('',enter);assert.equal(await ui.readLine('> '),'three');ui.close();
});
test('single line slash Enter and status toggle honor configuration',async()=>{
 const ui = new InteractiveInput();
 assert.equal(ui.panelVisible, false);
 ui.insert('/status'); ui.key('', enter);
 assert.equal(ui.panelVisible, true);
 ui.key('', {tab:true});
 assert.equal(ui.statusFocused, true);
 ui.insert('/status'); ui.key('', enter);
 assert.equal(ui.panelVisible, false);
 assert.equal(ui.statusFocused, false);
 assert.equal(ui.queue.length, 0);
 ui.insert('/help');ui.key('',enter);assert.equal(await ui.readLine('> '),'/help');
 ui.slashEnterSubmit=false;ui.insert('/help');ui.key('',enter);assert.equal(ui.draft,'/help\n');ui.close();
});
test('paste never sends, and approval answers cannot consume queue or main draft',async()=>{
 const ui=new InteractiveInput();ui.insert('queued');ui.submit();ui.insert('draft\nsecond',true);
 const answer=ui.ask('allow?');ui.insert('y\n',true);assert.equal(ui.question.draft,'');
 ui.insert('y');ui.key('',enter);assert.equal(await answer,'y');assert.equal(ui.draft,'draft\nsecond');
 assert.equal(await ui.readLine('> '),'queued');ui.key('',ctrlEnter);assert.equal(await ui.readLine('> '),'draft\nsecond');ui.close();
});
test('aborted approval preserves draft, close cancels waiters and drops queued work',async()=>{
 const ui=new InteractiveInput();ui.insert('draft');const abort=new AbortController();const answer=ui.ask('allow?',abort.signal);abort.abort();assert.equal(await answer,null);assert.equal(ui.draft,'draft');
 ui.submit();ui.close();assert.equal(await ui.readLine('> '),null);assert.deepEqual(ui.queue,[]);
 const idle=new InteractiveInput();const waiting=idle.readLine('> ');idle.close();assert.equal(await waiting,null);
});
test('Unicode cursor editing and key release never duplicate submissions',()=>{
 const ui=new InteractiveInput();ui.insert('a😀b');ui.key('',{home:true});ui.key('',{rightArrow:true});ui.key('',{delete:true});assert.equal(ui.draft,'ab');
 ui.key('',{...ctrlEnter,eventType:'release'});assert.equal(ui.queue.length,0);ui.close();
});

test('arrows preserve the preferred column across empty lines and emoji', () => {
 const ui = new InteractiveInput();
 ui.insert('a😀c\n\n12345');
 ui.key('', {leftArrow:true});
 ui.key('', {leftArrow:true});
 ui.key('', {upArrow:true});
 assert.equal(ui.cursor, 'a😀c\n'.length);
 ui.key('', {upArrow:true});
 assert.equal(ui.cursor, 'a😀'.length);
 ui.key('', {downArrow:true});
 ui.key('', {downArrow:true});
 assert.equal(ui.cursor, 'a😀c\n\n123'.length);
 ui.close();
});

test('empty Up recalls submitted prompts without sending or answering approvals', async () => {
 const ui = new InteractiveInput();
 ui.insert('first'); ui.submit();
 ui.insert('/help'); ui.submit();
 ui.insert('last'); ui.submit(true);
 const queued = [...ui.queue];
 const up = {upArrow:true}, down = {downArrow:true};
 const answer = ui.ask('allow?');
 ui.key('', up);
 assert.equal(ui.draft, '');
 ui.insert('n'); ui.key('', enter);
 assert.equal(await answer, 'n');
 assert.deepEqual(ui.queue, queued);
 for (const value of queued) assert.equal(await ui.readLine('> '), value);
 ui.key('', up); assert.equal(ui.draft, 'last');
 ui.key('', up); assert.equal(ui.draft, 'first');
 ui.key('', down); assert.equal(ui.draft, 'last');
 ui.key('', down); assert.equal(ui.draft, '');
 assert.deepEqual(ui.queue, []);
 ui.close();
});

test('arrows move across width-wrapped rows without changing submitted text', async () => {
 const ui = new InteractiveInput();
 ui.draftWidth = 4;
 ui.insert('abcdefghij');
 for (const offset of [6, 2]) {
   ui.key('', {upArrow:true});
   assert.equal(ui.cursor, offset);
 }
 for (const offset of [6, 10]) {
   ui.key('', {downArrow:true});
   assert.equal(ui.cursor, offset);
 }
 ui.key('', {upArrow:true});
 ui.insert('!');
 ui.submit();
 assert.equal(await ui.readLine('> '), 'abcdef!ghij');
 ui.key('', {upArrow:true});
 assert.equal(ui.draft, 'abcdef!ghij');
 ui.close();
});

test('workspace recalls the right queued prompt and stashes the current draft', async () => {
 const ui = new InteractiveInput();
 ui.insert('first'); ui.submit();
 ui.insert('second'); ui.submit();
 ui.insert('/ui'); ui.submit();
 assert.equal(ui.enhanced, true);
 ui.key('', {escape:true});
 ui.insert('work in progress');
 ui.openWorkspace();
 ui.key('', enter);
 assert.deepEqual(ui.workspaceEntries(), ['first', 'second']);
 assert.equal(await ui.readLine('> '), 'first');
 ui.key('', enter);
 assert.deepEqual(ui.workspaceEntries(), ['second']);
 assert.deepEqual(ui.queue, ['second']);
 ui.key('', enter);
 assert.equal(ui.draft, 'second');
 assert.deepEqual(ui.queue, []);
 ui.openWorkspace();
 for (let i = 0; i < 3; i++) ui.key('', {downArrow:true});
 ui.key('', enter);
 assert.equal(ui.draft, 'work in progress');
 ui.close();
});

test('workspace model picker preserves drafts and pauses for approvals', async () => {
 const ui = new InteractiveInput();
 ui.currentModel = () => 'claude-current';
 ui.modelIds = ['claude-other'];
 ui.insert('/ui'); ui.submit();
 ui.key('', {escape:true});
 ui.insert('draft');
 ui.openWorkspace('models');
 const answer = ui.ask('allow?');
 ui.key('', {downArrow:true});
 ui.insert('n'); ui.key('', enter);
 assert.equal(await answer, 'n');
 assert.equal(ui.workspace.index, 0);
 ui.key('', {downArrow:true});
 ui.key('', enter);
 assert.equal(ui.draft, 'draft');
 assert.equal(await ui.readLine('> '), '/model claude-other');
 ui.close();
});

test('workspace history search restores a prompt for editing without submitting it', () => {
 const ui = new InteractiveInput();
 ui.insert('find the logger'); ui.submit();
 ui.insert('check tests'); ui.submit();
 ui.insert('/ui'); ui.submit();
 ui.key('', {escape:true});
 ui.insert('keep this draft');
 ui.key('r', {ctrl:true});
 ui.insert('LOGGER');
 assert.deepEqual(ui.workspaceEntries(), ['find the logger']);
 ui.key('', enter);
 assert.equal(ui.draft, 'find the logger');
 assert.deepEqual(ui.queue, ['find the logger', 'check tests']);
 ui.close();
});

test('empty Up directly recalls the previewed queue tail without submitting', async () => {
 const ui = new InteractiveInput();
 ui.insert('keep first'); ui.submit();
 ui.insert('fix typo\nsecond row'); ui.submit();
 ui.key('', {upArrow:true});
 assert.equal(ui.draft, 'fix typo\nsecond row');
 assert.deepEqual(ui.queue, ['keep first']);
 assert.equal(await ui.readLine('> '), 'keep first');
 ui.close();
});

test('workspace mode changes report both selections for persistence', () => {
 const ui = new InteractiveInput();
 const selections = [];
 ui.onWorkspaceModeChange = enabled => selections.push(enabled);
 ui.insert('/ui'); ui.submit();
 ui.key('', {escape:true});
 ui.insert('/ui'); ui.submit();
 assert.deepEqual(selections, [true, false]);
 ui.close();
});

test('Alt+S sends a separate Steer action and keeps drafts when unavailable', async () => {
 const ui = new InteractiveInput();
 const steers = [];
 let interrupts = 0;
 const steerKey = {meta:true};
 ui.onInterruptPrompt = () => interrupts++;
 ui.insert('ordinary queued'); ui.submit();
 ui.insert('leave that file alone');
 ui.key('s', steerKey);
 assert.equal(ui.draft, 'leave that file alone');
 ui.onSteer = text => { steers.push(text); return true; };
 const approval = ui.ask('allow?');
 ui.key('s', steerKey);
 assert.deepEqual(steers, []);
 ui.insert('n'); ui.key('', enter);
 assert.equal(await approval, 'n');
 ui.key('s', {...steerKey,eventType:'repeat'});
 assert.deepEqual(steers, []);
 ui.key('s', steerKey);
 assert.deepEqual(steers, ['leave that file alone']);
 assert.deepEqual(ui.queue, ['ordinary queued']);
 assert.equal(ui.draft, '');
 assert.equal(interrupts, 0);
 assert.match(ui.transcript, /Steer · 반영 확인 대기/);
 ui.close();
});

test('inline queue recalls only the chosen item and restores the existing draft', () => {
 const ui = new InteractiveInput();
 for (const request of ['first', 'edit middle', 'last']) { ui.insert(request); ui.submit(); }
 ui.insert('original draft');
 ui.key('q', {meta:true});
 ui.key('', {upArrow:true});
 ui.key('', enter);
 assert.equal(ui.draft, 'edit middle');
 assert.deepEqual(ui.queue, ['first', 'last']);
 ui.key('', {...enter,eventType:'repeat'});
 assert.deepEqual(ui.queue, ['first', 'last']);
 ui.key('d', {meta:true});
 assert.equal(ui.draft, 'original draft');
 assert.deepEqual(ui.queue, ['first', 'last']);
 ui.close();
});

test('inline selection cannot recall the wrong item when the queue drains', async () => {
 const ui = new InteractiveInput();
 for (const request of ['first', 'middle', 'last']) { ui.insert(request); ui.submit(); }
 ui.insert('draft');
 ui.key('q', {meta:true});
 ui.key('', {upArrow:true});
 assert.equal(await ui.readLine('> '), 'first');
 ui.key('', enter);
 assert.equal(ui.draft, 'draft');
 assert.deepEqual(ui.queue, ['middle', 'last']);
 ui.key('', {escape:true});
 assert.equal(ui.queueSelection, undefined);
 const answer = ui.ask('allow?');
 ui.key('q', {meta:true});
 ui.insert('n'); ui.key('', enter);
 assert.equal(await answer, 'n');
 assert.equal(ui.draft, 'draft');
 ui.close();
});
