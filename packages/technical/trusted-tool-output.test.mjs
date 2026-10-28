import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

async function fixture(t,maxOutputBytes){
  const root=await mkdtemp(path.join(os.tmpdir(),'pinhao-trusted-output-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const gameDir=path.join(root,'source'),workDir=path.join(root,'work');await mkdir(gameDir);
  const lab=await createAdapterLab({dataDir:path.join(root,'lab'),trustedTools:{fixture:{command:process.execPath,toolRoot:path.dirname(process.execPath),validateArgs:args=>args[0]==='-e',maxOutputBytes,timeoutMs:5000}}});
  return{lab,gameDir,workDir};
}
test('trusted actual subprocess decodes UTF-8 across chunks while preserving each raw stream',async t=>{
  const f=await fixture(t,1024*1024),text='中😀正文';
  const result=await f.lab.runTool({...f,tool:'fixture',args:['-e',`const b=Buffer.from(${JSON.stringify(text)});process.stdout.write(b.subarray(0,2));process.stderr.write(b.subarray(0,4));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write(b.subarray(4));},30);`]});
  assert.equal(result.stdout,text);assert.equal(result.stderr,text);assert.equal(result.truncated,false);
  assert.deepEqual(await readFile(path.join(result.capture.captureDir,'stdout.bin')),Buffer.from(text));
  assert.deepEqual(await readFile(path.join(result.capture.captureDir,'stderr.bin')),Buffer.from(text));
});
test('trusted output limit stops a live process and retains its captured prefix with explicit truncation',async t=>{
  const f=await fixture(t,1024);
  let capture;
  await assert.rejects(f.lab.runTool({...f,tool:'fixture',args:['-e',`process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);`]}),error=>{
    assert.equal(error.code,'ADAPTER_TOOL_OUTPUT_LIMIT');assert.equal(error.evidence.truncated,true);
    assert.equal(error.evidence.stdoutBytes,1024);assert.equal(error.evidence.stdout,'x'.repeat(1024));
    capture=error.evidence.captureDir;return true;
  });
  assert.equal((await readFile(path.join(capture,'stdout.bin'))).length,1024);
});
