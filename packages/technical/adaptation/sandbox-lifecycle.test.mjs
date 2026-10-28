import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {runSandbox} from './sandbox.mjs';

for(const fails of [false,true])test(`sandbox ${fails?'failure':'success'} settles only after the real worker has terminated`,{timeout:10000},async t=>{
  const sourceDir=await mkdtemp(path.join(os.tmpdir(),'pinhao-sandbox-handoff-'));t.after(()=>rm(sourceDir,{recursive:true,force:true,maxRetries:3}));
  const original=Worker.prototype.terminate;let release,ended;
  const hold=new Promise(resolve=>{release=resolve;}),terminated=new Promise(resolve=>{ended=resolve;});
  Worker.prototype.terminate=function(...args){return original.apply(this,args).then(async result=>{ended();await hold;return result;});};
  let settled=false;
  try{
    const detect=fails?'throw new Error("original guest failure")':'return true';
    const running=runSandbox({sourceDir,action:'detect',code:`({detect(){${detect}},extract(){return {units:[]}},validate(){return true},roundtrip(){return {}},build(){return {}},assemble(){return {}}})`});
    running.then(()=>{settled=true;},()=>{settled=true;});
    await terminated;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'no filesystem handoff occurs while worker termination is pending');
    release();
    if(fails)await assert.rejects(running,/original guest failure/);else assert.equal((await running).result,true);
  }finally{release();Worker.prototype.terminate=original;}
});
