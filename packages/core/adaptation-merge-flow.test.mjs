import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAdapterLab } from '../technical/adaptation/adapter-lab.mjs';
import { createAdaptiveWorker, registerSupplement } from './adaptive-worker.mjs';

const root = path.resolve('local', 'adaptation-merge-flow-tests');
await mkdir(root, { recursive: true });

for (const format of ['json', 'gd']) test(`native and generated ${format.toUpperCase()} writers merge distinct text in the same resource through real validation and assembly`, async t => {
  const directory = await mkdtemp(path.join(root, `${format}-`));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(directory, 'game'), workspaceDir = path.join(directory, 'native-workbench'), adapterWorkspaceDir = path.join(directory, 'adapter-workbench');
  await mkdir(gameDir); await mkdir(workspaceDir);
  await writeFile(path.join(gameDir, 'Game.exe'), 'neutral executable marker');
  const file = format === 'json' ? 'shared.json' : 'shared.gd';
  const source = format === 'json' ? '{"lines":["Native title"],"extra":["Hidden story."],"logic":{"switch":9,"asset":"keep.png"}}' : '# 前置🙂\nvar title = "Native title"\nvar extra = "Hidden story."\nvar identity = "keep.png"\n';
  await writeFile(path.join(gameDir, file), source);
  const code = format === 'json'
    ? `({detect(){return {matched:true}},extract(host){const data=JSON.parse(host.readText('shared.json'));return {units:[{id:'extra:0',source:data.extra[0],kind:'dialogue',context:{file:'shared.json'},locator:{file:'shared.json',pointer:'/extra/0'}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('shared.json',host.readBytes('shared.json'));return {}},build(host,input){const data=JSON.parse(host.readText('shared.json'));if(Object.hasOwn(input.translations,'extra:0'))data.extra[0]=input.translations['extra:0'];host.writeText('shared.json',JSON.stringify(data));return {}},assemble(){return {}}})`
    : `({detect(){return {matched:true}},extract(host){const text=host.readText('shared.gd'),prefix='var extra = "',start=text.indexOf(prefix)+prefix.length,end=text.indexOf('"',start),size=value=>encodeURIComponent(value).replace(/%[0-9A-F]{2}|./g,'x').length;return {units:[{id:'extra:0',source:text.slice(start,end),kind:'dialogue',context:{file:'shared.gd'},locator:{file:'shared.gd',byteStart:size(text.slice(0,start)),byteEnd:size(text.slice(0,end))}}]}},validate(){return {valid:true}},roundtrip(host){host.writeBytes('shared.gd',host.readBytes('shared.gd'));return {}},build(host,input){const text=host.readText('shared.gd'),prefix='var extra = "',start=text.indexOf(prefix)+prefix.length,end=text.indexOf('"',start);host.writeText('shared.gd',text.slice(0,start)+(input.translations['extra:0']??text.slice(start,end))+text.slice(end));return {}},assemble(){return {}}})`;
  const lab = await createAdapterLab({ dataDir: path.join(directory, 'lab') });
  const candidate = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: `shared-${format}-fixture`, version: '1.0.0', engine: 'Neutral Shared Resource', scope: { files: [file] }, license: 'GPL-3.0-or-later', sources: [] }, code });
  const validation = await lab.validateAdapter({ candidateId: candidate.candidateId, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ candidateId: candidate.candidateId, validationId: validation.validationId });
  const extraction = await lab.extractRecipe({ recipeId: recipe.recipeId, gameDir, workspaceDir: adapterWorkspaceDir });
  await registerSupplement({ workspaceDir, adapterWorkspaceDir: extraction.workspaceDir, unitIds: extraction.units.map(unit => unit.id), units: extraction.units, files: [file], baselineDir: gameDir, sourceRoot: gameDir });
  const nativeTranslation = '原生标题更长且保留。', supplementalTranslation = '补充剧情完整句。';
  const nativeCalls = [];
  const worker = createAdaptiveWorker({ getLab: async () => lab, nativeWorker: async (command, args) => {
    nativeCalls.push(command);
    for (const record of args.translations ?? []) assert.equal(record.id, 'native:0', 'generated text stays in the generated writer');
    if (command === 'roundtrip' || command === 'validate') return { passed: true, valid: true };
    if (command === 'build') {
      await mkdir(args.outputDir, { recursive: true });
      const actualSource = await readFile(path.join(gameDir, file), 'utf8');
      const built = format === 'json' ? (() => { const data = JSON.parse(actualSource); data.lines[0] = nativeTranslation; return JSON.stringify(data); })() : actualSource.replace('Native title', nativeTranslation);
      await writeFile(path.join(args.outputDir, file), built);
      return { buildDir: args.outputDir };
    }
    if (command === 'assemble') {
      await cp(gameDir, args.outputDir, { recursive: true }); await cp(args.buildDir, args.outputDir, { recursive: true });
      return { outputDir: args.outputDir, launchPath: path.join(args.outputDir, 'Game.exe') };
    }
    throw new Error(`Unexpected native fixture command ${command}`);
  } });
  const translations = [{ id: 'native:0', translation: nativeTranslation }, { id: 'extra:0', translation: supplementalTranslation }];
  await worker('roundtrip', { workspaceDir });
  await worker('validate', { workspaceDir, translations });
  const built = await worker('build', { workspaceDir, outputDir: path.join(directory, 'build'), translations });
  const product = await worker('assemble', { workspaceDir, gameDir, buildDir: built.buildDir, adapterBuilds: built.adapterBuilds, outputDir: path.join(directory, 'product') });
  const output = await readFile(path.join(product.outputDir, file), 'utf8');
  assert.ok(output.includes(nativeTranslation));
  assert.ok(output.includes(supplementalTranslation));
  if (format === 'json') assert.deepEqual(JSON.parse(output).logic, { switch: 9, asset: 'keep.png' });
  else assert.ok(output.endsWith('var identity = "keep.png"\n'));
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), source);
  assert.deepEqual(nativeCalls, ['roundtrip', 'validate', 'build', 'assemble']);
});
