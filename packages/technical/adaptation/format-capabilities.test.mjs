import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFormatCapabilities, formatDigest } from './format-capabilities.mjs';
import { verifyFormatGroups } from './format-verification.mjs';
import { createAdapterLab } from './adapter-lab.mjs';
import { applySupplementalText, prepareSupplement, readSupplementManifest, registerSupplement, createAdaptiveWorker, createAdaptationSource } from '../../core/adaptive-worker.mjs';
import { adaptationLocationKey, selectSupplementalUnits } from '../../core/adaptation-results.mjs';

const rootFor = async t => { const root = await mkdtemp(path.join(os.tmpdir(),'pinhao-capability-')); t.after(() => rm(root,{recursive:true,force:true,maxRetries:3})); return root; };
const unit = { id:'caption', source:'Hello', rawSource:'Hello', locator:{file:'body.neutral',formatPath:{family:'mechanism-fixture',path:['caption']}} };
const profile = qualified => ({ capabilityId:'fixture-group', profileFamily:'mechanism-fixture', contentRef:{implementationDigest:'a'.repeat(64),configurationDigest:'b'.repeat(64),dependencyLockDigest:'c'.repeat(64)}, qualificationRef:'host-fixture-independent-oracle', claims:['structure','targets','preservation','derivedFields'], integrationModes:['independent','exclusive-resource-group'], identity: locator => locator.formatPath?.path.join('/'), isQualified:qualified,
  match: ({units}) => units.every(item => item.locator.formatPath?.family === 'mechanism-fixture') ? {writeSet:['body.neutral','index.neutral'],unitIds:units.map(item => item.id)} : null,
  verify: ({before,after,translations}) => {
    const body = JSON.parse(after['body.neutral']), original = JSON.parse(before['body.neutral']);
    const valid = body.text === translations.caption && body.flag === original.flag && JSON.stringify(JSON.parse(after['index.neutral'])) === JSON.stringify({length:Buffer.byteLength(body.text)});
    return {status:valid?'passed':'failed',claims:Object.fromEntries(['structure','targets','preservation','derivedFields'].map(key => [key,valid?'passed':'failed']))};
  } });
test('default lab exposes actual builtins and unsupported data is typed, not silently trusted', async t => {
  const root = await rootFor(t), lab = await createAdapterLab({dataDir:path.join(root,'lab')}), described = lab.describeVerificationCapabilities();
  assert.equal(described.capabilities.length,4);
  const catalog = await createFormatCapabilities();
  const json = await catalog.plan({units:[{...unit,locator:{file:'data.dat',pointer:'/text'}}],manifest:{scope:{files:['data.dat']}}});
  assert.equal(json.capabilityRefs[0].capabilityId,'builtin-json-pointer');
  await assert.rejects(catalog.plan({units:[{...unit,locator:{file:'data.dat',byteStart:0,byteEnd:5}}],manifest:{scope:{files:['data.dat']}}}),{code:'FORMAT_UNSUPPORTED'});
  await assert.rejects(catalog.plan({units:[unit],manifest:{scope:{files:['body.neutral']}}}),{code:'FORMAT_LOCATOR_UNSUPPORTED'});
  await assert.rejects(createFormatCapabilities({profiles:[{...profile(() => true),claims:['structure']}]}),/完整目标/);
  const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'fields.dat'),'{"text":"Caption","count":7}');
  const view=await lab.readFormatView({gameDir:source,file:'fields.dat'});
  assert.equal(view.content.text,'Caption'); assert.equal(view.sourceRef.baselineHash,formatDigest(await readFile(path.join(source,'fields.dat'))));
  const raw=await lab.readFormatView({gameDir:source,file:'fields.dat',view:'raw',offset:2,length:4});
  assert.equal(Buffer.from(raw.content,'base64').toString(),'text');
});
test('same function text with different closure configuration cannot reuse old structural proof',async t=>{
  const root=await rootFor(t),gameDir=path.join(root,'source');await mkdir(gameDir);await writeFile(path.join(gameDir,'story.txt'),'Hello');
  const checker=allowed=>async()=>({valid:allowed});
  assert.equal(String(checker(true)),String(checker(false)));
  const manifest={schemaVersion:1,id:'closure-check',version:'1.0.0',engine:'Neutral',license:'MIT',scope:{files:['story.txt']}};
  const code=`({detect(){return true},extract(host){return {units:[{id:'line',source:host.readText('story.txt'),locator:{file:'story.txt',byteStart:0,byteEnd:5}}]}},validate(){return true},roundtrip(host){host.writeBytes('story.txt',host.readBytes('story.txt'));return {}},build(host,input){host.writeText('story.txt',input.translations.line??host.readText('story.txt'));return {}},assemble(){return {}}})`;
  const first=await createAdapterLab({dataDir:path.join(root,'lab'),structuralVerifier:checker(true)}),candidate=await first.writeAdapter({manifest,code});
  const passed=await first.validateAdapter({...candidate,gameDir});assert.equal(passed.passed,true,passed.error?.message);
  const second=await createAdapterLab({dataDir:path.join(root,'lab'),structuralVerifier:checker(false)}),failed=await second.validateAdapter({...candidate,gameDir});
  assert.equal(failed.passed,false);assert.notEqual(failed.validationId,passed.validationId);
});
test('host qualification revocation survives a new lab and fences later commit without resurrecting proof',async t=>{
  const root=await rootFor(t),dataDir=path.join(root,'lab');
  const first=await createAdapterLab({dataDir}),catalog=first.describeVerificationCapabilities(),json=catalog.capabilities.find(item=>item.capabilityId==='builtin-json-pointer'),span=catalog.capabilities.find(item=>item.capabilityId==='builtin-utf8-span');
  const receipt=await first.revokeFormatQualification({qualificationRef:json.qualificationRef,reason:'independent counterexample',expectedRevision:0});
  assert.equal(receipt.revision,1);
  const reopened=await createAdapterLab({dataDir});let published=false;
  await assert.rejects(reopened.withQualificationFence({capabilityRefs:[json],commit:()=>{published=true;}}),{code:'FORMAT_QUALIFICATION_REVOKED'});
  assert.equal(published,false);
  assert.equal((await reopened.revokeFormatQualification({qualificationRef:json.qualificationRef})).revision,1);
  assert.equal(await reopened.withQualificationFence({capabilityRefs:[span],commit:()=>true}),true,'unrelated qualification is not invalidated');
});
test('qualified groups verify actual target/preservation/sidecar and reject mixed-state publication', async t => {
  const root = await rootFor(t), before = path.join(root,'before'), after = path.join(root,'after'), output = path.join(root,'product');
  for (const dir of [before,after,output]) await mkdir(dir);
  const manifest = {scope:{files:['body.neutral','index.neutral']}}, candidate={candidateId:'candidate-fixture',codeHash:'d'.repeat(64)};
  for (const dir of [before,output]) { await writeFile(path.join(dir,'body.neutral'),JSON.stringify({flag:7,text:'Hello'})); await writeFile(path.join(dir,'index.neutral'),JSON.stringify({length:5})); }
  await writeFile(path.join(after,'body.neutral'),JSON.stringify({flag:7,text:'真实中文'})); await writeFile(path.join(after,'index.neutral'),JSON.stringify({length:12}));
  let qualified = true;
  const catalog = await createFormatCapabilities({profiles:[profile(() => qualified)]}), plan = await catalog.plan({units:[unit],manifest});
  const receipts = await verifyFormatGroups({catalog,plan,candidate,gameDir:before,outputDir:after,units:[unit],translations:{caption:'真实中文'},purpose:'build'});
  assert.equal(receipts.length,1); assert.equal(receipts[0].claims.derivedFields,'passed');
  const binding=plan.unitBindings[0], raw={...unit,context:{formatBinding:binding}};
  assert.ok(adaptationLocationKey(raw.locator,raw.locator.file,binding));
  assert.equal(selectSupplementalUnits({projectId:'test',incoming:[raw],existing:[]}).units.length,1);
  const item={workspaceDir:path.join(root,'writer'),unitIds:['caption'],units:[raw],files:manifest.scope.files,sourceRoot:before,baselineDir:before,resourceRoot:'.',verificationPlan:plan,groupReceipts:receipts,buildDir:after,baselineHashes:receipts[0].beforeHashes};
  await applySupplementalText({adapterBuilds:[item],gameDir:before,buildDir:path.join(root,'build'),outputDir:output});
  assert.deepEqual(await readFile(path.join(output,'index.neutral')),await readFile(path.join(after,'index.neutral')));
  await writeFile(path.join(output,'index.neutral'),JSON.stringify({length:5}));
  await assert.rejects(applySupplementalText({adapterBuilds:[item],gameDir:before,buildDir:path.join(root,'next-build'),outputDir:output}),{code:'FORMAT_SCOPE_CONFLICT'});
  qualified=false;
  await assert.rejects(verifyFormatGroups({catalog,plan,candidate,gameDir:before,outputDir:after,units:[unit],translations:{caption:'真实中文'},purpose:'build'}),{code:'FORMAT_QUALIFICATION_REVOKED'});
});
test('preparing a composite registry does not publish it and exact replay is immutable', async t => {
  const root=await rootFor(t), baseline=path.join(root,'baseline'), workspaceDir=path.join(root,'work'); await mkdir(baseline);
  await writeFile(path.join(baseline,'body.json'),'{}');
  const options={workspaceDir,adapterWorkspaceDir:path.join(root,'adapter'),unitIds:['a'],units:[{id:'a',source:'Hi',locator:{file:'body.json',pointer:'/text'}}],files:['body.json'],baselineDir:baseline,sourceRoot:baseline};
  const first=await prepareSupplement(options);
  await assert.rejects(readFile(path.join(workspaceDir,'pinhao-composite-adapter.json')),{code:'ENOENT'});
  assert.equal((await readSupplementManifest(workspaceDir,first.manifestRef)).adapters.length,1);
  const second=await prepareSupplement({...options,currentManifestRef:first.manifestRef});
  assert.equal(second.registryChanged,false); assert.deepEqual(second.manifestRef,first.manifestRef);
  await writeFile(path.join(workspaceDir,first.manifestRef.file),'{}');
  await assert.rejects(readSupplementManifest(workspaceDir,first.manifestRef),/快照/);
});
test('host-qualified opaque group reaches real lab, supplemental registration and assembled product including sidecar',async t=>{
  const root=await rootFor(t),gameDir=path.join(root,'source'),workspaceDir=path.join(root,'work');await mkdir(gameDir);await mkdir(workspaceDir);
  await writeFile(path.join(gameDir,'body.neutral'),JSON.stringify({flag:7,text:'Hello'}));await writeFile(path.join(gameDir,'index.neutral'),JSON.stringify({length:5}));
  const catalog=await createFormatCapabilities({profiles:[profile(()=>true)]}),lab=await createAdapterLab({dataDir:path.join(root,'lab'),formatCapabilities:catalog});
  const manifest={schemaVersion:2,id:'qualified-group',version:'1.0.0',engine:'Neutral',license:'MIT',scope:{files:['body.neutral','index.neutral']},verification:{profile:'fixture-group',status:'proposal-only'}};
  const code=`({detect(){return true},extract(host){const body=JSON.parse(host.readText('body.neutral'));return {units:[{id:'caption',source:body.text,locator:{file:'body.neutral',formatPath:{family:'mechanism-fixture',path:['caption']}}}]}},validate(){return true},roundtrip(host){for(const file of ['body.neutral','index.neutral'])host.writeBytes(file,host.readBytes(file));return {}},build(host,input){const body=JSON.parse(host.readText('body.neutral'));body.text=input.translations.caption??body.text;let size=0;for(const c of body.text){const p=c.codePointAt(0);size+=p<128?1:p<2048?2:p<65536?3:4;}host.writeText('body.neutral',JSON.stringify(body));host.writeText('index.neutral',JSON.stringify({length:size}));return {}},assemble(){return {}}})`;
  const candidate=await lab.writeAdapter({manifest,code}),validation=await lab.validateAdapter({...candidate,gameDir});assert.equal(validation.passed,true,validation.error?.message);
  const recipe=await lab.submitRecipe({...candidate,validationId:validation.validationId}),extraction=await lab.extractRecipe({...recipe,gameDir,workspaceDir:path.join(root,'writer')});
  await lab.assertAcceptedFresh({projectId:'different-caller-context',extraction:JSON.parse(JSON.stringify(extraction)),gameDir});
  let committed=0;await lab.withAcceptedPublication({extraction,gameDir,commit:()=>committed++});assert.equal(committed,1);
  const selected=selectSupplementalUnits({projectId:'neutral',incoming:extraction.units,existing:[]});assert.equal(selected.units.length,1);
  await registerSupplement({workspaceDir,adapterWorkspaceDir:extraction.workspaceDir,unitIds:['caption'],units:selected.rawUnits,files:manifest.scope.files,baselineDir:gameDir,sourceRoot:gameDir,verificationPlan:extraction.binding.verificationPlan});
  const worker=createAdaptiveWorker({getLab:async()=>lab,nativeWorker:async(command,args)=>{if(command==='build'){await mkdir(args.outputDir,{recursive:true});return{buildDir:args.outputDir};}if(command==='assemble'){await cp(gameDir,args.outputDir,{recursive:true});return{outputDir:args.outputDir};}return{};}});
  const built=await worker('build',{workspaceDir,outputDir:path.join(root,'build'),translations:[{id:'caption',translation:'真实中文'}]});
  await worker('assemble',{workspaceDir,gameDir,buildDir:built.buildDir,outputDir:path.join(root,'product'),adapterBuilds:built.adapterBuilds});
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'product/body.neutral'),'utf8')),{flag:7,text:'真实中文'});
  assert.equal(JSON.parse(await readFile(path.join(root,'product/index.neutral'),'utf8')).length,12);
  assert.equal(JSON.parse(await readFile(path.join(gameDir,'body.neutral'),'utf8')).text,'Hello');
  await lab.revokeFormatQualification({qualificationRef:extraction.binding.verificationPlan.capabilityRefs[0].qualificationRef,reason:'negative fixture evidence'});
  await assert.rejects(lab.withAcceptedPublication({extraction,gameDir,commit:()=>committed++}),{code:'ADAPTER_ACCEPTED_STALE'});
  assert.equal(committed,1,'revoked qualification cannot enter the publication commit');
});
test('explicit source copying keeps observed origin/hash and refuses a silent first-origin substitution',async t=>{
  const root=await rootFor(t),first=path.join(root,'first'),second=path.join(root,'second');await mkdir(first);await mkdir(second);
  await writeFile(path.join(first,'same.dat'),'FIRST');await writeFile(path.join(second,'same.dat'),'SECOND');
  const result=await createAdaptationSource({gameDir:first,sourceRoots:[second],outputDir:path.join(root,'copy'),files:[{file:'same.dat',sourceIndex:1,expectedHash:formatDigest('SECOND')}],returnDetails:true});
  assert.equal(await readFile(path.join(result.sourceDir,'same.dat'),'utf8'),'SECOND');assert.equal(result.sources[0].sourceIndex,1);
  await assert.rejects(createAdaptationSource({gameDir:first,sourceRoots:[second],outputDir:path.join(root,'new-copy'),files:[{file:'same.dat',sourceIndex:1,expectedHash:formatDigest('FIRST')}]}),{code:'SOURCE_BASELINE_CHANGED'});
});
