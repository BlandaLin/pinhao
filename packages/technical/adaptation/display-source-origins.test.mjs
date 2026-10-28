import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDisplaySourceResolver } from './source-origins.mjs';
import { createDisplayVerifier } from './display-review.mjs';

test('host source receipts reuse facts across request copies and still track original consumer and listing changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const original = path.join(directory, 'game'), workspaceDir = path.join(directory, 'project');
  const copies = ['request-a', 'request-b'].map(id => path.join(workspaceDir, 'technical', id, 'source'));
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, 'scene.json'), '{"text":"A real caption."}');
  const consumer = 'drawCaption(JSON.parse(readText("scene.json")).text);';
  await writeFile(path.join(original, 'consumer.js'), consumer);
  for (const copy of copies) {
    await cp(original, copy, { recursive: true });
    const files = await Promise.all(['scene.json', 'consumer.js'].map(async relative => ({ relative, sourceIndex: 0,
      sha256: createHash('sha256').update(await readFile(path.join(original, relative))).digest('hex') })));
    await writeFile(`${copy}.snapshot.json`, JSON.stringify({ source: original, files }));
  }
  let calls = 0;
  const verifier = createDisplayVerifier({ projectFor: () => ({ id: 'project', workspaceDir, engine: 'fixture' }),
    connectionFor: () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }), readRootsFor: () => [original],
    sourceResolverFor: ({ input, roots }) => createDisplaySourceResolver({ projectId: 'project', roots, sourceCopyPath: input.gameDir, allowedSourceRoots: [original] }),
    generate: async ({ tools, prompt }) => {
      calls++;
      await tools.list_files.execute({ sourceIndex: 0, relativePath: '', recursive: true });
      const source = await tools.read_resource.execute({ file: 'scene.json', sourceIndex: 0 });
      const shown = await tools.read_resource.execute({ file: 'consumer.js', sourceIndex: 0 });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'Independent source and actual consumer were read.', evidenceIds: [source.receiptId], consumerEvidenceIds: [shown.receiptId] })) });
    } });
  const input = index => ({ projectId: 'project', gameDir: copies[index], workspaceDir,
    candidate: { codeHash: `code-${index}`, candidateId: `candidate-${index}`, manifest: { engine: 'fixture' } },
    units: [{ id: `unit-${index}`, source: 'A real caption.', locator: { file: 'scene.json', pointer: '/text' } }] });
  const first = await verifier(input(0)); assert.equal(first.status, 'passed'); assert.equal(calls, 1);
  const second = await verifier(input(1)); assert.equal(second.status, 'passed'); assert.equal(calls, 1, 'a new request copy is not a new original');
  assert.equal(second.decisions[0].reused, true);
  await writeFile(path.join(original, 'consumer.js'), 'persistAsSaveKey(data.text);');
  assert.equal(await verifier.isFresh(second, input(1)), false, 'a stale original consumer cannot hide behind unchanged copied bytes');
  await writeFile(path.join(original, 'consumer.js'), consumer);
  assert.equal(await verifier.isFresh(second, input(1)), true);
  await writeFile(path.join(original, 'new-loader.js'), 'enableNewConsumer();');
  assert.equal(await verifier.isFresh(second, input(1)), false, 'new files in an observed original scope invalidate the closure');
});

test('a copy receipt cannot bind an unauthorized root or changed original', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-origin-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const original = path.join(directory, 'original'), copy = path.join(directory, 'copy'), other = path.join(directory, 'other');
  for (const root of [original, copy, other]) await mkdir(root);
  await writeFile(path.join(original, 'text.txt'), 'Original'); await writeFile(path.join(copy, 'text.txt'), 'Original');
  const sha256 = createHash('sha256').update('Original').digest('hex');
  await writeFile(`${copy}.snapshot.json`, JSON.stringify({ source: other, files: [{ relative: 'text.txt', sha256 }] }));
  await assert.rejects(createDisplaySourceResolver({ projectId: 'p', roots: [copy], sourceCopyPath: copy, allowedSourceRoots: [original] }), { code: 'DISPLAY_SOURCE_STALE' });
  await writeFile(`${copy}.snapshot.json`, JSON.stringify({ source: original, files: [{ relative: 'text.txt', sha256 }] }));
  const resolver = await createDisplaySourceResolver({ projectId: 'p', roots: [copy], sourceCopyPath: copy, allowedSourceRoots: [original] });
  await writeFile(path.join(original, 'text.txt'), 'Changed');
  await assert.rejects(resolver.resolve({ file: 'text.txt', sourceIndex: 0 }), { code: 'DISPLAY_SOURCE_STALE' });
});

test('representation dependencies use the exact original root only after copied carriers match their receipts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-representation-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const original = path.join(directory, 'original'), other = path.join(directory, 'other'), copy = path.join(directory, 'copy');
  for (const root of [original, other, copy]) await mkdir(root);
  await writeFile(path.join(original, 'scene.json'), '{"text":"Caption"}');
  await writeFile(path.join(original, 'loader.js'), 'show(scene.text);');
  await writeFile(path.join(other, 'second.json'), '{"text":"Other"}');
  await cp(path.join(original, 'scene.json'), path.join(copy, 'scene.json'));
  await cp(path.join(other, 'second.json'), path.join(copy, 'second.json'));
  const files = await Promise.all([['scene.json', 0, original], ['second.json', 1, other]].map(async ([relative, sourceIndex, root]) => ({ relative, sourceIndex,
    sha256: createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex') })));
  await writeFile(`${copy}.snapshot.json`, JSON.stringify({ sourceRoots: [original, other], files }));
  const resolver = await createDisplaySourceResolver({ projectId: 'p', roots: [copy], sourceCopyPath: copy, allowedSourceRoots: [original, other] });
  assert.equal(await resolver.resolveRoot({ files: ['scene.json'] }), original);
  await assert.rejects(readFile(path.join(copy, 'loader.js')), { code: 'ENOENT' });
  await assert.rejects(resolver.resolveRoot({ files: ['scene.json', 'second.json'] }), { code: 'EMBEDDED_REPRESENTATION_PENDING' });
  await assert.rejects(resolver.resolveRoot({ files: ['loader.js'] }), { code: 'DISPLAY_SOURCE_STALE' });
  await writeFile(path.join(copy, 'scene.json'), '{"text":"Changed copy"}');
  await assert.rejects(resolver.resolveRoot({ files: ['scene.json'] }), { code: 'DISPLAY_SOURCE_STALE' });
  await writeFile(path.join(copy, 'scene.json'), '{"text":"Caption"}');
  await writeFile(path.join(original, 'scene.json'), '{"text":"Changed original"}');
  await assert.rejects(resolver.resolveRoot({ files: ['scene.json'] }), { code: 'DISPLAY_SOURCE_STALE' });
});

test('observed missing source and listing dependencies invalidate even when the final verdict cites other evidence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-display-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'project');
  await mkdir(gameDir); await writeFile(path.join(gameDir, 'scene.json'), '{"text":"A caption.","consumer":"draw(text)"}');
  const copy = path.join(workspaceDir, 'technical', 'request', 'source');
  await cp(gameDir, copy, { recursive: true });
  const sha256 = createHash('sha256').update(await readFile(path.join(gameDir, 'scene.json'))).digest('hex');
  await writeFile(`${copy}.snapshot.json`, JSON.stringify({ source: gameDir, files: [{ relative: 'scene.json', sha256 }] }));
  const verifier = createDisplayVerifier({ projectFor: () => ({ id: 'p', workspaceDir }),
    connectionFor: () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }),
    readRootsFor: () => [gameDir],
    sourceResolverFor: ({ roots }) => createDisplaySourceResolver({ projectId: 'p', roots, sourceCopyPath: copy, allowedSourceRoots: [gameDir] }),
    generate: async ({ tools, prompt }) => {
      await assert.rejects(tools.read_resource.execute({ file: 'optional-loader.js', sourceIndex: 0 }), { code: 'ENOENT' });
      await assert.rejects(tools.list_files.execute({ relativePath: 'optional', sourceIndex: 0 }), { code: 'ENOENT' });
      const source = await tools.read_resource.execute({ file: 'scene.json', sourceIndex: 0 });
      await tools.finish_review.execute({ decisions: JSON.parse(prompt).units.map(row => ({ ref: row.ref, status: 'display-supported',
        reason: 'The inline consumer renders the caption.', evidenceIds: [source.receiptId], consumerEvidenceIds: [source.receiptId] })) });
    } });
  const input = { projectId: 'p', gameDir: copy, workspaceDir, candidate: { candidateId: 'missing-test', codeHash: 'code' },
    units: [{ id: 'a', source: 'A caption.', locator: { file: 'scene.json', pointer: '/text' } }] };
  const record = await verifier(input); assert.equal(record.status, 'passed');
  assert.equal(record.dependencies.filter(item => item.kind === 'missing').length, 2);
  assert.equal(await verifier.isFresh(record, input), true);
  await writeFile(path.join(gameDir, 'optional-loader.js'), 'renderAdditionalConsumer();');
  assert.equal(await verifier.isFresh(record, input), false);
  await rm(path.join(gameDir, 'optional-loader.js')); await mkdir(path.join(gameDir, 'optional'));
  assert.equal(await verifier.isFresh(record, input), false);
});
