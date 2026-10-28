import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createNativeTools} from './native-tools.mjs';
import {createAdapterLab} from '../technical/adaptation/adapter-lab.mjs';
import {productWorker} from '../../apps/desktop/electron/host.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function pck(entries){
  const header=Buffer.alloc(100);header.write('GDPC');header.writeUInt32LE(2,4);header.writeUInt32LE(4,8);header.writeUInt32LE(4,12);header.writeUInt32LE(1,16);header.writeUInt32LE(entries.length,96);
  const directory=[],payload=[];let offset=100+entries.reduce((sum,[name])=>sum+4+Buffer.byteLength(name)+36,0);
  for(const [name,value]of entries){const encoded=Buffer.from(name),row=Buffer.alloc(4+encoded.length+36);row.writeUInt32LE(encoded.length);encoded.copy(row,4);row.writeBigUInt64LE(BigInt(offset),4+encoded.length);row.writeBigUInt64LE(BigInt(value.length),12+encoded.length);createHash('md5').update(value).digest().copy(row,20+encoded.length);directory.push(row);payload.push(value);offset+=value.length;}
  return Buffer.concat([header,...directory,...payload]);
}
function asarWithSidecar(){
  const tree={files:{data:{files:{'story.json':{size:Buffer.byteLength('A complete external caption.'),unpacked:true}}},'media.bin':{size:1024*1024,offset:'0'}}},raw=Buffer.from(JSON.stringify(tree)),padded=Buffer.alloc(Math.ceil(raw.length/4)*4);raw.copy(padded);
  const header=Buffer.alloc(16);header.writeUInt32LE(4);header.writeUInt32LE(padded.length+8,4);header.writeUInt32LE(padded.length+4,8);header.writeUInt32LE(raw.length,12);
  return Buffer.concat([header,padded,Buffer.alloc(1024*1024,19)]);
}

test('real Godot final member resolver validates actual targets without expanding packed media',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pinhao-native-final-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const original=path.join(root,'original'),outputDir=path.join(root,'product'),nativeSource=path.join(root,'native-source'),nativeWorkspaceDir=path.join(root,'native-work');
  for(const dir of [original,outputDir,path.join(nativeSource,'data'),path.join(nativeWorkspaceDir,'technical')])await mkdir(dir,{recursive:true});
  const before=JSON.stringify({text:'An actual complete scene.',flag:7}),after=JSON.stringify({text:'一段完整的真实场景。',flag:7}),media=Buffer.alloc(1024*1024,17);
  const originalPack=pck([['data/story.json',Buffer.from(before)],['media/large.bin',media]]),finalPack=pck([['data/story.json',Buffer.from(after)],['media/large.bin',media]]);
  await writeFile(path.join(original,'game.pck'),originalPack);await writeFile(path.join(outputDir,'game.pck'),finalPack);await writeFile(path.join(nativeSource,'data/story.json'),before);
  const metadata={schema:'pinhao-native-source-v1',engine:'Godot',root:'.',packed:true,nativeSource,archives:['game.pck'],sourceFiles:{'game.pck':digest(originalPack)},godot:{version:[4,4,1]}};
  await writeFile(path.join(nativeWorkspaceDir,'technical/product-source.json'),JSON.stringify(metadata));
  const bundledPython=path.resolve('local/runtime/python/python.exe'),pythonPath=process.env.PINHAO_PYTHON??await access(bundledPython).then(()=>bundledPython,()=>process.platform==='win32'?'python':'python3');
  const realWorker=productWorker({pythonPath,workerPath:path.resolve('adapters/python/worker.py'),toolkitPath:path.resolve('kits/workbench-tutorial/toolkit'),dependencyDir:path.resolve('local/dependencies'),timeoutMs:60000}),calls=[];
  const native=createNativeTools({worker:async(command,args,options)=>{calls.push({command,args});return realWorker(command,args,options);}});
  const lab=await createAdapterLab({dataDir:path.join(root,'lab'),archiveResolver:native}),manifest={schemaVersion:1,id:'final-native-json',version:'1.0.0',engine:'Godot',license:'MIT',scope:{files:['data/story.json']}};
  const code=`({detect(){return true},extract(h){return {units:[{id:'caption',source:JSON.parse(h.readText('data/story.json')).text,locator:{file:'data/story.json',pointer:'/text'}}]}},validate(){return true},roundtrip(h){h.writeBytes('data/story.json',h.readBytes('data/story.json'));return {}},build(h,i){const d=JSON.parse(h.readText('data/story.json'));d.text=i.translations.caption??d.text;h.writeText('data/story.json',JSON.stringify(d));return {}},assemble(){return {}}})`;
  const candidate=await lab.writeAdapter({manifest,code}),validated=await lab.validateAdapter({...candidate,gameDir:nativeSource});assert.equal(validated.passed,true,JSON.stringify(validated.error));
  const recipe=await lab.submitRecipe({...candidate,validationId:validated.validationId}),extracted=await lab.extractRecipe({...recipe,gameDir:nativeSource,workspaceDir:path.join(root,'writer')});
  const built=await lab.dispatch('build',{workspaceDir:extracted.workspaceDir,outputDir:path.join(root,'build'),translations:[{id:'caption',translation:'一段完整的真实场景。'}]});
  const item={workspaceDir:extracted.workspaceDir,buildDir:built.buildDir,buildReceiptId:built.buildReceiptId,outputDir,finalGameDir:outputDir,gameDir:original,sourceRoot:nativeSource,resourceRoot:'.',nativeWorkspaceDir};
  let committed=0;const sealed=await lab.withBuildPublication({builds:[item],commit:()=>committed++});assert.equal(committed,1);
  assert.ok(calls.length);assert.ok(calls.every(call=>call.command==='native_unpack'&&call.args.files.length===1&&call.args.files[0]==='data/story.json'));
  for(const call of calls)await assert.rejects(access(call.args.outputDir),{code:'ENOENT'},'successful selected-member verification is released after sealing');
  await rm(built.buildDir,{recursive:true});await lab.withBuildPublication({builds:sealed.proofs,commit:()=>committed++});assert.equal(committed,2);
  assert.deepEqual(await readFile(path.join(original,'game.pck')),originalPack);
  await writeFile(path.join(outputDir,'game.pck'),originalPack);
  await assert.rejects(lab.withBuildPublication({builds:sealed.proofs,commit:()=>committed++}),{code:'FORMAT_SOURCE_STALE'});assert.equal(committed,2);
  await assert.rejects(lab.withBuildPublication({builds:[item],commit:()=>committed++}),{code:'FORMAT_BUILD_PROOF_REQUIRED'});
});

test('real ASAR final view binds selected external member and releases only its own temporary directory',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pinhao-final-asar-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const original=path.join(root,'original'),outputDir=path.join(root,'product'),nativeWorkspaceDir=path.join(root,'native-work'),archive='resources/app.asar',sidecar=`${archive}.unpacked/data/story.json`,before='A complete external caption.',after='An updated external caption.';
  assert.equal(Buffer.byteLength(before),Buffer.byteLength(after));
  for(const dir of [path.dirname(path.join(original,sidecar)),path.dirname(path.join(outputDir,sidecar)),path.join(nativeWorkspaceDir,'technical')])await mkdir(dir,{recursive:true});
  const packed=asarWithSidecar();
  await writeFile(path.join(original,archive),packed);await writeFile(path.join(outputDir,archive),packed);await writeFile(path.join(original,sidecar),before);await writeFile(path.join(outputDir,sidecar),after);
  await writeFile(path.join(nativeWorkspaceDir,'technical/product-source.json'),JSON.stringify({schema:'pinhao-native-source-v1',engine:'TyranoScript',root:'resources/app',archiveFormat:'asar',packed:true,nativeSource:path.join(root,'native-source'),archives:[archive],sourceFiles:{[archive]:digest(packed),[sidecar]:digest(before)},archiveLayouts:{archive,members:[{file:'data/story.json',unpacked:true}]}}));
  const bundledPython=path.resolve('local/runtime/python/python.exe'),pythonPath=process.env.PINHAO_PYTHON??await access(bundledPython).then(()=>bundledPython,()=>process.platform==='win32'?'python':'python3');
  const worker=productWorker({pythonPath,workerPath:path.resolve('adapters/python/worker.py'),toolkitPath:path.resolve('kits/workbench-tutorial/toolkit'),dependencyDir:path.resolve('local/dependencies'),timeoutMs:60000});
  const native=createNativeTools({worker}),view=await native.resolveFinalView({gameDir:original,outputDir,nativeWorkspaceDir,files:['resources/app/data/story.json'],workDir:path.join(root,'readback')});
  assert.equal(await readFile(path.join(view.sourceDir,'resources/app/data/story.json'),'utf8'),after);
  assert.equal(view.artifactHashes[sidecar],digest(after));assert.ok(view.artifactFiles.includes(archive));
  await assert.rejects(access(path.join(view.sourceDir,'resources/app/media.bin')),{code:'ENOENT'});
  assert.equal((await view.release()).status,'released');await assert.rejects(access(view.temporaryReadbackDir),{code:'ENOENT'});
  assert.equal(await readFile(path.join(original,sidecar),'utf8'),before);
});
