import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSON_FIELD_POLICY_VERSION, jsonFieldIdentity, assertJsonFieldWritable } from './json-field-policy.mjs';
import { createTextAdapter } from './adaptation/text-adapter.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

const audio = { name: 'Opening Theme', volume: 90, pitch: 100, pan: 0 };
const map = () => ({ width: 1, height: 1, data: [0], events: [null, { id: 1, name: 'Editor Event', x: 0, y: 0, note: '<trigger:door>', pages: [{
  image: { characterName: 'Hero Sheet', characterIndex: 0 }, list: [
    { code: 241, indent: 0, parameters: [{ ...audio }] },
    { code: 101, indent: 0, parameters: ['Face Sheet', 0, 0, 2, 'Mina'] },
    { code: 401, indent: 0, parameters: ['Welcome to the village.'] },
    { code: 102, indent: 0, parameters: [['Stay overnight', 'Leave'], 0, 0, 2, 0] },
    { code: 355, indent: 0, parameters: ['showMessage("Welcome");'] },
    { code: 357, indent: 0, parameters: ['Plugin', 'Command', 'Label', { text: 'A plugin display label' }] },
  ],
}] }], bgm: { ...audio }, bgs: { ...audio }, displayName: 'The quiet village', note: 'A descriptive note.', parallaxName: 'Evening Sky' });

test('mature RPG profile protects exact resource/command identities, not names or parameters as a class', () => {
  const document = map();
  const protectedPaths = [ ['bgm', 'name'], ['bgs', 'name'], ['parallaxName'], ['events', 1, 'name'], ['events', 1, 'note'],
    ['events', 1, 'pages', 0, 'image', 'characterName'], ['events', 1, 'pages', 0, 'list', 0, 'parameters', 0, 'name'],
    ['events', 1, 'pages', 0, 'list', 1, 'parameters', 0], ['events', 1, 'pages', 0, 'list', 4, 'parameters', 0] ];
  for (const parts of protectedPaths) assert.ok(jsonFieldIdentity('data/Map003.json', document, parts), parts.join('/'));
  const displayPaths = [ ['displayName'], ['note'], ['events', 1, 'pages', 0, 'list', 1, 'parameters', 4],
    ['events', 1, 'pages', 0, 'list', 2, 'parameters', 0], ['events', 1, 'pages', 0, 'list', 3, 'parameters', 0, 0],
    ['events', 1, 'pages', 0, 'list', 5, 'parameters', 3, 'text'] ];
  for (const parts of displayPaths) assert.equal(jsonFieldIdentity('data/Map003.json', document, parts), undefined, parts.join('/'));
  assert.equal(jsonFieldIdentity('content/scenes.json', document, ['bgm', 'name']), undefined);
  assert.equal(jsonFieldIdentity('data/Map003.json', { bgm: audio, name: 'A display name' }, ['bgm', 'name']), undefined);
  assert.equal(jsonFieldIdentity('data/Actors.json', [null, { id: 1, name: 'Mina', note: 'Actor description.' }], ['1', 'name']), undefined);
  assert.throws(() => assertJsonFieldWritable({ file: 'data/Map003.json', document, pointer: '/bgm/name' }), { code: 'PROTECTED_JSON_IDENTITY' });
});

test('System and common-event format reuse the same resource semantics without a whole parameter blacklist', () => {
  const system = { terms: {}, switches: [], variables: [], titleBgm: audio, sounds: [audio], boat: { bgm: audio, characterName: 'Boat' }, gameTitle: 'A game title' };
  for (const parts of [['titleBgm', 'name'], ['sounds', 0, 'name'], ['boat', 'bgm', 'name'], ['boat', 'characterName']]) assert.ok(jsonFieldIdentity('data/System.json', system, parts));
  assert.equal(jsonFieldIdentity('data/System.json', system, ['gameTitle']), undefined);
  const common = [null, { id: 1, list: [{ code: 250, parameters: [audio] }, { code: 401, parameters: ['Hello.'] }] }];
  assert.ok(jsonFieldIdentity('data/CommonEvents.json', common, [1, 'list', 0, 'parameters', 0, 'name']));
  assert.equal(jsonFieldIdentity('data/CommonEvents.json', common, [1, 'list', 1, 'parameters', 0]), undefined);
  const commands = [
    { code: 108, parameters: ['Editor comment'] }, { code: 408, parameters: ['Next comment'] },
    { code: 123, parameters: ['A', 0] }, { code: 111, parameters: [11, 'cancel', 0] },
    { code: 111, parameters: [12, 'actor.level > 1'] }, { code: 118, parameters: ['LoopLabel'] },
    { code: 119, parameters: ['LoopLabel'] }, { code: 122, parameters: [1, 1, 0, 4, 'actor.level'] },
    { code: 320, parameters: [1, 'Mina'] }, { code: 324, parameters: [1, 'The brave'] },
  ];
  const controls = [null, { id: 1, name: 'Editor name', list: commands }];
  assert.ok(jsonFieldIdentity('data/CommonEvents.json', controls, [1, 'name']));
  for (const [i, p] of [[0, 0], [1, 0], [2, 0], [3, 1], [4, 1], [5, 0], [6, 0], [7, 4]]) assert.ok(jsonFieldIdentity('data/CommonEvents.json', controls, [1, 'list', i, 'parameters', p]));
  for (const i of [8, 9]) assert.equal(jsonFieldIdentity('data/CommonEvents.json', controls, [1, 'list', i, 'parameters', 1]), undefined);
});

test('System battle-test backgrounds and locale are fixed roles, not arbitrary prose or a debug-label ban', () => {
  const system = { terms: { basic: ['Level'] }, switches: ['', 'Door unlocked'], variables: ['', 'Visit count'],
    gameTitle: 'A neutral title', currencyUnit: 'Coins', battleback1Name: 'Grassland', battleback2Name: 'Forest',
    battlerName: 'Bat', locale: 'en_US' };
  for (const field of ['battleback1Name', 'battleback2Name', 'locale']) {
    const identity = jsonFieldIdentity('data/System.json', system, [field]);
    assert.ok(identity, field);
    assert.equal(identity.classification, field === 'locale' ? 'logic_identity' : 'resource_identity');
    assert.throws(() => assertJsonFieldWritable({ file: 'data/System.json', document: system, pointer: `/${field}` }), { code: 'PROTECTED_JSON_IDENTITY' });
    assert.equal(jsonFieldIdentity('content/settings.json', system, [field]), undefined, 'same field names do not identify an RPG System profile');
  }
  for (const parts of [['gameTitle'], ['currencyUnit'], ['terms', 'basic', 0], ['switches', 1], ['variables', 1], ['battlerName']]) {
    assert.equal(jsonFieldIdentity('data/System.json', system, parts), undefined, parts.join('/'));
  }
  assert.equal(jsonFieldIdentity('data/System.json', { locale: 'A dialogue about a locale' }, ['locale']), undefined);
});

test('System display fields still accept a translated sample and old JSON policy proofs expire', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-system-roles-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'), file = 'data/System.json';
  await mkdir(path.join(gameDir, 'data'), { recursive: true });
  const document = { terms: {}, switches: ['', 'Door unlocked'], variables: ['', 'Visit count'], gameTitle: 'A neutral title',
    currencyUnit: 'Coins', battleback1Name: 'Grassland', battleback2Name: 'Forest', battlerName: 'Bat', locale: 'en_US' };
  const original = JSON.stringify(document); await writeFile(path.join(gameDir, file), original);
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const good = await createTextAdapter({ gameDir, engine: 'RPG Maker MV', candidates: [{ file, path: ['gameTitle'], source: document.gameTitle }] });
  const candidate = await lab.writeAdapter(good), proof = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(proof.passed, true, proof.error?.message);
  assert.equal(proof.dependencies.identity.jsonFieldPolicy, JSON_FIELD_POLICY_VERSION);
  const unit = proof.extraction.units[0], translations = { [unit.id]: '中性测试标题' };
  const probe = await lab.runProbe({ ...candidate, gameDir, translations });
  assert.equal(probe.passed, true, probe.error?.message);
  const result = JSON.parse(await readFile(path.join(root, 'lab', 'runs', probe.probeId, file), 'utf8'));
  assert.deepEqual(result, { ...document, gameTitle: translations[unit.id] });
  const old = { ...proof, dependencies: { ...proof.dependencies, identity: { ...proof.dependencies.identity, jsonFieldPolicy: 'pinhao-json-field-policy-3' } } };
  await writeFile(path.join(root, 'lab', 'validations', `${proof.validationId}.json`), JSON.stringify(old));
  await assert.rejects(lab.submitRecipe({ ...candidate, validationId: proof.validationId }), /验证|变化|依赖/);
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
});

test('a false display reason cannot promote a mature resource identity through either generated or handwritten adapters', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-json-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'); await mkdir(path.join(gameDir, 'data'), { recursive: true });
  const file = 'data/Map003.json', document = map(), original = JSON.stringify(document);
  await writeFile(path.join(gameDir, file), original);
  const candidate = { file, source: audio.name, path: ['bgm', 'name'], classification: 'display_unresolved', reason: 'Credits displayed in the game' };
  await assert.rejects(createTextAdapter({ gameDir, engine: 'RPG Maker MV', candidates: [candidate] }), { code: 'PROTECTED_JSON_IDENTITY' });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const handwritten = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'bad-display-binding', version: '1.0.0', engine: 'RPG Maker MV', license: 'MIT', scope: { files: [file] } }, code: `({
    detect() { return {matched:true}; },
    extract(host) { return { units:[{id:'audio',source:JSON.parse(host.readText('${file}')).bgm.name,locator:{file:'${file}',pointer:'/bgm/name'}}] }; },
    validate() { return {valid:true}; }, roundtrip(host) {host.writeBytes('${file}',host.readBytes('${file}'));return {};},
    build(host,input) {const d=JSON.parse(host.readText('${file}'));if(Object.hasOwn(input.translations,'audio'))d.bgm.name=input.translations.audio;host.writeText('${file}',JSON.stringify(d));return {};}, assemble() {return {};}
  })` });
  const validation = await lab.validateAdapter({ ...handwritten, gameDir });
  assert.equal(validation.passed, false);
  assert.equal(validation.error.code, 'PROTECTED_JSON_IDENTITY');
  assert.equal(validation.error.evidence.pointer, '/bgm/name');
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
  const display = await createTextAdapter({ gameDir, engine: 'RPG Maker MV', candidates: [{ file, source: document.displayName, path: ['displayName'] },
    { file, source: 'Welcome to the village.', path: ['events', 1, 'pages', 0, 'list', 2, 'parameters', 0] }] });
  const good = await lab.writeAdapter(display), accepted = await lab.validateAdapter({ ...good, gameDir });
  assert.equal(accepted.passed, true, accepted.error?.message);
});

test('native skill and item damage formulas are code, without banning their display names or descriptions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-damage-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'); await mkdir(path.join(gameDir, 'data'), { recursive: true });
  const row = { id: 1, name: 'Attack', description: 'A strong attack.', note: 'A plugin note.',
    damage: { type: 1, elementId: -1, variance: 20, critical: false, formula: 'a.atk * 4 - b.def * 2' } };
  for (const file of ['data/Skills.json', 'data/Items.json']) {
    const document = [null, row];
    await writeFile(path.join(gameDir, file), JSON.stringify(document));
    assert.equal(jsonFieldIdentity(file, document, [1, 'damage', 'formula'])?.classification, 'logic_identity');
    for (const field of ['name', 'description', 'note']) assert.equal(jsonFieldIdentity(file, document, [1, field]), undefined);
    await assert.rejects(createTextAdapter({ gameDir, engine: 'RPG Maker MV', candidates: [{ file,
      source: row.damage.formula, path: [1, 'damage', 'formula'], reason: 'A visible formula label' }] }), { code: 'PROTECTED_JSON_IDENTITY' });
    const display = await createTextAdapter({ gameDir, engine: 'RPG Maker MV', candidates: [{ file, source: row.name, path: [1, 'name'] }] });
    assert.ok(display.code);
  }
  assert.equal(jsonFieldIdentity('content/rules.json', [null, row], [1, 'damage', 'formula']), undefined);
  assert.equal(jsonFieldIdentity('data/Skills.json', [null, { id: 1, damage: { formula: 'A displayed formula' } }], [1, 'damage', 'formula']), undefined);
});

test('MapInfos editor names are separate from native map display titles', () => {
  const infos = [null, { id: 1, name: 'Editor map label', parentId: 0, order: 1, expanded: false, scrollX: 0, scrollY: 0 }];
  assert.equal(jsonFieldIdentity('data/MapInfos.json', infos, [1, 'name'])?.classification, 'logic_identity');
  assert.throws(() => assertJsonFieldWritable({ file: 'data/MapInfos.json', document: infos, pointer: '/1/name' }), { code: 'PROTECTED_JSON_IDENTITY' });
  const document = map();
  assert.equal(jsonFieldIdentity('data/Map001.json', document, ['displayName']), undefined);
  assert.equal(jsonFieldIdentity('content/map-names.json', infos, [1, 'name']), undefined);
  assert.equal(jsonFieldIdentity('data/MapInfos.json', [null, { name: 'Display text without native record shape' }], [1, 'name']), undefined);
});
