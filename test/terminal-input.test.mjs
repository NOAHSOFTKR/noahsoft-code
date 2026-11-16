import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { TerminalInput } from '../dist/terminal-input.js';

function editor() {
  const source=new PassThrough(); source.isTTY=true; source.isRaw=false;
  source.setRawMode=(mode)=>{source.isRaw=mode;return source;};
  const output=new PassThrough(); output.columns=100;
  let screen='';output.on('data',(d)=>screen+=d);
  let main=true;
  const input=new TerminalInput(source,output,()=>main);
  const rl=readline.createInterface({input,output,terminal:true,historySize:500});
  const messages=[];
  rl.on('line',(line)=>{const text=input.acceptLine(line);if(text!==undefined)messages.push(text);else {rl.setPrompt('… ');rl.prompt();}});
  rl.setPrompt('> ');rl.prompt();
  return {source,rl,input,messages,setMain:(value)=>main=value,screen:()=>screen,close:()=>{rl.close();input.dispose();}};
}

test('TTY: Enter accumulates lines, Ctrl+Enter submits exactly once with Unicode order',()=>{
  const e=editor();
  try {
    e.source.write('첫째 😀');e.source.write('\r');e.source.write('둘째');
    assert.deepEqual(e.messages,[]);
    e.source.write('\n');assert.deepEqual(e.messages,['첫째 😀\n둘째']);
  } finally {e.close();}
});

test('TTY: bracketed paste preserves blank lines and trailing newline, waits for Ctrl+Enter',()=>{
  const e=editor();
  try {
    e.source.write('prefix ');e.source.write('\x1b[200~첫째\r\n\r\n둘째\n\x1b[201~');
    assert.deepEqual(e.messages,[]);
    e.source.write('\x1b[13;5u');
    assert.deepEqual(e.messages,['prefix 첫째\n\n둘째\n']);
  } finally {e.close();}
});

test('TTY: split paste markers and modified Ctrl+Enter sequences',()=>{
  const e=editor();
  try {
    for(const c of '\x1b[200~a\nb\x1b[201~')e.source.write(c);
    assert.deepEqual(e.messages,[]);
    for(const c of '\x1b[27;5;13~')e.source.write(c);
    assert.deepEqual(e.messages,['a\nb']);
  } finally {e.close();}
});

test('TTY: unframed multiline block and split CRLF never submit automatically',()=>{
  const e=editor();
  try {
    e.source.write('a\nb\n');assert.deepEqual(e.messages,[]);
    e.source.write('c');e.source.write('\r');e.source.write('\n');
    assert.deepEqual(e.messages,[]);
    e.source.write('d');e.source.write('\n');assert.deepEqual(e.messages,['a\nb\nc\nd']);
  } finally {e.close();}
});

test('TTY: pasted control sequences cannot approve a tool or execute a shortcut',()=>{
  const e=editor();
  try {
    e.setMain(false);e.source.write('\x1b[200~y\ny\x1b[201~');assert.deepEqual(e.messages,[]);
    e.source.write('n');e.source.write('\r');assert.deepEqual(e.messages,['n']);
    e.setMain(true);e.source.write('\x1b[200~safe\x1b[31m red\x1b[0m\ttext\x1b[201~');e.source.write('\n');
    assert.equal(e.messages[1],'safe red\ttext');
  } finally {e.close();}
});

test('TTY: unfinished paste Ctrl+C cancels, and close restores terminal mode',()=>{
  const e=editor();let interrupted=false;
  e.rl.on('SIGINT',()=>{interrupted=true;e.input.cancelDraft();});
  try {
    e.source.write('\x1b[200~aborted\n');e.source.write('\x03');
    assert.equal(interrupted,true);assert.deepEqual(e.messages,[]);
    e.source.write('next');e.source.write('\n');assert.deepEqual(e.messages,['next']);
  } finally {e.close();}
  assert.equal(e.source.isRaw,false);
  assert.ok(e.screen().endsWith('\x1b[?2004l'));
});


test('TTY: legacy ANSI multiline paste is sanitized without sending',()=>{
  const e=editor();
  try {
    e.source.write('\x1b[31mred\x1b[0m\nnext');assert.deepEqual(e.messages,[]);
    e.source.write('\n');assert.deepEqual(e.messages,['red\nnext']);
  } finally {e.close();}
});
