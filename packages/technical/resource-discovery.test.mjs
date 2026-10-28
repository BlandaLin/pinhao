import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectReadSources, readSourceSlice } from './adaptation/paths.mjs';
import { isPrivateGamePath } from '../core/private-paths.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-resource-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  await mkdir(path.join(root, 'assets'));
  await mkdir(path.join(root, 'scripts'));
  for (let index = 0; index < 8; index++) await writeFile(path.join(root, 'assets', `${index}.png`), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'scripts', 'main.gd'), 'var caption = "Hello traveller"\nlabel.text = caption\n');
  await writeFile(path.join(root, 'project.godot'), '[application]\n');
  return root;
}

async function discovery(root, options = {}) {
  const { createResourceDiscovery } = await import('./adaptation/resource-discovery.mjs');
  return createResourceDiscovery({
    list: input => inspectReadSources(root, input),
    read: input => readSourceSlice(root, input.file, input),
    ...options,
  });
}

test('shallow source listing exposes directory entries instead of a recursive resource prefix', async t => {
  const root = await fixture(t);
  const page = await inspectReadSources(root, { recursive: false, limit: 20 });
  assert.deepEqual(page.files.map(row => [row.path, row.kind]), [
    ['assets', 'directory'], ['project.godot', 'file'], ['scripts', 'directory'],
  ]);
  assert.equal(page.nextOffset, null);
  const nested = await inspectReadSources(root, { relativePath: 'scripts', recursive: true });
  assert.deepEqual(nested.files.map(row => row.path), ['scripts/main.gd']);
});

test('an exact file scope remains a file and never expands to the parent directory', async t => {
  const root = await fixture(t);
  const page = await inspectReadSources(root, { relativePath: 'scripts/main.gd', allowFile: true });
  assert.equal(page.files.length, 1);
  assert.equal(page.files[0].path, 'scripts/main.gd');
  await assert.rejects(inspectReadSources(root, { relativePath: 'scripts/main.gd' }), error => error.code === 'ENOTDIR');
  const result = await (await discovery(root)).search({ relativePath: 'scripts/main.gd', query: 'caption', content: true });
  assert.deepEqual([...new Set(result.items.map(row => row.file))], ['scripts/main.gd']);
  assert.equal(result.relativePath, 'scripts/main.gd');
  assert.equal(result.mode, 'content');
});

test('search requires an explicit path or content mode and echoes the actual query and scope', async t => {
  const root = await fixture(t), api = await discovery(root);
  await assert.rejects(api.search({ query: 'caption' }), /content/);
  const result = await api.search({ query: 'missing consumer', content: false, relativePath: 'scripts' });
  assert.equal(result.query, 'missing consumer');
  assert.equal(result.content, false);
  assert.equal(result.mode, 'path');
  assert.equal(result.relativePath, 'scripts');
  assert.equal(result.offset, 0);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.items, []);
});

test('path discovery reads no binary content and can find files beyond an unrelated directory', async t => {
  const root = await fixture(t);
  let reads = 0;
  const api = await discovery(root, { read: async () => { reads++; throw new Error('Path search must not read content'); } });
  const result = await api.search({ query: '\\.gd$', matchMode: 'regex', content: false, relativePath: 'scripts' });
  assert.deepEqual(result.items.map(row => row.file), ['scripts/main.gd']);
  assert.equal(reads, 0);
  assert.equal(result.inspected, 0);
});

test('search sourceIndex selects the actual alternate origin without changing the relative scope', async t => {
  const root = await fixture(t), alternate = path.join(root, 'alternate');
  await mkdir(path.join(alternate, 'scripts'), { recursive: true });
  await writeFile(path.join(alternate, 'scripts', 'main.gd'), 'Alternate display consumer\n');
  const api = await discovery(root, {
    list: input => inspectReadSources(root, { sourceRoots: [alternate], ...input }),
    read: input => readSourceSlice(root, input.file, { sourceRoots: [alternate], ...input }),
  });
  const result = await api.search({ route: 'script', query: 'Alternate', content: true, relativePath: 'scripts/main.gd', sourceIndex: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.route, 'script');
  assert.equal(result.items[0].sourceIndex, 1);
  assert.match(result.items[0].snippet, /Alternate/);
});

test('per-file match truncation is explicit and provides a real content continuation', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'scripts', 'many.gd'), 'target one\ntarget two\ntarget three\n');
  const api = await discovery(root, { limits: { maxMatchesPerFile: 1 } });
  const result = await api.search({ relativePath: 'scripts/many.gd', query: 'target', content: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.nextOffset, null, 'the file-list cursor can be finished while its contents remain partial');
  assert.equal(result.partial.length, 1);
  assert.equal(result.partial[0].reason, 'file-match-limit');
  assert.equal(result.partial[0].nextRead.tool, 'read_resource');
  assert.equal(result.partial[0].nextRead.input.file, 'scripts/many.gd');
  assert.ok(result.partial[0].nextRead.input.offset > 0);
  assert.ok(result.partial[0].nextRead.input.offset < result.partial[0].totalBytes);
});

test('content and total-byte budgets mark unsearched bytes without pretending the file is complete', async t => {
  const root = await fixture(t);
  const content = '第一行\nSecond target\nThird target\n';
  await writeFile(path.join(root, 'scripts', 'unicode.gd'), content);
  const api = await discovery(root, { limits: { maxContentBytes: 16, scanBytes: 16 } });
  const result = await api.search({ relativePath: 'scripts/unicode.gd', query: 'target', content: true });
  assert.ok(result.bytesScanned <= 16);
  assert.equal(result.partial.length, 1);
  const next = result.partial[0].nextRead.input;
  assert.equal(next.offset, result.bytesScanned, 'a bounded partial line resumes after the bytes actually searched');
  const remainder = await readSourceSlice(root, next.file, { offset: next.offset });
  assert.ok(!remainder.content.includes('\uFFFD'), 'continuation remains on a UTF-8 byte boundary');
  assert.equal(result.partial[0].totalBytes, Buffer.byteLength(content));
});

test('binary and oversized files are counted before reading, while literal brackets remain literal', async t => {
  const root = await fixture(t);
  let binaryReads = 0;
  const api = await discovery(root, { limits: { maxFileBytes: 20 }, read: input => {
    if (input.file.endsWith('.png')) binaryReads++;
    return readSourceSlice(root, input.file, input);
  } });
  const result = await api.search({ query: '[', content: true });
  assert.equal(binaryReads, 0);
  assert.equal(result.skipped.binary, 8);
  assert.equal(result.skipped.oversized, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].file, 'project.godot');
});

test('exact-file scopes obey the same private and excluded-prefix boundaries as directory discovery', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'save'));
  await writeFile(path.join(root, 'save', 'slot.json'), '{"private":"do not discover"}');
  const privatePage = await inspectReadSources(root, { relativePath: 'save/slot.json', allowFile: true, excludePath: isPrivateGamePath });
  assert.deepEqual(privatePage.files, []);
  const excluded = await inspectReadSources(root, { relativePath: 'scripts/main.gd', allowFile: true, excludePrefixes: ['scripts'] });
  assert.deepEqual(excluded.files, []);
});

test('resource routes filter files before pagination while shallow directories remain navigable', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'scripts', 'second.gd'), 'label.text = "Another heading"\n');
  const api = await discovery(root), paths = [];
  let offset = 0;
  do {
    const page = await api.list({ route: 'script', recursive: true, limit: 1, offset });
    assert.equal(page.route, 'script');
    assert.equal(page.files.length, 1);
    assert.equal(page.files[0].route, 'script');
    paths.push(page.files[0].path);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(paths, ['scripts/main.gd', 'scripts/second.gd']);
  const shallow = await api.list({ route: 'script' });
  assert.deepEqual(shallow.files.map(row => [row.path, row.kind]), [['assets', 'directory'], ['scripts', 'directory']]);
  const excluded = await inspectReadSources(root, { relativePath: 'project.godot', route: 'script', allowFile: true });
  assert.deepEqual(excluded.files, []);
  assert.ok((await api.list({ recursive: true })).files.some(row => row.path.endsWith('.png')), 'no filter still exposes media paths');
});

test('route-filtered multi-source pages preserve same-name origins and selected-source access', async t => {
  const root = await fixture(t), alternate = path.join(root, 'alternate');
  await mkdir(path.join(alternate, 'scripts'), { recursive: true });
  await writeFile(path.join(alternate, 'scripts', 'main.gd'), 'alternate consumer\n');
  await writeFile(path.join(alternate, 'scripts', 'extra.gd'), 'extra consumer\n');
  await writeFile(path.join(alternate, 'scripts', 'not-script.json'), '{"caption":"retained elsewhere"}');
  const options = { sourceRoots: [alternate], relativePath: 'scripts', route: 'script', recursive: true, limit: 1 };
  const first = await inspectReadSources(root, options);
  const second = await inspectReadSources(root, { ...options, offset: first.nextOffset });
  assert.deepEqual([...first.files, ...second.files].map(row => row.path), ['scripts/extra.gd', 'scripts/main.gd']);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(second.files[0].origins.map(row => row.sourceIndex), [0, 1]);
  const selected = await inspectReadSources(root, { ...options, sourceIndex: 1, offset: 1 });
  assert.equal(selected.files[0].sourceIndex, 1);
  assert.equal(selected.files[0].route, 'script');
  assert.equal((await readSourceSlice(root, selected.files[0].path, { sourceRoots: [alternate], sourceIndex: 1 })).content, 'alternate consumer\n');
});

test('route-aware search continuations preserve scope without scanning unrelated media', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'scripts', 'second.gd'), 'label.text = "Another heading"\n');
  const api = await discovery(root, { limits: { contentFiles: 1 } });
  const first = await api.search({ route: 'script', content: true, query: 'label.text' });
  assert.equal(first.route, 'script');
  assert.equal(first.nextCall.input.route, 'script');
  assert.equal(first.items[0].route, 'script');
  assert.equal(first.items[0].nextRead.input.route, undefined, 'reading evidence does not take a discovery filter');
  const second = await api.search(first.nextCall.input);
  assert.deepEqual([...new Set([...first.items, ...second.items].map(row => row.file))], ['scripts/main.gd', 'scripts/second.gd']);
  assert.equal(second.nextOffset, null);
  assert.equal(first.skipped.binary + second.skipped.binary, 0);
  for (const route of ['all', 'not-a-route']) {
    await assert.rejects(api.list({ route }), error => error.code === 'INVALID_RESOURCE_ROUTE');
    await assert.rejects(api.search({ route, content: false, query: 'main' }), error => error.code === 'INVALID_RESOURCE_ROUTE');
  }
});

test('ambiguous extensions stay searchable while compiled containers require decoding rather than raw UTF8 search', async t => {
  const root = await fixture(t), reads = [];
  for (const file of ['story.dat', 'story.bin', 'bitmap.fnt']) await writeFile(path.join(root, file), 'visible heading\n');
  await writeFile(path.join(root, 'compiled.gdc'), Buffer.from([0x47, 0x44, 0x53, 0, 1]));
  const api = await discovery(root, { read: input => { reads.push(input.file); return readSourceSlice(root, input.file, input); } });
  for (const file of ['story.dat', 'story.bin', 'bitmap.fnt']) {
    const result = await api.search({ relativePath: file, content: true, query: 'visible heading' });
    assert.equal(result.items.length, 1, `${file} must be checked by content, not permanently excluded by its suffix`);
  }
  const compiled = await api.search({ relativePath: 'compiled.gdc', content: true, query: 'GDS' });
  assert.equal(compiled.skipped.binary, 1);
  assert.ok(!reads.includes('compiled.gdc'));
  assert.equal((await api.list({ route: 'container', recursive: true })).files[0].path, 'compiled.gdc');
  assert.ok((await readSourceSlice(root, 'compiled.gdc', { encoding: 'base64' })).returnedBytes > 0, 'routing never removes raw read capability');
});

test('a late match in a long Unicode line gives a centered snippet and executable UTF-8 read location', async t => {
  const root = await fixture(t), alternate = path.join(root, 'alternate');
  await mkdir(path.join(alternate, 'scripts'), { recursive: true });
  const target = '目標メニュー';
  const content = `先頭😀\r\n${'漢😀'.repeat(600)}直前😀${target}直後${'末😀'.repeat(300)}\n`;
  await writeFile(path.join(alternate, 'scripts', 'late.gd'), content);
  const api = await discovery(root, { root: 'source',
    list: input => inspectReadSources(root, { sourceRoots: [alternate], ...input }),
    read: input => readSourceSlice(root, input.file, { sourceRoots: [alternate], ...input }),
  });
  const result = await api.search({ query: target, content: true, relativePath: 'scripts/late.gd', sourceIndex: 1 });
  assert.equal(result.items.length, 1);
  const item = result.items[0], expectedOffset = Buffer.byteLength(content.slice(0, content.indexOf(target)));
  assert.ok(content.indexOf(target) > 500);
  assert.ok(item.snippet.includes(target), 'the snippet must contain the actual match, not the beginning of its long line');
  assert.ok(item.snippet.length <= 500);
  assert.equal(item.line, 2);
  assert.equal(item.matchOffset, expectedOffset);
  assert.equal(item.matchLengthBytes, Buffer.byteLength(target));
  assert.equal(Buffer.from(content).subarray(item.snippetStartOffset, item.snippetStartOffset + Buffer.byteLength(item.snippet)).toString('utf8'), item.snippet);
  const next = item.nextRead;
  assert.equal(next.tool, 'read_resource');
  assert.deepEqual(Object.keys(next.input).sort(), ['file', 'length', 'offset', 'root', 'sourceIndex']);
  assert.equal(next.input.root, 'source');
  assert.equal(next.input.sourceIndex, 1);
  assert.equal(next.input.length, 65536);
  assert.equal(next.input.offset, item.snippetStartOffset);
  const actual = await readSourceSlice(root, next.input.file, { sourceRoots: [alternate], ...next.input });
  assert.ok(actual.content.includes(target));
  assert.ok(!actual.content.includes('\uFFFD'), 'navigation never begins inside a UTF-8 character');
  assert.deepEqual(result.partial, []);
  assert.equal(result.nextOffset, null);
});

test('literal regular-expression characters retain exact match bytes and reviewer-compatible navigation', async t => {
  const root = await fixture(t), target = '[対話';
  const content = `${'序😀'.repeat(300)}${target}本文\n`;
  await writeFile(path.join(root, 'scripts', 'literal.gd'), content);
  const result = await (await discovery(root)).search({ query: target, content: true, relativePath: 'scripts/literal.gd' });
  const item = result.items[0];
  assert.ok(item.snippet.includes(target));
  assert.equal(item.matchOffset, Buffer.byteLength(content.slice(0, content.indexOf(target))));
  assert.equal(item.matchLengthBytes, Buffer.byteLength(target));
  assert.deepEqual(Object.keys(item.nextRead.input).sort(), ['file', 'length', 'offset']);
  const actual = await readSourceSlice(root, item.nextRead.input.file, item.nextRead.input);
  assert.ok(actual.content.includes(target));
  assert.ok(!actual.content.includes('\uFFFD'));
});

test('code searches default to literal characters instead of producing regex character-class false positives', async t => {
  const root = await fixture(t), file = 'scripts/consumer.gd';
  await writeFile(path.join(root, file), 'var cache = 1\nvar camera = 2\nlabel.text = data["terrain"]\nlabel.text = c["name"]\n');
  const api = await discovery(root);
  for (const query of ['["terrain"]', 'c["name"]']) {
    const literal = await api.search({ query, content: true, relativePath: file });
    assert.equal(literal.items.length, 1);
    assert.equal(literal.matchMode, 'literal');
    assert.ok(literal.items[0].snippet.includes(query));
    assert.equal(literal.items[0].matchLengthBytes, Buffer.byteLength(query));
    const regex = await api.search({ query, matchMode: 'regex', content: true, relativePath: file });
    assert.equal(regex.matchMode, 'regex');
    assert.ok(regex.items.length > literal.items.length, 'explicit regex remains available but has different semantics');
  }
});

test('invalid explicit regex is a clear error, while literal whitespace and brackets are not rewritten', async t => {
  const root = await fixture(t), file = 'scripts/spaces.gd', query = '  c["name"]  ';
  await writeFile(path.join(root, file), `label.text =${query}# comment\n`);
  const api = await discovery(root);
  await assert.rejects(api.search({ query: '[', matchMode: 'regex', content: true, relativePath: file }), error => error.code === 'INVALID_SEARCH_PATTERN');
  const result = await api.search({ query, content: true, relativePath: file });
  assert.equal(result.query, query);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].matchLengthBytes, Buffer.byteLength(query));
  const whitespace = await api.search({ query: '  ', content: true, relativePath: file });
  assert.equal(whitespace.matchMode, 'literal');
  assert.equal(whitespace.items[0].matchLengthBytes, 2);
});

test('search continuations retain the chosen match mode and separate identical-query result identities', async t => {
  const root = await fixture(t), api = await discovery(root, { limits: { pathFiles: 1 } });
  const first = await api.search({ query: '\\.gd$', matchMode: 'regex', content: false });
  assert.equal(first.nextCall.input.matchMode, 'regex');
  let page = first;
  const matches = [];
  while (page) { matches.push(...page.items); page = page.nextCall ? await api.search(page.nextCall.input) : null; }
  assert.deepEqual(matches.map(row => row.file), ['scripts/main.gd']);
  const literal = await api.search({ query: '\\.gd$', content: false });
  assert.equal(literal.matchMode, 'literal');
  assert.notDeepEqual(literal, first, 'mode is part of the actual output identity even when this page is empty');
});

test('Unicode regex dot reports the full emoji UTF-8 span rather than half a surrogate', async t => {
  const root = await fixture(t), file = 'scripts/emoji.gd';
  await writeFile(path.join(root, file), '😀 caption\n');
  const result = await (await discovery(root)).search({ query: '.', matchMode: 'regex', content: true, relativePath: file });
  const item = result.items[0];
  assert.equal(item.matchOffset, 0);
  assert.equal(item.matchLengthBytes, 4);
  assert.equal(item.snippetStartOffset, 0);
  const actual = await readSourceSlice(root, item.nextRead.input.file, item.nextRead.input);
  assert.ok(actual.content.startsWith('😀'));
  assert.ok(!actual.content.includes('\uFFFD'));
});
