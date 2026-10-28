import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, appendFile, rename, unlink, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUsage, summarizeRequestArtifacts } from './usage.mjs';

const privateField = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i;
const contentHash = value => createHash('sha256').update(value).digest('hex');
const contentSchema = 'pinhao-request-content-1';

function requestContentStore(directory) {
  const root = path.resolve(directory);
  const fileFor = digest => {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('请求内容引用无效');
    return path.join(root, `${digest}.json`);
  };
  const read = async digest => {
    const file = fileFor(digest), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('请求内容引用必须指向本工程的普通内容文件');
    const text = await readFile(file, 'utf8');
    if (contentHash(text) !== digest) throw new Error('请求内容已改变，不能还原原始输入');
    return JSON.parse(text);
  };
  return {
    read,
    async save(value) {
      const text = JSON.stringify(value), digest = contentHash(text), target = fileFor(digest);
      try { await read(digest); return digest; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(root, { recursive: true });
      const temporary = path.join(root, `${digest}.${randomUUID()}.pending`);
      try {
        await writeFile(temporary, text, { flag: 'wx' });
        // Writers for one digest publish identical complete bytes; no hard-link filesystem is required.
        try { await rename(temporary, target); }
        catch (error) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          // Windows may refuse replacing the concurrent winner. Accept only its complete verified bytes.
          try { await read(digest); } catch { throw error; }
        }
        await read(digest);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return digest;
    },
  };
}

async function storeRequestMaterial(value, store) {
  if (!value?.body || typeof value.body !== 'object' || Array.isArray(value.body)) return value;
  const body = { ...value.body }, references = {};
  if (Array.isArray(body.messages)) {
    references.messages = [];
    for (const message of body.messages) references.messages.push(await store.save(message));
    delete body.messages;
  }
  if (Array.isArray(body.tools)) { references.tools = await store.save(body.tools); delete body.tools; }
  return Object.keys(references).length ? { ...value, body, requestContent: { schema: contentSchema, bodyKeys: Object.keys(value.body), ...references } } : value;
}

/** The caller supplies the trusted project content directory; a manifest never selects a read path. */
export async function resolveRequestMaterial(value, { contentDirectory } = {}) {
  if (value?.requestContent === undefined) return value;
  const { schema, bodyKeys, messages, tools, ...extra } = value.requestContent ?? {};
  if (!contentDirectory || schema !== contentSchema || Object.keys(extra).length || !value.body || typeof value.body !== 'object'
      || Array.isArray(value.body) || !Array.isArray(bodyKeys) || bodyKeys.some(key => typeof key !== 'string') || new Set(bodyKeys).size !== bodyKeys.length
      || messages === undefined && tools === undefined || messages !== undefined && !Array.isArray(messages)
      || messages !== undefined && Object.hasOwn(value.body, 'messages') || tools !== undefined && Object.hasOwn(value.body, 'tools')) throw new Error('请求内容清单无效或缺少工程内容目录');
  const store = requestContentStore(contentDirectory), { requestContent, ...result } = value;
  result.body = { ...result.body };
  if (messages !== undefined) { result.body.messages = []; for (const digest of messages) result.body.messages.push(await store.read(digest)); }
  if (tools !== undefined) { result.body.tools = await store.read(tools); if (!Array.isArray(result.body.tools)) throw new Error('请求工具定义内容无效'); }
  if (bodyKeys.length !== Object.keys(result.body).length || bodyKeys.some(key => !Object.hasOwn(result.body, key))) throw new Error('请求内容字段顺序清单不完整');
  result.body = Object.fromEntries(bodyKeys.map(key => [key, result.body[key]]));
  return result;
}

export async function readRequestArtifact({ directory, contentDirectory = path.join(path.dirname(directory), '.request-content') }) {
  return resolveRequestMaterial(JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')), { contentDirectory });
}

/** An on-demand projection of existing evidence, not another mutable billing ledger. */
export async function loadRequestUsageSummary(directory, { roles } = {}) {
  const artifacts = [], warnings = [];
  let excludedRequests = 0, unassignedRequests = 0;
  const selectedRoles = roles === undefined ? undefined : new Set(roles);
  const knownRoles = new Set(['translation', 'proofreading', 'technical', 'glossary', 'recollection', 'image', 'images', 'image-ocr']);
  const read = async file => {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  };
  const visit = async root => {
    const requestText = await read(path.join(root, 'request.json'));
    if (requestText !== undefined) {
      const artifact = { id: path.relative(directory, root).replaceAll(path.sep, '/'), events: [] };
      for (const name of ['request', 'result']) {
        const text = name === 'request' ? requestText : await read(path.join(root, `${name}.json`));
        if (text === undefined) continue;
        try { artifact[name] = JSON.parse(text); }
        catch { warnings.push({ id: artifact.id, code: 'UNREADABLE_REQUEST_EVIDENCE', file: `${name}.json` }); }
      }
      for (const line of (await read(path.join(root, 'events.jsonl')) ?? '').split(/\r?\n/).filter(line => line.trim())) {
        try { artifact.events.push(JSON.parse(line)); }
        catch { warnings.push({ id: artifact.id, code: 'UNREADABLE_REQUEST_EVIDENCE', file: 'events.jsonl' }); }
      }
      if (selectedRoles) {
        const namespace = artifact.id.split('/')[0];
        const role = artifact.request?.role ?? artifact.request?.requestContext?.purpose ?? artifact.result?.requestContext?.purpose
          ?? (['images', 'recollection'].includes(namespace) ? namespace : undefined);
        if (!knownRoles.has(role)) {
          unassignedRequests++;
          warnings.push({ id: artifact.id, code: 'UNASSIGNED_REQUEST_ROLE' }); return;
        }
        if (!selectedRoles.has(role)) { excludedRequests++; return; }
      }
      artifacts.push(artifact); return;
    }
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) if (entry.isDirectory() && !['.request-content', 'request-content'].includes(entry.name)) await visit(path.join(root, entry.name));
  };
  const info = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error('用量证据入口需要本工程普通目录');
  if (info) await visit(path.resolve(directory));
  return { ...summarizeRequestArtifacts(artifacts), excludedRequests, unassignedRequests, warnings, evidenceComplete: !warnings.length };
}
export function redactRequestMaterial(value, secrets = []) {
  const redact = text => {
    let result = text;
    for (const secret of secrets.filter(item => typeof item === 'string' && item).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    result = result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
    result = result.replace(/("(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
    return result.replace(/https?:\/\/[^\s"'<>\\]+/gi, candidate => {
      try {
        const url = new URL(candidate);
        let changed = false;
        if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
        for (const key of [...url.searchParams.keys()]) if (privateField.test(key) || /(?:token|key|credential|signature)/i.test(key)) { url.searchParams.set(key, '[REDACTED]'); changed = true; }
        return changed ? url.toString() : candidate;
      } catch { return candidate; }
    });
  };
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactRequestMaterial(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateField.test(key) ? '[REDACTED]' : redactRequestMaterial(item, secrets)]));
}

function textSink(file, secrets) {
  let tail = '';
  return async (text = '', final = false) => {
    tail += text;
    // Keep the last token until complete so split keys and credential URLs are redacted together.
    let boundary = final ? tail.length : Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf(' '), tail.lastIndexOf('\t')) + 1;
    if (!final && /\bBearer\s+$/i.test(tail.slice(0, boundary))) boundary = tail.slice(0, boundary).search(/\bBearer\s+$/i);
    if (boundary) { await appendFile(file, redactRequestMaterial(tail.slice(0, boundary), secrets), 'utf8'); tail = tail.slice(boundary); }
  };
}

function responseSummary(value, secrets) {
  const summary = {};
  if (typeof value?.fetchStarted === 'boolean') summary.fetchStarted = value.fetchStarted;
  for (const key of ['statusCode', 'finishReason', 'receivedBytes', 'requestId', 'transportRequests', 'textCharacters', 'reasoningCharacters']) {
    if (typeof value?.[key] === 'number') summary[key] = value[key];
    else if (typeof value?.[key] === 'string') summary[key] = redactRequestMaterial(value[key], secrets).slice(0, 1024);
  }
  for (const key of ['records', 'evidenceRequests', 'decisions', 'equivalences']) if (Array.isArray(value?.[key])) summary[key] = value[key].length;
  const usage = normalizeUsage(value?.usage ?? value?.rawUsage, { cost: value?.rawUsage?.cost ?? value?.rawUsage?.total_cost });
  if (usage) summary.usage = usage;
  return summary;
}

function eventSummary(value, secrets) {
  const summary = responseSummary(value, secrets);
  for (const key of ['index', 'phase', 'code', 'category', 'retryAfterMs', 'until']) {
    if (typeof value?.[key] === 'number') summary[key] = value[key];
    else if (typeof value?.[key] === 'string') summary[key] = redactRequestMaterial(value[key], secrets).slice(0, 1024);
  }
  if (value.error) summary.error = errorSummary(value.error, secrets);
  return summary;
}

function errorSummary(error, secrets) {
  return Object.fromEntries(['name', 'code', 'message', 'category', 'phase', 'statusCode', 'finishReason'].flatMap(key => {
    const value = error?.[key];
    return typeof value === 'string' ? [[key, redactRequestMaterial(value, secrets).slice(0, key === 'message' ? 4096 : 256)]] : typeof value === 'number' ? [[key, value]] : [];
  }));
}

/** Private request evidence lives beside the project, never in its exchange or product output. */
export async function createRequestArtifact({ directory, contentDirectory = path.join(directory, '.request-content'), requestId, request, requestContext, secrets = [], diagnostics = false, clock = () => new Date().toISOString() }) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('请求工件需要有效 ID');
  await mkdir(directory, { recursive: true });
  const root = path.join(directory, requestId);
  await mkdir(root, { recursive: false });
  const clean = value => redactRequestMaterial(value, secrets);
  const correlation = requestContext ? Object.fromEntries(['projectId', 'adaptationRequestId', 'jobId', 'windowId', 'purpose', 'httpAttemptId', 'retryOf', 'taskId', 'logicalStepId']
    .filter(key => typeof requestContext[key] === 'string').map(key => [key, requestContext[key]])) : undefined;
  const contentStore = requestContentStore(contentDirectory);
  const json = async (file, value) => {
    const target = path.join(root, file), temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(clean(value), null, 2)}\n`, 'utf8'); await rename(temporary, target);
  };
  await json('request.json', await storeRequestMaterial(clean({ schema: 'pinhao-request-artifact-1', capturedAt: clock(), ...request, ...(correlation ? { requestContext: correlation } : {}) }), contentStore));
  await writeFile(path.join(root, 'events.jsonl'), '', 'utf8');
  const sinks = new Map(), times = {}, files = ['request.json', 'events.jsonl'], counts = { textCharacters: 0, reasoningCharacters: 0 };
  let queue = Promise.resolve(), closed = false, finalBodyCaptured = false, finalBodyStatus = 'not-captured', toolCalls = 0;
  const serial = action => { const next = queue.then(action); queue = next.catch(() => {}); return next; };
  const sink = file => {
    if (!sinks.has(file)) { sinks.set(file, textSink(path.join(root, file), secrets)); files.push(file); }
    return sinks.get(file);
  };
  const reference = () => ({ schema: 'pinhao-request-artifact-1', id: requestId, ...(correlation ? { requestContext: correlation } : {}), directory: root, contentDirectory: path.resolve(contentDirectory), files: [...files], diagnostics, finalBodyCaptured, finalBodyStatus, toolCalls, ...times, ...counts });
  const observe = event => serial(async () => {
    if (closed) throw new Error('请求工件已结束');
    const at = event.at ?? clock(), { type, text, ...details } = event;
    if (type === 'raw-chunk') {
      if (diagnostics) await sink(`transport-${event.index ?? 1}.txt`)(String(text ?? ''));
    }
    else if (type === 'text-delta' || type === 'reasoning-delta') {
      const final = type === 'text-delta';
      const body = String(text ?? '');
      if (body.length && (final || diagnostics)) await sink(final ? 'final.txt' : 'reasoning.txt')(body);
      counts[final ? 'textCharacters' : 'reasoningCharacters'] += body.length;
      if (final && body.length) { finalBodyCaptured = true; finalBodyStatus = 'partial'; }
      if (body.length) times.firstOutputAt ??= at;
    } else if (type === 'tool-calls') {
      if (!Array.isArray(event.calls) || !event.calls.length) return;
      await json('tool-calls.json', event.calls);
      toolCalls = event.calls.length;
      if (!times.firstOutputAt || at < times.firstOutputAt) times.firstOutputAt = at;
      if (!files.includes('tool-calls.json')) files.push('tool-calls.json');
    } else {
      const timeKeys = { queued: 'queuedAt', cooldown: 'cooldownAt', prepared: 'preparedAt', send: 'sentAt', headers: 'responseAt', 'body-start': 'firstBodyAt', 'body-end': 'bodyEndedAt', parsed: 'parsedAt', accepted: 'acceptedAt' };
      if (timeKeys[type]) times[timeKeys[type]] ??= at;
      const record = clean({ type, at, ...(diagnostics ? details : eventSummary(details, secrets)) });
      await appendFile(path.join(root, 'events.jsonl'), `${JSON.stringify(diagnostics ? await storeRequestMaterial(record, contentStore) : record)}\n`, 'utf8');
    }
  });
  const complete = (status, value, responseMetadata = {}) => serial(async () => {
    if (closed) return reference();
    for (const flush of sinks.values()) await flush('', true);
    closed = true; times.finishedAt = clock();
    const error = status === 'failed' ? errorSummary(value, secrets) : undefined;
    if (finalBodyCaptured) {
      const interrupted = !times.bodyEndedAt || ['transport', 'timeout', 'cancelled'].includes(value?.category);
      finalBodyStatus = status === 'received' || !interrupted ? 'complete' : 'partial';
    }
    files.push('result.json');
    await json('result.json', { status, ...(error ? { error } : {}), summary: responseSummary({ ...value, ...responseMetadata }, secrets), ...reference() });
    return reference();
  });
  return { observe, reference, finish: value => complete('received', value), fail: (error, responseMetadata) => complete('failed', error, responseMetadata) };
}
