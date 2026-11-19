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
 const ui=new InteractiveInput();ui.insert('/status');ui.key('',enter);assert.equal(ui.panelVisible,false);assert.equal(ui.queue.length,0);
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
 assert.equal(ui.cursor, 'a😀c'.length);
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
 ui.key('', up); assert.equal(ui.draft, 'last');
 ui.key('', up); assert.equal(ui.draft, 'first');
 ui.key('', down); assert.equal(ui.draft, 'last');
 ui.key('', down); assert.equal(ui.draft, '');
 assert.deepEqual(ui.queue, queued);
 ui.close();
});
