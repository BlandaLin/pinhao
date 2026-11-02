import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../exchange/index.mjs';
import { adaptationLocationKey, selectSupplementalUnits } from './adaptation-results.mjs';
import { accumulateVerifiedExtractions } from '../technical/adaptation/verified-batches.mjs';

test('qualified bindings survive aggregation and XP3 member identities remain distinct', () => {
  const units = ['a.ks', 'b.ks'].map((member, index) => ({ id: `line-${index}`, source: 'Hello',
    locator: { file: 'data.xp3', member, format: 'kag-text', encoding: 'utf-16le', byteStart: 2, byteEnd: 12 },
    context: { formatBinding: { protocol: 'pinhao-format-binding-1', family: 'xp3-kag',
      location: JSON.stringify([member, 'utf-16le', 2, 12]), capabilityRef: 'a'.repeat(64) } } }));
  const merged = accumulateVerifiedExtractions([], [{ units }]);
  assert.equal(merged[0].units.length, 2);
  assert.equal(selectSupplementalUnits({ projectId: 'neutral', incoming: merged[0].units, existing: [] }).units.length, 2);
  const custom = { ...units[0], locator: { file: 'body.neutral', formatPath: ['caption'] } };
  assert.equal(accumulateVerifiedExtractions([], [{ units: [custom] }])[0].units.length, 1);
  assert.equal(adaptationLocationKey(units[0].locator), undefined, 'an unqualified container span is not a UTF8 file span');
  assert.throws(() => accumulateVerifiedExtractions([], [{ units: [units[0], { ...units[0], id: 'duplicate' }] }]), /重复/);
});

test('member-view JSON ownership is namespaced by its physical carrier', () => {
  const a = { id: 'a', source: 'Hello', locator: { file: 'story.json', pointer: '/text' }, context: { carrier: 'a.zip' } };
  const b = { ...a, id: 'b', context: { carrier: 'b.zip' } };
  const first = selectSupplementalUnits({ projectId: 'neutral', incoming: [a], existing: [] });
  assert.equal(selectSupplementalUnits({ projectId: 'neutral', incoming: [b], existing: first.units }).units.length, 1);
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...a, id: 'segment', locator: { ...a.locator, segment: { syntax: 'test', prefix: '', suffix: '' } } }], existing: first.units }), /容器/);
});

const jsonUnit = (id, pointer, source = 'A neutral menu caption.') => ({ id, source, kind: 'dialogue', context: { file: 'menus.json', scene: 'neutral-menu' }, locator: { file: 'menus.json', pointer } });
const gdUnit = (id, byteStart, source = 'A neutral menu caption.') => ({ id, source, rawSource: source, kind: 'script_display', context: { file: 'menu.gd' }, locator: { file: 'menu.gd', byteStart, byteEnd: byteStart + Buffer.byteLength(source) } });

test('adaptation location keys normalize engine paths and depend on locator values rather than object order', () => {
  const pointer = { file: 'res://data/menu.json', pointer: '/lines/0' };
  assert.equal(adaptationLocationKey(pointer), adaptationLocationKey({ pointer: '/lines/0', file: '.\\data\\menu.json' }));
  assert.notEqual(adaptationLocationKey(pointer), adaptationLocationKey({ ...pointer, pointer: '/lines/1' }));
  assert.equal(adaptationLocationKey({ file: './menu.gd', byteStart: 8, byteEnd: 19 }), adaptationLocationKey({ byteEnd: 19, byteStart: 8, file: 'res://menu.gd' }));
  assert.equal(adaptationLocationKey({ file: 'menu.gd', line: 1 }), undefined);
});

for (const format of ['json', 'gd']) test(`${format} deduplication uses verified native locations and keeps the same text at another location`, () => {
  const native = format === 'json' ? jsonUnit('native-copy', '/lines/0') : gdUnit('native-copy', 8);
  const other = format === 'json' ? jsonUnit('other-caption', '/lines/1') : gdUnit('other-caption', 80);
  const result = selectSupplementalUnits({ projectId: 'neutral', incoming: [native, other], existing: [], nativeLocations: [{ ...native.locator, sourceHash: sha256(native.rawSource ?? native.source) }] });
  assert.deepEqual(result.rawUnits, [other]);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].legacyId, other.id);
  assert.equal(result.units[0].source, native.source);
  assert.deepEqual(result.units[0].context.adaptationLocator, other.locator);
});

test('existing translated supplemental units retain their revision, translation and notes when a new id maps to their verified location', () => {
  const raw = jsonUnit('saved-caption', '/lines/0');
  const prior = selectSupplementalUnits({ projectId: 'neutral', incoming: [raw], existing: [] }).units[0];
  const existing = [{ ...prior, translation: 'A reviewed translated caption.', notes: 'Reviewed neutral scene context.', status: 'proofread', revision: 7 }];
  const snapshot = structuredClone(existing);
  const result = selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, id: 'regenerated-caption' }], existing });
  assert.deepEqual(result, { rawUnits: [], units: [] });
  assert.deepEqual(existing, snapshot);
});

test('different source text at a verified native or existing location is rejected', () => {
  const raw = jsonUnit('original', '/lines/0');
  const changed = { ...raw, id: 'new-caption', source: 'A conflicting source caption.' };
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [changed], existing: [], nativeLocations: [{ ...raw.locator, sourceHash: sha256(raw.source) }] }), /不一致原文/);
  const existing = selectSupplementalUnits({ projectId: 'neutral', incoming: [raw], existing: [] }).units;
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [changed], existing }), /不一致原文/);
});

test('JSON command ownership rejects another segment or whole-field writer before accepting paid work', () => {
  const raw = jsonUnit('command-body', '/1/list/0/parameters/0', 'Alpha Beta');
  raw.locator.segment = { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE ', suffix: ' 32' };
  assert.equal(adaptationLocationKey(raw.locator), adaptationLocationKey({ ...raw.locator, segment: { suffix: ' 32', prefix: 'NOTICE ', syntax: 'rpgmaker-plugin-command' } }));
  const existing = selectSupplementalUnits({ projectId: 'neutral', incoming: [raw], existing: [] }).units;
  const conflicting = { ...raw, id: 'second-body', source: 'Beta', locator: { ...raw.locator,
    segment: { syntax: 'rpgmaker-plugin-command', prefix: 'NOTICE Alpha ', suffix: ' 32' } } };
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [conflicting], existing }), /容器.*其他/);
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, id: 'whole', locator: { file: raw.locator.file, pointer: raw.locator.pointer } }], existing }), /容器.*其他/);
  assert.deepEqual(selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, id: 'same-binding' }], existing }), { rawUnits: [], units: [] });
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [raw, conflicting], existing: [] }), /容器.*其他/);
});

test('a stable id cannot move to another free or already-owned location', () => {
  const first = jsonUnit('first-caption', '/lines/0'), second = jsonUnit('second-caption', '/lines/1');
  const existing = selectSupplementalUnits({ projectId: 'neutral', incoming: [first, second], existing: [] }).units;
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [jsonUnit(first.id, '/lines/2')], existing }), /ID.*其他/);
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [jsonUnit(first.id, second.locator.pointer)], existing }), /ID.*其他/);
});

test('incoming duplicate ids and repeated positions reject reordered locator properties', () => {
  const first = jsonUnit('first-caption', '/lines/0');
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [first, jsonUnit(first.id, '/lines/1')], existing: [] }), /重复/);
  const second = { ...first, id: 'second-caption', locator: { pointer: '/lines/0', file: 'menus.json' } };
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [first, second], existing: [] }), /重复/);
});

test('UTF-8 literal raw-body hashes, tokens and canonical control fingerprints survive selection', () => {
  const rawBody = '中性🙂 title\\nwith \\C[2]colour and \\u263A';
  const source = '中性🙂 title{{CTRL0001}}with {{CTRL0002}}colour and {{CTRL0003}}';
  const controls = { '{{CTRL0003}}': '\\u263A', '{{CTRL0001}}': '\\n', '{{CTRL0002}}': '\\C[2]' };
  const raw = { ...gdUnit('controlled-caption', 13, source), rawSource: rawBody, tokens: ['{{CTRL0001}}', '{{CTRL0002}}', '{{CTRL0003}}'], controls };
  raw.locator.byteEnd = raw.locator.byteStart + Buffer.byteLength(rawBody);
  const { units, rawUnits } = selectSupplementalUnits({ projectId: 'neutral', incoming: [raw], existing: [] });
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].tokens, raw.tokens);
  assert.equal(units[0].sourceHash, sha256(source));
  assert.equal(units[0].context.adaptationSourceHash, sha256(rawBody));
  assert.notEqual(units[0].context.adaptationSourceHash, units[0].sourceHash);
  assert.equal(units[0].context.controlFingerprint, sha256(Object.fromEntries(Object.entries(controls).sort(([a], [b]) => a.localeCompare(b)))));
  assert.deepEqual(units[0].context.adaptationLocator, raw.locator);
  assert.equal(rawUnits[0], raw);
  const existing = [{ ...units[0], translation: 'A reviewed {{CTRL0001}}caption {{CTRL0002}}with {{CTRL0003}}', notes: 'Keep controls.' }];
  const again = selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, id: 'new-controlled-caption' }], existing });
  assert.deepEqual(again.units, []);
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, id: 'changed-raw-body', rawSource: `${rawBody} ` }], existing }), /不一致原文/);
  assert.throws(() => selectSupplementalUnits({ projectId: 'neutral', incoming: [{ ...raw, rawSource: `${rawBody} ` }], existing }), /ID.*其他/);
});
