import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { InkInput } from '../dist/ink-input.js';
test('Ink input normalizes fragmented legacy Enter but preserves paste bytes and EOF',async()=>{
 const source=new PassThrough();source.isRaw=false;source.setRawMode=value=>{source.isRaw=value;return source;};
 const input=new InkInput(source);let result='';let error;input.on('data',chunk=>result+=chunk);input.on('error',e=>error=e);
 source.write('a\x1b[27;');source.write('5;13~\x1b[27;2;13~');
 source.write('\x1b[200~literal\x1b[27;5;13~\x1b[201~');source.write('\x1b[2');source.end();
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.equal(result,'a\x1b[13;5u\x1b[13;2u\x1b[200~literal\x1b[27;5;13~\x1b[201~\x1b[2');assert.equal(error,undefined);input.dispose();assert.equal(source.isRaw,false);
});
