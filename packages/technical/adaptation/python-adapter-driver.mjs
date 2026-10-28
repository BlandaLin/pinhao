export const PYTHON_ADAPTER_PROTOCOL = 'python-module-v1';

// The host owns process/JSON glue; generated modules own format operations only.
export const PYTHON_ADAPTER_DRIVER = String.raw`import base64,inspect,json,pathlib,re,sys,traceback
req=json.load(sys.stdin)
action=req['action']; limits=req['limits']; allowed=set(req['readFiles']); writable=set(req['files'])
reads=set(); writes=set(); listed=[]; metrics={'readBytes':0,'writtenBytes':0,'operations':0,'logBytes':0}
class ContractError(ValueError): pass
def tick():
 metrics['operations']+=1
 if metrics['operations']>limits['maxOperations']: raise ContractError('file operations exceed maxOperations')
def relative(file,directory=False):
 if not isinstance(file,str) or '\\' in file or chr(0) in file or ':' in file or file.startswith('/') or (not directory and not file): raise ContractError('invalid relative resource path')
 if any(p in ('.','..') or (not p and file!='') or p.endswith(('.',' ')) or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?',p) for p in file.split('/')): raise ContractError('invalid relative resource path')
 return file
def locate(file,write=False):
 relative(file)
 if file not in (writable if write else allowed): raise ContractError('resource is not declared: '+file)
 if write and (action not in ('roundtrip','build','assemble') or not req.get('outputDir')): raise ContractError('action is read-only: '+action)
 root=pathlib.Path(req['outputDir'] if write else req['sourceDir'] if file in writable else req['auxiliarySourceDir']).resolve(); target=root
 for part in file.split('/'):
  target=target/part
  if target.is_symlink() or (target.exists() and not target.resolve().is_relative_to(root)): raise ContractError('resource path contains link: '+file)
  if write and target.is_file() and target.stat().st_nlink>1: raise ContractError('output must be an independent file: '+file)
 return target
class Host:
 def readBytes(self,file):
  tick(); target=locate(file); size=target.stat().st_size
  if size>limits['maxFileBytes'] or metrics['readBytes']+size>limits['maxReadBytes']: raise ContractError('resource read exceeds limits')
  value=target.read_bytes(); metrics['readBytes']+=len(value); reads.add(file)
  return base64.b64encode(value).decode('ascii')
 def readText(self,file): return base64.b64decode(self.readBytes(file)).decode('utf-8')
 def writeBytes(self,file,value):
  tick(); target=locate(file,True)
  if not isinstance(value,str) or len(value)>limits['maxFileBytes']*1.4: raise ContractError('invalid base64 output')
  value=base64.b64decode(value,validate=True)
  if len(value)>limits['maxFileBytes'] or metrics['writtenBytes']+len(value)>limits['maxWriteBytes']: raise ContractError('resource write exceeds limits')
  target.parent.mkdir(parents=True,exist_ok=True); locate(file,True); target.write_bytes(value)
  metrics['writtenBytes']+=len(value); writes.add(file); return {'bytes':len(value)}
 def writeText(self,file,value):
  if not isinstance(value,str): raise ContractError('text output must be a string')
  return self.writeBytes(file,base64.b64encode(value.encode('utf-8')).decode('ascii'))
 def list(self,directory=''):
  tick(); relative(directory,True); prefix=directory+'/' if directory else ''
  values=[{'path':file,'size':locate(file).stat().st_size} for file in sorted(allowed) if file.startswith(prefix)]
  if len(values)>limits['maxFiles']: raise ContractError('resource listing exceeds maxFiles')
  listed.append({'directory':directory,'files':values}); return values
 def log(self,*values):
  tick(); message=' '.join(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False) for value in values)
  metrics['logBytes']+=len(message.encode('utf-8'))
  if metrics['logBytes']>limits['maxLogBytes']: raise ContractError('host log exceeds maxLogBytes')
  print(message,flush=True)
try:
 namespace={'__name__':'pinhao_adapter','__file__':str(pathlib.Path('adapter.py').resolve())}
 exec(compile(pathlib.Path('adapter.py').read_text(encoding='utf-8'),'adapter.py','exec'),namespace)
 host=Host()
 for name in ('detect','extract','validate','roundtrip','build','assemble'):
  fn=namespace.get(name)
  if not callable(fn) or inspect.iscoroutinefunction(fn): raise ContractError('missing synchronous method: '+name+'(host,input)')
  try: inspect.signature(fn).bind(host,req.get('input',{}))
  except (TypeError,ValueError) as e: raise ContractError('invalid method signature: '+name+'(host,input)') from e
 result=namespace[action](host,req.get('input',{}))
 if result is None: raise ContractError(action+' returned None instead of its JSON action result')
 if action=='validate' and not (isinstance(result,bool) or isinstance(result,dict) and isinstance(result.get('valid'),bool)): raise ContractError('validate must return true/false or {valid:boolean}; ok is not a validation result')
 response={'result':result,'reads':sorted(reads),'writes':sorted(writes),'declaredListings':listed,'metrics':metrics}
 encoded=json.dumps(response,ensure_ascii=False)
 if len(encoded.encode('utf-8'))>limits['maxResultBytes']: raise ContractError('adapter result exceeds maxResultBytes')
 pathlib.Path(req['resultFile']).write_text(encoded,encoding='utf-8')
except BaseException as e:
 failure={'error':{'code':'PYTHON_ADAPTER_CONTRACT' if isinstance(e,ContractError) else 'PYTHON_ADAPTER_EXECUTION','action':action,'message':str(e),'traceback':traceback.format_exc()}}
 pathlib.Path(req['resultFile']).write_text(json.dumps(failure,ensure_ascii=False),encoding='utf-8')
 traceback.print_exc(); sys.exit(1)
`;
