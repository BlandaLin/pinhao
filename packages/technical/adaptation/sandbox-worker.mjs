import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { isPrivateGamePath } from '../../core/private-paths.mjs';

const { code, action, input, sourceDir, outputDir, allowedFiles, limits } = workerData;
const maxLogBytes = limits.maxLogBytes ?? limits.maxResultBytes;
let readBytes = 0, writtenBytes = 0, operations = 0, logCharacters = 0;
const reads = new Set(), writes = new Set();
const readHashes = {}, listings = {}, logs = [];
const missingReads = new Set();
const hash = value => createHash('sha256').update(value).digest('hex');
const relativeError = value => [sourceDir, outputDir].filter(Boolean).reduce((text, root, index) => text.replaceAll(root, index ? '[output]' : '[source]'), String(value ?? ''));
const inside = (root, target) => { const r = path.relative(root, target); return !r || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };

function locate(root, file, write = false) {
  if (typeof file !== 'string' || file.includes('\\') || file.includes('\0') || file.includes(':') || path.isAbsolute(file) || file.split('/').some(p => p === '..' || p === '.' || (!p && file !== '') || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('资源路径越界');
  if (!file && write) throw new Error('输出路径须定位文件');
  if (root === sourceDir && (isPrivateGamePath(file) || isPrivateGamePath(file, { directory: true }))) throw new Error('存档与私人配置不属于游戏文字资源');
  if (write && !allowedFiles.includes(file)) throw new Error(`输出文件未在配方范围中声明：${file}`);
  const canonical = realpathSync(root);
  if (lstatSync(root).isSymbolicLink()) throw new Error('适配目录包含链接');
  let current = root;
  for (const part of file.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !inside(canonical, realpathSync(current))) throw new Error('资源路径包含链接');
      if (write && info.isFile() && info.nlink > 1) throw new Error('输出文件包含硬链接');
    } catch (error) { if (error.code !== 'ENOENT' || !write) throw error; }
  }
  return current;
}

function tick() {
  if (++operations > limits.maxOperations) throw new Error('适配器文件操作次数达到上限');
}

const capabilities = {
  list(directory = '') {
    tick();
    const result = [];
    function visit(prefix) {
      const target = locate(sourceDir, prefix);
      const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (result.length >= limits.maxFiles) throw new Error('适配器资源清单达到上限，请缩小目录');
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isPrivateGamePath(file, { directory: entry.isDirectory() })) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) result.push({ path: file, size: lstatSync(locate(sourceDir, file)).size });
      }
    }
    try { visit(directory); }
    catch (error) { if (error.code === 'ENOENT') missingReads.add(directory); throw error; }
    listings[directory] = hash(JSON.stringify(result));
    return result;
  },
  readBytes(file) {
    tick();
    let target;
    try { target = locate(sourceDir, file); }
    catch (error) { if (error.code === 'ENOENT') missingReads.add(file); throw error; }
    const info = lstatSync(target);
    if (!info.isFile() || info.size > limits.maxFileBytes || readBytes + info.size > limits.maxReadBytes) throw new Error('适配器资源读取达到上限');
    const bytes = readFileSync(target);
    readBytes += bytes.length; reads.add(file);
    readHashes[file] = hash(bytes);
    return bytes.toString('base64');
  },
  readText(file) { return Buffer.from(capabilities.readBytes(file), 'base64').toString('utf8'); },
  writeBytes(file, base64) {
    tick();
    if (!['roundtrip', 'build', 'assemble'].includes(action) || !outputDir) throw new Error('当前适配步骤仅提供读取能力');
    if (typeof base64 !== 'string' || base64.length > limits.maxFileBytes * 1.4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('输出字节编码无效');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > limits.maxFileBytes || writtenBytes + bytes.length > limits.maxWriteBytes) throw new Error('适配器资源写入达到上限');
    const target = locate(outputDir, file, true);
    mkdirSync(path.dirname(target), { recursive: true });
    locate(outputDir, file, true);
    writeFileSync(target, bytes, { flag: 'w' });
    writtenBytes += bytes.length; writes.add(file);
    return { bytes: bytes.length };
  },
  writeText(file, text) {
    if (typeof text !== 'string') throw new Error('输出文字须为字符串');
    return capabilities.writeBytes(file, Buffer.from(text, 'utf8').toString('base64'));
  },
  log(...values) {
    tick();
    const message = values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    if (logCharacters + message.length > maxLogBytes) throw new Error('适配日志达到上限');
    logCharacters += message.length; logs.push(message);
    // Streamed so a timeout or crash still returns what the adapter printed.
    parentPort.postMessage({ progress: { log: message } });
    return null;
  },
};

try {
  const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + limits.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const bridge = context.newFunction('__hostCall', (name, args) => {
      const key = context.getString(name);
      if (!Object.hasOwn(capabilities, key)) throw new Error('未知主机能力');
      const value = capabilities[key](...JSON.parse(context.getString(args)));
      return context.newString(JSON.stringify(value));
    });
    context.setProp(context.global, '__hostCall', bridge); bridge.dispose();
    // `console` is the one channel a model can watch its own adapter through; QuickJS has none by default.
    const bootstrap = context.evalCode(`globalThis.host=Object.freeze(Object.fromEntries(${JSON.stringify(Object.keys(capabilities))}.map(name=>[name,(...args)=>JSON.parse(__hostCall(name,JSON.stringify(args)))])));
globalThis.console=Object.freeze(Object.fromEntries(['log','info','warn','error','debug','trace'].map(name=>[name,(...values)=>{host.log(...values);return null}])));`);
    if (bootstrap.error) { bootstrap.error.dispose(); throw new Error('适配能力初始化失败'); }
    bootstrap.value.dispose();
    let adapter;
    for (const expression of [`(${code})`, `(()=>{${code}\n;return typeof adapter==='object'?adapter:undefined;})()`]) {
      const candidate = context.evalCode(expression, 'generated-adapter.js');
      if (candidate.error) {
        const error = context.dump(candidate.error); candidate.error.dispose();
        if (error.name === 'SyntaxError') continue;
        throw Object.assign(new Error(`${error.name ?? 'AdapterError'}: ${error.message ?? JSON.stringify(error)}`), { guestStack: error.stack });
      }
      const value = context.dump(candidate.value);
      if (value === undefined || value === null) { candidate.value.dispose(); continue; }
      adapter = candidate.value; break;
    }
    if (!adapter) throw new Error('适配代码需要返回适配器对象');
    context.setProp(context.global, '__adapter', adapter); adapter.dispose();
    const program = `"use strict";\nconst adapter=__adapter;\nfor(const name of ['detect','extract','validate','roundtrip','build','assemble'])if(typeof adapter[name]!=='function')throw new Error('Missing adapter method: '+name);\nconst result=adapter[${JSON.stringify(action)}](host,${JSON.stringify(input ?? {})});\nif(result&&typeof result.then==='function')throw new Error('Adapter methods must be synchronous');\nJSON.stringify(result??null);`;
    const result = context.evalCode(program, 'generated-adapter.js');
    if (result.error) {
      const error = context.dump(result.error); result.error.dispose();
      throw Object.assign(new Error(`${error.name ?? 'AdapterError'}: ${error.message ?? JSON.stringify(error)}`), { guestStack: error.stack });
    }
    const json = context.getString(result.value); result.value.dispose();
    if (json.length > limits.maxResultBytes) throw new Error('适配结果达到上限');
    parentPort.postMessage({ ok: true, result: JSON.parse(json), reads: [...reads], writes: [...writes], readHashes, listings, missingReads: [...missingReads], logs, metrics: { readBytes, writtenBytes, operations } });
  } finally { context.dispose(); runtime.dispose(); }
} catch (error) {
  parentPort.postMessage({ ok: false, error: { message: relativeError(error.message), stack: relativeError(error.guestStack ?? error.message), code: error.code ?? 'ADAPTER_EXECUTION_FAILED' }, reads: [...reads], writes: [...writes], readHashes, listings, missingReads: [...missingReads], logs });
}
