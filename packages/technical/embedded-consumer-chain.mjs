import {parse} from 'acorn';

const id=node=>node?.type==='Identifier'?node.name:null;
const prop=node=>node?.type==='MemberExpression'?(node.computed?node.property?.value:node.property?.name):null;
const key=node=>id(node)??(node?.type==='MemberExpression'&&typeof prop(node)==='string'?`${key(node.object)}.${prop(node)}`:null);
const literal=(node,value)=>node?.type==='Literal'&&node.value===value;
const expression=node=>node?.type==='ExpressionStatement'?node.expression:null;
const statements=node=>node?.type==='BlockStatement'?node.body:[node];
const assignment=(node,name,operator='=')=>node?.type==='AssignmentExpression'&&node.operator===operator&&id(node.left)===name;
const length=(node,name)=>key(node)===`${name}.length`;
const visit=(node,callback)=>{if(!node||typeof node!=='object')return;callback(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(item=>visit(item,callback));else if(value&&typeof value==='object')visit(value,callback);};

function collect(ast){
  const scopes=new Map(),handlers=[];
  const scopeFor=node=>{if(!scopes.has(node))scopes.set(node,{functions:new Map(),aliases:new Map(),assigned:new Set(),methods:new Map(),declarations:new Map(),methodWrites:new Map()});return scopes.get(node);};
  const add=(map,name,value)=>map.set(name,[...(map.get(name)??[]),value]);
  const write=(scope,node,known)=>{
    const name=key(node.left);
    if(id(node.left))scope.assigned.add(id(node.left));
    if(node.left?.type==='MemberExpression'&&key(node.left.object)?.endsWith('.prototype')){
      const name=key(node.left)??'*';scope.methodWrites.set(name,(scope.methodWrites.get(name)??0)+1);
    }
    if(known&&node.operator==='='&&node.right?.type==='FunctionExpression'&&name){add(scope.methods,name,node.right);if(name==='Game_Interpreter.prototype.pluginCommand')handlers.push({fn:node.right,scope,start:node.start});}
  };
  const scan=(body,owner)=>{
    const scope=scopeFor(owner);
    for(const node of body){
      if(['ReturnStatement','ThrowStatement'].includes(node.type))break;
      if(node.type==='VariableDeclaration')for(const declaration of node.declarations){
        if(!id(declaration.id))continue;const name=id(declaration.id);scope.declarations.set(name,(scope.declarations.get(name)??0)+1);
        if(declaration.init?.type==='FunctionExpression')add(scope.functions,name,declaration.init);
        if(key(declaration.init)==='Game_Interpreter.prototype.pluginCommand')add(scope.aliases,name,declaration);
      }
      else if(node.type==='ExpressionStatement'){
        const value=node.expression;
        if(value.type==='AssignmentExpression')write(scope,value,true);
        if(value.type==='CallExpression'&&value.callee.type==='FunctionExpression'&&!value.callee.async&&!value.callee.generator&&value.callee.params.length===0&&value.arguments.length===0)scan(value.callee.body.body,value.callee);
      }else if(node.type==='BlockStatement')scan(node.body,owner);
      else if(node.type==='IfStatement'&&literal(node.test,false)){if(node.alternate)scan(statements(node.alternate),owner);}
      else if(node.type!=='EmptyStatement')visit(node,part=>{if(part.type==='AssignmentExpression')write(scope,part,false);if(part.type==='VariableDeclarator'&&id(part.id))scope.assigned.add(id(part.id));});
    }
  };
  scan(ast.body,ast);return{handlers,scopes};
}
const only=(map,name)=>map.get(name)?.length===1?map.get(name)[0]:null;
const helper=(scope,name)=>!scope.assigned.has(name)&&scope.declarations.get(name)===1?only(scope.functions,name):null;
const methodFor=(scope,name)=>scope.methodWrites.get(name)===1?only(scope.methods,name):null;
function forwards(node,handler){
  const command=id(handler.fn.params[0]),args=id(handler.fn.params[1]),call=expression(node);
  if(call?.type!=='CallExpression'||!['apply','call'].includes(prop(call.callee))||!id(call.callee.object))return false;
  const name=id(call.callee.object),alias=only(handler.scope.aliases,name);
  if(!alias||alias.start>=handler.start||handler.scope.assigned.has(name)||handler.scope.declarations.get(name)!==1||[command,args].includes(name)||call.arguments[0]?.type!=='ThisExpression')return false;
  return prop(call.callee)==='apply'?call.arguments.length===2&&id(call.arguments[1])==='arguments'
    :call.arguments.length===3&&id(call.arguments[1])===command&&id(call.arguments[2])===args;
}
function upperHelper(fn){
  const parameter=id(fn?.params?.[0]),body=fn?.body?.body;
  if(!parameter||fn.params.length!==1||body?.length!==1||body[0].type!=='ReturnStatement')return false;
  const call=body[0].argument,receiver=call?.callee?.object;
  return call?.type==='CallExpression'&&prop(call.callee)==='toUpperCase'&&call.arguments.length===0
    &&(id(receiver)===parameter||receiver?.type==='LogicalExpression'&&receiver.operator==='||'&&id(receiver.left)===parameter&&literal(receiver.right,''));
}
function normalizedCommand(node,commandName,scope,command){
  if(id(node)===commandName)return command;
  if(node?.type==='CallExpression'&&node.arguments.length===1&&id(node.arguments[0])===commandName&&id(node.callee)!==commandName&&upperHelper(helper(scope,id(node.callee))))return command.toUpperCase();
  if(node?.type==='CallExpression'&&prop(node.callee)==='toUpperCase'&&id(node.callee.object)===commandName&&node.arguments.length===0)return command.toUpperCase();
  return null;
}
function defaultParameter(statement,name,index,value){
  const test=statement?.test,set=expression(statements(statement?.consequent)[0]);
  return statement?.type==='IfStatement'&&!statement.alternate&&statements(statement.consequent).length===1
    &&test?.type==='BinaryExpression'&&test.operator==='<'&&length(test.left,'arguments')&&literal(test.right,index)
    &&assignment(set,name)&&value(set.right);
}
function spaceJoinHelper(fn){
  const [array,start,end]=fn?.params?.map(id)??[],body=fn?.body?.body;
  if(!array||!start||!end||[array,start,end].includes('arguments')||fn.params.length!==3||body?.length!==5||!defaultParameter(body[0],start,2,node=>literal(node,0))||!defaultParameter(body[1],end,3,node=>length(node,array)))return false;
  const declaration=body[2],text=declaration?.type==='VariableDeclaration'&&declaration.declarations.length===1?id(declaration.declarations[0].id):null,loop=body[3];
  const index=loop?.init?.type==='VariableDeclaration'&&loop.init.declarations.length===1?id(loop.init.declarations[0].id):null;
  if(!text||!literal(declaration.declarations[0].init,'')||!index||new Set([array,start,end,text,index]).size!==5||loop.type!=='ForStatement'||id(loop.init.declarations[0].init)!==start
      ||loop.test?.type!=='BinaryExpression'||loop.test.operator!=='<'||id(loop.test.left)!==index||id(loop.test.right)!==end
      ||loop.update?.type!=='UpdateExpression'||loop.update.operator!=='++'||id(loop.update.argument)!==index)return false;
  const parts=statements(loop.body),append=expression(parts[0]),separator=parts[1],test=separator?.test,space=expression(statements(separator?.consequent)[0]);
  return parts.length===2&&assignment(append,text,'+=')&&append.right?.type==='MemberExpression'&&append.right.computed&&id(append.right.object)===array&&id(append.right.property)===index
    &&separator?.type==='IfStatement'&&!separator.alternate&&statements(separator.consequent).length===1&&test?.type==='BinaryExpression'&&test.operator==='<'&&id(test.left)===index
    &&test.right?.type==='BinaryExpression'&&test.right.operator==='-'&&id(test.right.left)===end&&literal(test.right.right,1)
    &&assignment(space,text,'+=')&&literal(space.right,' ')&&body[4].type==='ReturnStatement'&&id(body[4].argument)===text;
}
function explicitTailGuard(node,args,values){
  const test=node?.test,checks=test?.type==='LogicalExpression'&&test.operator==='||'?[test.left,test.right]:[];
  const count=checks.find(item=>item?.type==='BinaryExpression'&&['===','=='].includes(item.operator)&&length(item.left,args)&&literal(item.right,1));
  const nan=checks.find(item=>item?.type==='CallExpression'&&id(item.callee)==='isNaN'&&item.arguments.length===1),last=nan?.arguments[0];
  const atEnd=last?.type==='MemberExpression'&&id(last.object)===args&&last.computed&&last.property?.type==='BinaryExpression'&&last.property.operator==='-'&&length(last.property.left,args)&&literal(last.property.right,1);
  const pushed=expression(statements(node?.consequent)[0]);
  return node?.type==='IfStatement'&&!node.alternate&&count&&atEnd&&statements(node.consequent).length===1&&pushed?.type==='CallExpression'&&prop(pushed.callee)==='push'&&id(pushed.callee.object)===args&&pushed.arguments.length===1
    &&values.length>1&&Number.isFinite(Number(values.at(-1)));
}
function popExpression(node,args,scope){
  if(node?.type==='CallExpression'&&prop(node.callee)==='pop'&&id(node.callee.object)===args&&node.arguments.length===0)return true;
  if(node?.type!=='CallExpression'||node.arguments.length!==1||!id(node.callee)||id(node.callee)===args||!helper(scope,id(node.callee)))return false;
  let reflection=false;visit(helper(scope,id(node.callee)),part=>{if(['caller','callee'].includes(prop(part))||part.type==='CallExpression'&&['eval','Function'].includes(id(part.callee)))reflection=true;});
  return !reflection&&node.arguments[0]?.type==='CallExpression'&&prop(node.arguments[0].callee)==='pop'&&id(node.arguments[0].callee.object)===args&&node.arguments[0].arguments.length===0;
}
function endpointProjection(fn,scope){
  const parameter=id(fn.params[0]);if(!parameter||parameter==='arguments')return false;
  const full=(node,field)=>{
    if(id(node)===parameter)return{valid:true,text:true};
    if(node?.type==='Literal'&&typeof node.value==='string'&&/^\s*$/.test(node.value))return{valid:true,text:false};
    if(node?.type==='LogicalExpression'&&node.operator==='||'&&node.left?.object?.type==='ThisExpression'&&prop(node.left)===field&&literal(node.right,''))return{valid:true,text:false};
    if(node?.type==='BinaryExpression'&&node.operator==='+'){const left=full(node.left,field),right=full(node.right,field);return{valid:left.valid&&right.valid,text:left.text||right.text};}
    return{valid:false,text:false};
  };
  let projected=false;visit(fn.body,node=>{if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.object?.type==='ThisExpression'&&typeof prop(node.left)==='string'){const value=full(node.right,prop(node.left));if(value.valid&&value.text)projected=true;}});
  if(!projected)return false;
  const checked=new Set();
  const knownValue=(node,bindings)=>node?.type==='Literal'?node.value:id(node)&&Object.hasOwn(bindings,id(node))?bindings[id(node)]:undefined;
  const relevant=(node,bindings,callback)=>{
    if(!node||typeof node!=='object')return;callback(node);
    if(node.type==='ConditionalExpression'&&typeof knownValue(node.test,bindings)==='boolean'){relevant(knownValue(node.test,bindings)?node.consequent:node.alternate,bindings,callback);return;}
    const inner=/Function/.test(node.type??'')?{}:bindings;
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(item=>relevant(item,inner,callback));else if(value&&typeof value==='object')relevant(value,inner,callback);
  };
  const inspect=(current,taint,depth=0,bindings={})=>{
    if(depth>4)return false;const identity=`${current.start}:${taint}:${JSON.stringify(bindings)}`;if(checked.has(identity))return false;checked.add(identity);
    const names=new Set([taint]);
    visit(current.body,node=>{if(node.type==='VariableDeclarator'&&id(node.id)&&id(node.init)&&names.has(id(node.init)))names.add(id(node.id));});
    const returnsText=name=>{const nested=helper(scope,name),value=id(nested?.params[0]);if(!nested||!value)return true;let found=false;visit(nested.body,node=>{if(node.type==='ReturnStatement')visit(node.argument,part=>{if(id(part)===value)found=true;});});return found;};
    const carries=node=>!!node&&(id(node)?names.has(id(node)):node.type==='MemberExpression'?carries(node.object):node.type==='CallExpression'?node.arguments.some(carries)&&(!id(node.callee)||returnsText(id(node.callee))):node.type==='BinaryExpression'||node.type==='LogicalExpression'?carries(node.left)||carries(node.right):false);
    const callbacks=new Set(),callbackCalls=new Set();
    relevant(current.body,bindings,node=>{
      if(node.type!=='CallExpression'||!carries(node.arguments[0])||node.arguments.length!==2)return;
      const callback=node.arguments[1],value=callback?.body?.body?.length===1?expression(callback.body.body[0]):null;
      if(callback?.type==='FunctionExpression'&&callback.params.length===1&&value?.type==='AssignmentExpression'&&value.operator==='='&&names.has(id(value.left))&&id(value.right)===id(callback.params[0])){callbacks.add(value);callbackCalls.add(node);}
    });
    let safe=true;
    relevant(current.body,bindings,node=>{
      if(node.type==='AssignmentExpression'&&names.has(id(node.left))&&current===fn&&!callbacks.has(node))safe=false;
      if(node.type==='MemberExpression'&&node.computed&&carries(node.object))safe=false;
      if(node.type==='NewExpression'&&node.arguments.some(carries))safe=false;
      if(node.type!=='CallExpression')return;
      if(carries(node.callee?.object)){
        const name=prop(node.callee);
        const identity=name==='toString'&&node.arguments.length===0;
        const controlEscape=name==='replace'&&node.arguments[0]?.regex&&(/^(?:\\\\|\\x1b)/.test(node.arguments[0].regex.pattern));
        if(!identity&&!controlEscape)safe=false;
      }
      const positions=node.arguments.map((value,index)=>carries(value)?index:-1).filter(index=>index>=0);
      if(!positions.length)return;
      if(callbackCalls.has(node)||key(node.callee)==='String'||prop(node.callee)==='convertEscapeCharacters')return;
      if(id(node.callee)){
        const nested=helper(scope,id(node.callee));
        const argumentsKnown=nested?Object.fromEntries(nested.params.map((parameter,index)=>[id(parameter),knownValue(node.arguments[index],bindings)]).filter(([name,value])=>name&&value!==undefined)):{};
        if(!nested||positions.some(index=>!id(nested.params[index])||!inspect(nested,id(nested.params[index]),depth+1,argumentsKnown)))safe=false;
      }else if(!carries(node.callee.object))safe=false;
    });
    return safe;
  };
  return inspect(fn,parameter);
}
function delegated(text,handler,command,values){
  const commandName=id(handler.fn.params[0]),args=id(handler.fn.params[1]);
  if(!commandName||!args||commandName===args||handler.fn.params.length!==2)return[];
  let body=handler.fn.body.body,prior=false;
  if(forwards(body[0],handler)){prior=true;body=body.slice(1);}
  if(body.length!==1)return[];
  const call=expression(body[0]);
  if(call?.type!=='CallExpression'||call.callee?.object?.type!=='ThisExpression'||typeof prop(call.callee)!=='string'||call.arguments.length!==2||id(call.arguments[0])!==commandName||id(call.arguments[1])!==args)return[];
  const methodName=`Game_Interpreter.prototype.${prop(call.callee)}`,method=methodFor(handler.scope,methodName);
  if(!method||method.params.length!==2)return[];
  const nestedCommand=id(method.params[0]),nestedArgs=id(method.params[1]),sw=method.body.body[0];
  if(!nestedCommand||!nestedArgs||method.body.body.length!==1||sw?.type!=='SwitchStatement')return[];
  const selected=normalizedCommand(sw.discriminant,nestedCommand,handler.scope,command);
  if(selected===null)return[];
  const branch=sw.cases.find(item=>literal(item.test,selected));
  if(!branch||branch.consequent.at(-1)?.type!=='BreakStatement'||branch.consequent.at(-1).label)return[];
  const operations=branch.consequent.slice(0,-1),tailVariables=new Set();let tail=0,sink,joined;
  for(let index=0;index<operations.length;index++){
    const operation=operations[index];
    if(index===0&&explicitTailGuard(operation,nestedArgs,values))continue;
    const declaration=operation.type==='VariableDeclaration'&&operation.declarations.length===1?operation.declarations[0]:null;
    if(declaration&&id(declaration.id)&&![nestedCommand,nestedArgs,'arguments'].includes(id(declaration.id))&&popExpression(declaration.init,nestedArgs,handler.scope)&&tail<4){tail++;tailVariables.add(id(declaration.id));continue;}
    const terminal=expression(operation),argument=terminal?.arguments?.[0];
    if(index!==operations.length-1||terminal?.type!=='CallExpression'||terminal.callee?.type!=='MemberExpression'||terminal.callee.computed||!id(terminal.callee.object)||!id(terminal.callee.property)
        ||argument?.type!=='CallExpression'||!id(argument.callee)||[nestedCommand,nestedArgs,...tailVariables].includes(id(argument.callee))||argument.arguments.length!==1||id(argument.arguments[0])!==nestedArgs||!spaceJoinHelper(helper(handler.scope,id(argument.callee)))
        ||terminal.arguments.slice(1).some(item=>item.type!=='Literal'&&!tailVariables.has(id(item))))return[];
    const endpoint=[...handler.scope.methods.entries()].filter(([name])=>name.endsWith(`.prototype.${id(terminal.callee.property)}`));
    if(endpoint.length!==1||!methodFor(handler.scope,endpoint[0][0])||!endpointProjection(endpoint[0][1][0],handler.scope))return[];
    sink=terminal;joined=argument;
  }
  if(!sink||tail!==1||values.length<=tail)return[];
  return[{mode:'joined-range-before-tail',argvStart:0,tailArgumentCount:tail,consumerExpression:text.slice(joined.start,joined.end),consumerSpan:{start:sink.start,end:sink.end},transport:'bounded-delegated-loop-join-v1',usesPrior:prior,methodDependencies:[methodName,...[...handler.scope.methods.keys()].filter(name=>name.endsWith(`.prototype.${id(sink.callee.property)}`))]}];
}

export function inspectEmbeddedConsumerProgram(text){
  const ast=parse(text,{ecmaVersion:'latest'}),{handlers,scopes}=collect(ast);
  let unsafeBuiltins=false;visit(ast,node=>{if(node.type==='AssignmentExpression'&&['Array.prototype.pop','Array.prototype.push','Array.prototype.slice','Array.prototype.join','String.prototype.toUpperCase'].includes(key(node.left)))unsafeBuiltins=true;});
  return{
    ast,unsafeBuiltins,overrides:handlers.length>0,handlerStarts:new Set(handlers.map(handler=>handler.fn.start)),methodWrites:new Set([...scopes.values()].flatMap(scope=>[...scope.methodWrites.keys()])),
    forwardsFirst:handlers.length===1&&forwards(handlers[0].fn.body.body[0],handlers[0]),
    priorTransparent:handlers.every(handler=>{
      const args=id(handler.fn.params[1]);let safe=true;
      for(const statement of handler.fn.body.body){if(forwards(statement,handler))continue;visit(statement,node=>{if(node.type==='Identifier'&&[args,'arguments'].includes(node.name))safe=false;});}
      return safe;
    }),
    delegatedMappings:(command,values)=>unsafeBuiltins?[]:handlers.flatMap(handler=>delegated(text,handler,command,values)),
  };
}
