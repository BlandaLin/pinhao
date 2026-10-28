import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeTools } from './native-tools.mjs';
import { sha256 } from '../exchange/index.mjs';

const parent = path.resolve('local', 'native-tools-tests');
await mkdir(parent, { recursive: true });
const sourceFile = 'data/source.json';
const unitsFor = count => Array.from({ length: count }, (_, index) => ({
  id: `native:${index}`, kind: 'message', source: `A complete neutral source line ${index}.`, tokens: [],
  context: { file: index % 2 ? 'data/Map002.json' : 'data/Map001.json', event: index },
}));

async function fixture(t, { unitCount = 4 } = {}) {
  const directory = await mkdtemp(path.join(parent, 'case-'));
  const gameDir = path.join(directory, 'game'), workDir = path.join(directory, 'task');
  await mkdir(path.join(gameDir, 'data'), { recursive: true }); await mkdir(workDir);
  const source = JSON.stringify({ text: 'The current source baseline.' });
  await writeFile(path.join(gameDir, sourceFile), source);
  const units = unitsFor(unitCount), probe = { engine: 'RPG Maker MZ', root: '.', capabilities: { extract: true, nativeBuild: true } };
  const calls = { probe: 0, extract: 0, roundtrip: 0, signals: [] };
  let validation = { passed: true, byteIdentical: true }, extraction;
  const worker = async (command, input, options) => {
    calls.signals.push(options?.signal);
    options?.signal?.throwIfAborted();
    if (command === 'probe') { calls.probe++; return { ok: true, result: probe }; }
    if (command === 'extract') {
      calls.extract++;
      assert.equal(input.allowEmpty, true);
      await mkdir(path.join(input.workspaceDir, 'technical'), { recursive: true });
      await writeFile(path.join(input.workspaceDir, 'manifest.json'), JSON.stringify({ engine: probe.engine, version: 1 }));
      await writeFile(path.join(input.workspaceDir, 'technical', 'product-source.json'), JSON.stringify({ sourceFiles: { [sourceFile]: sha256(source) } }));
      extraction = { workspaceDir: input.workspaceDir, units, files: ['data/Map001.json', 'data/Map002.json'], sourceFingerprint: sha256(source) };
      return { ok: true, result: extraction };
    }
    if (command === 'roundtrip') { calls.roundtrip++; return { ok: true, result: validation }; }
    throw new Error(`Unexpected neutral native command ${command}`);
  };
  const tools = createNativeTools({ worker });
  const input = { gameDir, workDir, args: [] };
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  return { directory, gameDir, workDir, units, probe, calls, worker, tools, input,
    get extraction() { return extraction; }, setValidation: value => { validation = value; } };
}

test('native extraction keeps 35000 source units on the host and returns compact metadata', async t => {
  const f = await fixture(t, { unitCount: 35000 });
  const result = await f.tools.trustedTools.native_extract.execute(f.input);
  assert.equal(result.unitCount, 35000); assert.match(result.nativeResultId, /^native-/);
  assert.equal(result.units, undefined); assert.equal(result.extraction, undefined);
  const summary = JSON.stringify(result);
  assert.ok(summary.length < 2048); assert.equal(summary.includes(f.units[0].source), false);
  assert.equal(summary.includes(f.units.at(-1).source), false);
  const record = JSON.parse(await readFile(path.join(f.workDir, 'host-native-result.json'), 'utf8'));
  assert.equal(record.extraction.units.length, 35000); assert.equal(record.extraction.units.at(-1).source, f.units.at(-1).source);
  assert.equal(f.calls.extract, 1);
});

test('native inspection pages and filters original units with bounded limits', async t => {
  const f = await fixture(t, { unitCount: 120 });
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  const inspect = f.tools.trustedTools.native_inspect;
  const initial = await inspect.execute({ ...f.input, args: [] });
  assert.equal(initial.nativeResultId, extracted.nativeResultId); assert.equal(initial.total, 120);
  assert.equal(initial.units.length, 20); assert.equal(initial.nextOffset, 20);
  const filtered = await inspect.execute({ ...f.input, args: ['--file', 'data\\Map001.json', '--offset', '2', '--limit', '3'] });
  assert.equal(filtered.total, 60); assert.equal(filtered.offset, 2); assert.equal(filtered.nextOffset, 5);
  assert.deepEqual(filtered.units.map(unit => unit.id), ['native:4', 'native:6', 'native:8']);
  const last = await inspect.execute({ ...f.input, args: ['--offset', '119', '--limit', '50'] });
  assert.equal(last.units.length, 1); assert.equal(last.nextOffset, null);
  for (const args of [['--limit', '51'], ['--offset', '-1'], ['--limit', '1.5'], ['--offset'], ['--offset', '0', '--offset', '1'], ['--file', '../private.json'], ['--file', 'C:\\private.json']]) {
    assert.equal(inspect.validateArgs(args), false, JSON.stringify(args));
    await assert.rejects(inspect.execute({ ...f.input, args }), /参数|分页|范围|相对/);
  }
});

test('native inspection matches carriers and virtual files while preserving stable IDs and pagination', async t => {
  const f = await fixture(t, { unitCount: 3 });
  await f.tools.trustedTools.native_extract.execute(f.input);
  for (let index = 0; index < 2; index++) {
    f.units[index].file = `__unity_text__/${index}.json`;
    f.units[index].context = { carrier: 'Game_Data/level0' };
  }
  const inspect = f.tools.trustedTools.native_inspect;
  const first = await inspect.execute({ ...f.input, args: ['--file', 'Game_Data\\level0', '--limit', '1'] });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  assert.equal(first.units[0].id, 'native:0'); assert.equal(first.units[0].carrier, 'Game_Data/level0');
  const last = await inspect.execute({ ...f.input, args: ['--file', 'Game_Data/level0', '--offset', '1', '--limit', '1'] });
  assert.equal(last.units[0].id, 'native:1'); assert.equal(last.nextOffset, null);
  const virtual = await inspect.execute({ ...f.input, args: ['--file', '__unity_text__/1.json'] });
  assert.equal(virtual.total, 1); assert.equal(virtual.units[0].id, 'native:1');
  const absent = await inspect.execute({ ...f.input, args: ['--file', 'Game_Data/level1'] });
  assert.equal(absent.total, 0); assert.equal(absent.filter.meaning, 'matching-records-only');
});

test('native acceptance performs roundtrip and resolves the exact host-held result', async t => {
  const f = await fixture(t);
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: extracted.nativeResultId }), /已通过/);
  const accepted = await f.tools.trustedTools.native_accept.execute(f.input);
  assert.equal(accepted.acceptedNativeResultId, extracted.nativeResultId); assert.equal(accepted.unitCount, f.units.length);
  assert.equal(accepted.units, undefined); assert.equal(accepted.extraction, undefined);
  assert.equal(f.calls.roundtrip, 1);
  const resolved = await f.tools.resolveNativeResult({ ...f.input, resultId: accepted.acceptedNativeResultId });
  assert.equal(resolved.extraction, f.extraction); assert.deepEqual(resolved.probe, f.probe);
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: 'native-forged' }), /本任务/);
});

test('native Agent acceptance uses the same explicit semantic roundtrip contract as normal import', async t => {
  const f = await fixture(t);
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  f.setValidation({ byteIdentical: false, nativeSemanticRoundtrip: true, status: 'native_roundtrip_structurally_equal' });
  const accepted = await f.tools.trustedTools.native_accept.execute(f.input);
  assert.equal(accepted.acceptedNativeResultId, extracted.nativeResultId);
  const resolved = await f.tools.resolveNativeResult({ ...f.input, resultId: accepted.acceptedNativeResultId });
  assert.deepEqual(resolved.extraction.units, f.units);
  f.setValidation({ byteIdentical: false, nativeSemanticRoundtrip: true, status: 'native_roundtrip_structurally_equal', passed: false });
  await assert.rejects(f.tools.trustedTools.native_accept.execute(f.input), /回写检查/);
});

for (const validation of [{ passed: false }, { valid: false }, { byteIdentical: false }]) test(`failed native roundtrip ${JSON.stringify(validation)} cannot be accepted or resolved`, async t => {
  const f = await fixture(t);
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  f.setValidation(validation);
  await assert.rejects(f.tools.trustedTools.native_accept.execute(f.input), /回写检查/);
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: extracted.nativeResultId }), /已通过/);
  assert.equal(f.calls.roundtrip, 1);
});

test('persisted native extraction loads in another instance without repeating extraction', async t => {
  const f = await fixture(t);
  const first = await f.tools.trustedTools.native_extract.execute(f.input);
  const reopened = createNativeTools({ worker: f.worker });
  const reused = await reopened.trustedTools.native_extract.execute(f.input);
  assert.equal(reused.reused, true); assert.equal(reused.nativeResultId, first.nativeResultId);
  assert.equal(f.calls.extract, 1); assert.equal(f.calls.probe, 1);
  const inspected = await reopened.trustedTools.native_inspect.execute(f.input);
  assert.equal(inspected.units[0].source, f.units[0].source);
  const accepted = await reopened.trustedTools.native_accept.execute(f.input);
  const resolved = await reopened.resolveNativeResult({ ...f.input, resultId: accepted.acceptedNativeResultId });
  assert.deepEqual(resolved.extraction.units, f.units);
});

for (const mutation of ['manifest', 'source']) test(`changed ${mutation} rejects cached native inspection, acceptance and host resolve`, async t => {
  const f = await fixture(t);
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  await f.tools.trustedTools.native_accept.execute(f.input);
  const file = mutation === 'manifest' ? path.join(f.extraction.workspaceDir, 'manifest.json') : path.join(f.gameDir, sourceFile);
  await writeFile(file, 'changed baseline');
  for (const operation of [
    () => f.tools.trustedTools.native_extract.execute(f.input),
    () => f.tools.trustedTools.native_inspect.execute(f.input),
    () => f.tools.trustedTools.native_accept.execute(f.input),
    () => f.tools.resolveNativeResult({ ...f.input, resultId: extracted.nativeResultId }),
  ]) await assert.rejects(operation(), /已改变/);
  assert.equal(f.calls.extract, 1, 'A mismatched baseline requires a fresh task rather than silent replacement');
});

test('host-seeded existing workbench can live outside the model task workspace', async t => {
  const f = await fixture(t);
  const external = path.join(f.directory, 'host-existing-workbench');
  await mkdir(external); await writeFile(path.join(external, 'manifest.json'), '{"units":{}}');
  const extraction = { workspaceDir: external, units: f.units, sourceFingerprint: sha256('seeded') };
  await f.tools.seed({ ...f.input, extraction, probe: f.probe });
  const reused = await f.tools.trustedTools.native_extract.execute(f.input);
  assert.equal(reused.reused, true); assert.equal(f.calls.extract, 0);
  const accepted = await f.tools.trustedTools.native_accept.execute(f.input);
  assert.equal((await f.tools.resolveNativeResult({ ...f.input, resultId: accepted.acceptedNativeResultId })).extraction, extraction);
  const forged = { format: 'pinhao-native-result-1', id: 'native-forged', gameDir: f.gameDir, probe: f.probe, extraction, manifestHash: sha256(await readFile(path.join(external, 'manifest.json'))) };
  await writeFile(path.join(f.workDir, 'host-native-result.json'), JSON.stringify(forged));
  const reopened = createNativeTools({ worker: f.worker });
  await assert.rejects(reopened.trustedTools.native_inspect.execute(f.input), /独立工作台/);
});

test('native probe reuses the validated full-game stage for a partial resource copy', async t => {
  const f = await fixture(t);
  const external = path.join(f.directory, 'host-probe-stage');
  await mkdir(external); await writeFile(path.join(external, 'manifest.json'), '{"units":{}}');
  let reprobes = 0;
  const tools = createNativeTools({ worker: async () => { reprobes++; return { engine: 'unknown' }; } });
  await tools.seed({ ...f.input, extraction: { workspaceDir: external, units: f.units }, probe: f.probe });
  const result = await tools.trustedTools.native_probe.execute(f.input);
  assert.equal(result.engine, f.probe.engine);
  assert.deepEqual(result.capabilities, f.probe.capabilities);
  assert.equal(reprobes, 0);
  await writeFile(path.join(external, 'manifest.json'), 'changed manifest');
  await assert.rejects(tools.trustedTools.native_probe.execute(f.input), /已改变/);
  assert.equal(reprobes, 0, 'Do not conceal a stale host stage by probing a partial copy');
});

test('native probe uses the current input only without a stored stage and honors cancellation', async t => {
  const f = await fixture(t);
  const initial = await f.tools.trustedTools.native_probe.execute(f.input);
  assert.equal(initial.engine, f.probe.engine);
  assert.equal(f.calls.probe, 1);
  await f.tools.trustedTools.native_extract.execute(f.input);
  const reused = await f.tools.trustedTools.native_probe.execute(f.input);
  assert.equal(reused.engine, f.probe.engine);
  assert.equal(f.calls.probe, 2, 'Only extraction needed the second probe');
  const controller = new AbortController(); controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(f.tools.trustedTools.native_probe.execute({ ...f.input, signal: controller.signal }), { name: 'AbortError' });
});

test('native tools pass cancellation to worker execution and host resolve honors abort', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await f.tools.trustedTools.native_extract.execute({ ...f.input, signal: controller.signal });
  const accepted = await f.tools.trustedTools.native_accept.execute({ ...f.input, signal: controller.signal });
  assert.ok(f.calls.signals.every(signal => signal === controller.signal));
  controller.abort(new DOMException('Fixture cancelled', 'AbortError'));
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: accepted.acceptedNativeResultId, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(f.tools.trustedTools.native_roundtrip.execute({ ...f.input, signal: controller.signal }), { name: 'AbortError' });
});

test('cancellation interrupts an in-flight native roundtrip', async t => {
  const f = await fixture(t);
  await f.tools.trustedTools.native_extract.execute(f.input);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const tools = createNativeTools({ worker: async (command, input, { signal }) => {
    if (command !== 'roundtrip') return f.worker(command, input, { signal });
    entered();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const running = tools.trustedTools.native_accept.execute({ ...f.input, signal: controller.signal });
  await started;
  controller.abort(new DOMException('Fixture stopped during roundtrip', 'AbortError'));
  await assert.rejects(running, { name: 'AbortError' });
});

test('a failed native recheck invalidates an earlier accepted result', async t => {
  const f = await fixture(t);
  const result = await f.tools.trustedTools.native_extract.execute(f.input);
  await f.tools.trustedTools.native_accept.execute(f.input);
  f.setValidation({ passed: false });
  await assert.rejects(f.tools.trustedTools.native_roundtrip.execute(f.input), /回写检查/);
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: result.nativeResultId }), /已通过/);
});

test('releasing a finished task preserves extraction on disk and requires fresh acceptance on resume', async t => {
  const f = await fixture(t);
  const extracted = await f.tools.trustedTools.native_extract.execute(f.input);
  await f.tools.trustedTools.native_accept.execute(f.input);
  const file = path.join(f.workDir, 'host-native-result.json'), before = await readFile(file);
  assert.equal(f.tools.release({ workDir: f.workDir }), 1);
  assert.equal(f.tools.release({ workDir: f.workDir }), 0);
  assert.deepEqual(await readFile(file), before);
  const inspected = await f.tools.trustedTools.native_inspect.execute(f.input);
  assert.equal(inspected.nativeResultId, extracted.nativeResultId);
  assert.deepEqual(inspected.units.map(unit => unit.source), f.units.map(unit => unit.source));
  await assert.rejects(f.tools.resolveNativeResult({ ...f.input, resultId: extracted.nativeResultId }), /已通过/);
  await f.tools.trustedTools.native_accept.execute(f.input);
  assert.deepEqual((await f.tools.resolveNativeResult({ ...f.input, resultId: extracted.nativeResultId })).extraction.units, f.units);
  assert.equal(f.calls.extract, 1);
});

test('release clears task descendants but leaves another concurrent task warm', async t => {
  const f = await fixture(t);
  const child = { ...f.input, workDir: path.join(f.workDir, 'jobs', 'child') };
  const sibling = { ...f.input, workDir: `${f.workDir}-other` };
  await mkdir(child.workDir, { recursive: true }); await mkdir(sibling.workDir);
  for (const input of [f.input, child, sibling]) await f.tools.trustedTools.native_extract.execute(input);
  const siblingResult = await f.tools.trustedTools.native_accept.execute(sibling);
  assert.equal(f.tools.release({ workDir: f.workDir }), 2);
  assert.equal((await f.tools.resolveNativeResult({ ...sibling, resultId: siblingResult.acceptedNativeResultId })).extraction.units.length, f.units.length);
  assert.equal((await f.tools.trustedTools.native_extract.execute(child)).reused, true);
  assert.equal(f.calls.extract, 3);
  assert.equal(f.tools.release(), 2);
  assert.equal(f.tools.release(), 0);
});

test('releasing one finished task does not disturb another task accepting in parallel', async t => {
  const f = await fixture(t);
  const other = { ...f.input, workDir: `${f.workDir}-other` };
  await mkdir(other.workDir);
  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  const continueRoundtrip = new Promise(resolve => { resume = resolve; });
  const tools = createNativeTools({ worker: async (...args) => {
    if (args[0] === 'roundtrip') { entered(); await continueRoundtrip; }
    return f.worker(...args);
  } });
  await Promise.all([f.input, other].map(input => tools.trustedTools.native_extract.execute(input)));
  const accepting = tools.trustedTools.native_accept.execute(other);
  await started;
  assert.equal(tools.release({ workDir: f.workDir }), 1);
  resume();
  const accepted = await accepting;
  assert.equal((await tools.resolveNativeResult({ ...other, resultId: accepted.acceptedNativeResultId })).extraction.units.length, f.units.length);
  assert.equal(f.calls.extract, 2);
  assert.equal(tools.release(), 1);
});

test('released native results still reject changed source and manifest on disk', async t => {
  for (const mutation of ['manifest', 'source']) {
    const f = await fixture(t);
    await f.tools.trustedTools.native_extract.execute(f.input);
    f.tools.release({ workDir: f.workDir });
    await writeFile(mutation === 'manifest' ? path.join(f.extraction.workspaceDir, 'manifest.json') : path.join(f.gameDir, sourceFile), 'changed baseline');
    await assert.rejects(f.tools.trustedTools.native_inspect.execute(f.input), /已改变/);
    assert.equal(f.calls.extract, 1);
  }
});

test('release does not turn a saved external workbench into a trusted seed', async t => {
  const f = await fixture(t);
  const external = path.join(f.directory, 'host-existing-workbench');
  await mkdir(external); await writeFile(path.join(external, 'manifest.json'), '{"units":{}}');
  const extraction = { workspaceDir: external, units: f.units };
  await f.tools.seed({ ...f.input, extraction, probe: f.probe });
  const forged = { format: 'pinhao-native-result-1', id: 'native-forged', gameDir: f.gameDir, probe: f.probe, extraction,
    manifestHash: sha256(await readFile(path.join(external, 'manifest.json'))) };
  await writeFile(path.join(f.workDir, 'host-native-result.json'), JSON.stringify(forged));
  assert.equal(f.tools.release({ workDir: f.workDir }), 1);
  await assert.rejects(f.tools.trustedTools.native_inspect.execute(f.input), /独立工作台/);
  await f.tools.seed({ ...f.input, extraction, probe: f.probe });
  assert.equal((await f.tools.trustedTools.native_extract.execute(f.input)).reused, true);
  assert.equal(f.calls.extract, 0);
});
