import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createAdapterLab} from './adapter-lab.mjs';
import {createDisplayVerifier} from './display-review.mjs';
import {createDisplayFactStore} from './display-facts.mjs';

async function fixture(t,{display=false,count=1}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'pinhao-final-proof-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const gameDir=path.join(root,'game'),projectDir=path.join(root,'project'),outputDir=path.join(root,'product');
  await mkdir(gameDir);await mkdir(projectDir);
  await writeFile(path.join(gameDir,'lines.json'),JSON.stringify({lines:Array.from({length:count},(_,i)=>`Caption ${i}`),flag:7}));
  await writeFile(path.join(gameDir,'main.js'),'display(data.lines[index]);');
  const displayVerifier=display?createDisplayVerifier({connectionFor:()=>({baseUrl:'http://local.invalid/v1',model:'local-mechanism-test'}),projectFor:()=>({id:'project',workspaceDir:projectDir}),generate:async({tools,prompt})=>{
    const source=await tools.read_resource.execute({file:'lines.json'}),consumer=await tools.read_resource.execute({file:'main.js'});
    await tools.finish_review.execute({decisions:JSON.parse(prompt).units.map(row=>({ref:row.ref,status:'display-supported',reason:'Read actual display caller.',evidenceIds:[source.receiptId],consumerEvidenceIds:[consumer.receiptId]}))});
  }}):undefined;
  const lab=await createAdapterLab({dataDir:path.join(root,'lab'),workspaceFor:()=>projectDir,displayVerifier});
  const builds=[],extractions=[],validations=[];
  await cp(gameDir,outputDir,{recursive:true});
  for(let i=0;i<count;i++){
    const manifest={schemaVersion:1,id:`writer-${i}`,version:'1.0.0',engine:'Neutral',license:'MIT',scope:{files:['lines.json']}};
    const code=`({detect(){return true},extract(host){return {units:[{id:'unit-${i}',source:JSON.parse(host.readText('lines.json')).lines[${i}],locator:{file:'lines.json',pointer:'/lines/${i}'}}]}},validate(){return true},roundtrip(host){host.writeBytes('lines.json',host.readBytes('lines.json'));return {}},build(host,input){const data=JSON.parse(host.readText('lines.json'));data.lines[${i}]=input.translations['unit-${i}']??data.lines[${i}];host.writeText('lines.json',JSON.stringify(data));return {}},assemble(){return {}}})`;
    const candidate=await lab.writeAdapter({projectId:'project',manifest,code}),validation=await lab.validateAdapter({projectId:'project',...candidate,gameDir});
    assert.equal(validation.passed,true,JSON.stringify(validation.error));validations.push(validation);
    const recipe=await lab.submitRecipe({projectId:'project',...candidate,validationId:validation.validationId});
    const extraction=await lab.extractRecipe({projectId:'project',...recipe,gameDir,workspaceDir:path.join(root,`writer-${i}`)});
    const build=await lab.dispatch('build',{projectId:'project',workspaceDir:extraction.workspaceDir,outputDir:path.join(root,`build-${i}`),translations:[{id:`unit-${i}`,translation:`中文 ${i}`}]});
    const actual=JSON.parse(await readFile(path.join(outputDir,'lines.json'),'utf8'));actual.lines[i]=`中文 ${i}`;await writeFile(path.join(outputDir,'lines.json'),JSON.stringify(actual));
    builds.push({workspaceDir:extraction.workspaceDir,buildReceiptId:build.buildReceiptId,buildDir:build.buildDir,outputDir,unitIds:[`unit-${i}`]});extractions.push(extraction);
  }
  return{root,lab,builds,extractions,validations,outputDir,projectDir,displayVerifier};
}

test('final build seal supports cache after temporary cleanup and rejects changed actual product',async t=>{
  const f=await fixture(t);let committed=0,stored;
  const first=await f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:proofs=>{committed++;stored=proofs;return'published';}});
  assert.equal(first.result,'published');assert.equal(stored[0].finalProofRef.format,'pinhao-final-build-ref-1');
  await rm(f.builds[0].buildDir,{recursive:true});
  await f.lab.withBuildPublication({projectId:'project',builds:stored,commit:()=>committed++});assert.equal(committed,2);
  await writeFile(path.join(f.outputDir,'lines.json'),JSON.stringify({lines:['Wrong target'],flag:7}));
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:stored,commit:()=>committed++}),{code:'FORMAT_SOURCE_STALE'});assert.equal(committed,2);
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:()=>committed++}),{code:'FORMAT_BUILD_PROOF_REQUIRED'});assert.equal(committed,2);
  await assert.rejects(f.lab.assertBuildOutputFresh({workspaceDir:f.builds[0].workspaceDir,buildReceiptId:f.builds[0].buildReceiptId,outputDir:f.outputDir}),{code:'FORMAT_BUILD_PROOF_REQUIRED'});
});

test('revoked format qualification cannot publish a fresh or retained final result',async t=>{
  const f=await fixture(t);let committed=0;
  const first=await f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:()=>committed++});
  const qualificationRef=f.extractions[0].binding.verificationPlan.capabilityRefs[0].qualificationRef;
  await f.lab.revokeFormatQualification({qualificationRef,reason:'Host independent negative evidence'});
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:()=>committed++}),{code:'ADAPTER_ACCEPTED_STALE'});
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:first.proofs,commit:()=>committed++}),{code:'ADAPTER_ACCEPTED_STALE'});
  assert.equal(committed,1);
});

test('multiple actual bindings share one display fence and a later challenge blocks cache publication', {timeout:20000},async t=>{
  const f=await fixture(t,{display:true,count:2});let committed=0;
  const first=await f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:()=>committed++});assert.equal(first.proofs.length,2);
  for(const item of f.builds)await rm(item.buildDir,{recursive:true});
  await f.lab.withBuildPublication({projectId:'project',builds:first.proofs,commit:()=>committed++});
  const store=createDisplayFactStore({directory:path.join(f.projectDir,'display-facts'),projectId:'project'});
  const factId=f.validations[0].displayReview.displayFactRefs[0];
  await store.challengeFact({proofId:factId,evidenceRefs:[{receiptId:'related-consumer-counterexample'}],reasonCode:'independent-new-consumer',verifyEvidence:async()=>true});
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:first.proofs,commit:()=>committed++}));assert.equal(committed,2);
});

test('format revocation and display challenges wait for the synchronous final commit', {timeout:20000},async t=>{
  const f=await fixture(t,{display:true}),original=f.displayVerifier.withPublicationsFence;
  let entered,release;const checking=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;}),order=[];
  f.displayVerifier.withPublicationsFence=(entries,commit,{check})=>original(entries,commit,{check:async()=>{entered();await hold;await check();}});
  const publishing=f.lab.withBuildPublication({projectId:'project',builds:f.builds,commit:()=>order.push('commit')});
  await checking;
  const revoked=f.lab.revokeFormatQualification({qualificationRef:f.extractions[0].binding.verificationPlan.capabilityRefs[0].qualificationRef}).then(()=>order.push('revoke'));
  const store=createDisplayFactStore({directory:path.join(f.projectDir,'display-facts'),projectId:'project'});
  const challenged=store.challengeFact({proofId:f.validations[0].displayReview.displayFactRefs[0],evidenceRefs:[{receiptId:'new-consumer'}],reasonCode:'new-consumer',verifyEvidence:async()=>true}).then(()=>order.push('challenge'));
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(order,[]);release();await publishing;await Promise.all([revoked,challenged]);assert.equal(order[0],'commit');
});

test('packed native snapshots without a final member reader remain typed pending',async t=>{
  const f=await fixture(t);let committed=false;
  await assert.rejects(f.lab.withBuildPublication({projectId:'project',builds:f.builds.map(item=>({...item,gameDir:path.join(f.root,'original-packed'),sourceRoot:path.join(f.root,'native-members')})),commit:()=>{committed=true;}}),{code:'FORMAT_FINAL_VIEW_REQUIRED'});
  assert.equal(committed,false);
});
