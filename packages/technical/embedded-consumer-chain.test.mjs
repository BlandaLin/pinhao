import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectEmbeddedConsumerProgram} from './embedded-consumer-chain.mjs';
import {qualifyEmbeddedContracts,encodeEmbeddedTarget,verifyEmbeddedRewrite,assertEmbeddedContractsFresh} from './embedded-command-contract.mjs';

// Independently authored transport fixture, not a copy of an installed plugin.
const neutral=String.raw`(function(){
var upper=function(label){return(label||'').toUpperCase();};
var scalar=function(value){return Number(value);};
var stitch=function(list,from,to){if(arguments.length<2)from=0;if(arguments.length<3)to=list.length;var text='';for(var i=from;i<to;i++){text+=list[i];if(i<to-1)text+=' ';}return text;};
var previous=Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand=function(command,args){previous.apply(this,arguments);this.deliverCaption(command,args);};
Game_Interpreter.prototype.deliverCaption=function(title,words){switch(upper(title)){case 'NOTICE':if(isNaN(words[words.length-1])||words.length===1)words.push(18);var font=scalar(words.pop());$screen.showCaption(stitch(words),font);break;case 'OTHER':words.shift();break;}};
Canvas.prototype.showCaption=function(value,font){this.caption=(this.caption||'')+value+'\n';this.font=font;};
})();`;
const count=code=>inspectEmbeddedConsumerProgram(code).delegatedMappings('NOTICE',['Whole','source','text','32']).length;

async function fixture(t,{code=neutral,before,after}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'pinhao-chain-proof-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  await mkdir(path.join(root,'js/plugins'),{recursive:true});await mkdir(path.join(root,'data'));
  await writeFile(path.join(root,'js/rpg_objects.js'),`Game_Interpreter.prototype.command356=function(){var args=this._params[0].split(' ');var command=args.shift();this.pluginCommand(command,args);return true;};Game_Interpreter.prototype.pluginCommand=function(command,args){};`);
  const plugins=[];if(before){plugins.push({name:'Earlier',status:true});await writeFile(path.join(root,'js/plugins/Earlier.js'),before);}plugins.push({name:'Caption',status:true});if(after){plugins.push({name:'Later',status:true});await writeFile(path.join(root,'js/plugins/Later.js'),after);}
  await writeFile(path.join(root,'js/plugins.js'),`var $plugins=${JSON.stringify(plugins)};`);await writeFile(path.join(root,'js/plugins/Caption.js'),code);
  const rawSource='Whole source text',command=`NOTICE ${rawSource} 32`,unit={id:'caption',rawSource,locator:{file:'data/CommonEvents.json',pointer:'/1/list/0/parameters/0',segment:{syntax:'rpgmaker-plugin-command',prefix:'NOTICE ',suffix:' 32'}}};
  await writeFile(path.join(root,'data/CommonEvents.json'),JSON.stringify([null,{list:[{code:356,parameters:[command]}]}]));
  return{root,unit,command};
}

test('finite delegated normalize/pop/loop-join maps complete text and protects explicit numeric tail',async t=>{
  const f=await fixture(t),contract=(await qualifyEmbeddedContracts({gameDir:f.root,units:[f.unit]})).caption;
  assert.equal(contract.target.transport,'bounded-delegated-loop-join-v1');assert.equal(contract.target.tailArgumentCount,1);
  const target='A longer complete translated caption';
  const actual=encodeEmbeddedTarget({before:f.command,source:f.unit.rawSource,target,contract});
  assert.equal(actual,`NOTICE ${target} 32`);
  verifyEmbeddedRewrite({before:f.command,after:actual,source:f.unit.rawSource,target,contract});
  assert.throws(()=>verifyEmbeddedRewrite({before:f.command,after:`NOTICE ${target} 99`,source:f.unit.rawSource,target,contract}),{code:'EMBEDDED_TEXT_UNREPRESENTABLE'});
  assert.equal(count(neutral),1);
});

for(const [name,mutate]of[
  ['dot access is not indexed joining',code=>code.replace('text+=list[i]','text+=list.i')],
  ['non-function redeclaration cannot reuse an earlier helper',code=>code.replace('var previous=',"var stitch='not a function';var previous=")],
  ['reassigned helper cannot reuse an earlier definition',code=>code.replace('var previous=',"stitch=function(value){return value.trim();};var previous=")],
  ['shadowed arguments changes helper defaults',code=>code.replace(/\bto\b/g,'arguments')],
  ['helper parameter cannot be shadowed by a popped scalar',code=>code.replace('var font=scalar(words.pop())','var stitch=scalar(words.pop())').replace('stitch(words),font','stitch(words),stitch')],
  ['extra array mutation is not a transport recipe',code=>code.replace('var font=','words.reverse();var font=')],
  ['loop trimming changes complete text',code=>code.replace('return text;','return text.trim();')],
  ['direct endpoint secondary parsing remains unsupported',code=>code.replace('this.font=font;','this.mode=value.split(",")[1];this.font=font;')],
  ['unknown text transforms cannot be called identity transport',code=>code.replace('this.font=font;','this.other=value.toLowerCase();this.font=font;')],
  ['local endpoint helper secondary parsing remains unsupported',code=>code.replace('var previous=',"var parseParts=function(value){return value.split(',');};var previous=").replace('this.font=font;','this.mode=parseParts(value)[1];this.font=font;')],
  ['conditional definitions are not an installed handler',code=>`if(false){${code}}`],
  ['uncalled definitions are not an installed handler',code=>`function never(){${code}}`],
  ['unknown normalization does not establish a command branch',code=>code.replace('toUpperCase','toLowerCase')],
])test(name,()=>assert.equal(count(mutate(neutral)),0));

test('unproven alias transport, arguments mutation and external method replacement remain pending',async t=>{
  const variants=[
    {before:`var old=Game_Interpreter.prototype.pluginCommand;Game_Interpreter.prototype.pluginCommand=function(command,args){old.call(this,command,args);arguments[1][0]='changed';};`},
    {before:`var old=Game_Interpreter.prototype.pluginCommand;Game_Interpreter.prototype.pluginCommand=function(command,args){old.call(this,command,args);args.pop();};`},
    {after:`var old=Game_Interpreter.prototype.pluginCommand;Game_Interpreter.prototype.pluginCommand=function(command,args){args.pop();old.call(this,command,args);};`},
    {after:`Game_Interpreter.prototype.deliverCaption=function(command,args){args.reverse();};`},
    {after:`Canvas.prototype.showCaption=function(value,font){this.caption=value.split(',')[0];};`},
    {after:`Game_Interpreter.prototype[window.methodName]=function(command,args){};`},
    {code:neutral.replace('var previous=Game_Interpreter.prototype.pluginCommand','var previous=Other.prototype.pluginCommand')},
  ];
  for(const options of variants){const f=await fixture(t,options);await assert.rejects(qualifyEmbeddedContracts({gameDir:f.root,units:[f.unit]}),{code:'EMBEDDED_REPRESENTATION_PENDING'});}
});

test('a default-triggering tail and engine builtin replacement cannot use the explicit-tail proof',async t=>{
  const f=await fixture(t);
  for(const tail of ['unknown',''])await assert.rejects(qualifyEmbeddedContracts({gameDir:f.root,units:[{...f.unit,locator:{...f.unit.locator,segment:{...f.unit.locator.segment,suffix:tail?` ${tail}`:''}}}]}),{code:'EMBEDDED_REPRESENTATION_PENDING'});
  await writeFile(path.join(f.root,'js/plugins/Caption.js'),neutral+`Array.prototype.pop=function(){return 'changed';};`);
  await assert.rejects(qualifyEmbeddedContracts({gameDir:f.root,units:[f.unit]}),{code:'EMBEDDED_REPRESENTATION_PENDING'});
});

test('lazy baseline uses host-bound original consumers, but final freshness reads only actual product consumers',async t=>{
  const f=await fixture(t),baseline=path.join(f.root,'selected'),product=path.join(f.root,'product');await mkdir(path.join(baseline,'data'),{recursive:true});
  await writeFile(path.join(baseline,'data/CommonEvents.json'),await readFile(path.join(f.root,'data/CommonEvents.json')));
  const contract=(await qualifyEmbeddedContracts({gameDir:baseline,consumerGameDir:f.root,units:[f.unit]})).caption;
  assert.equal(contract.sourceBinding.baselineRoot,baseline);await assertEmbeddedContractsFresh({caption:contract},baseline);
  await cp(path.join(f.root,'js'),path.join(product,'js'),{recursive:true});await assertEmbeddedContractsFresh({caption:contract},product,{purpose:'final'});
  await writeFile(path.join(product,'js/plugins/Caption.js'),neutral+'\n/* Actual product consumer changed. */');
  await assert.rejects(assertEmbeddedContractsFresh({caption:contract},product,{purpose:'final'}),{code:'EMBEDDED_REPRESENTATION_PENDING'});
  await assertEmbeddedContractsFresh({caption:contract},baseline);
});
