import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractDisplayText, applyDisplayText } from './scripts.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-js-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'source'); await mkdir(path.join(game, 'js/plugins'), { recursive: true });
  const source = `var resource = 'images/title.png'; var secret = 'never execute';\nthrow new Error(secret);\nwindow.drawText('Continue',0,0);\nwindow.addCommand('Return', 'cancel');\nwindow.drawText(mode ? 'Day' : 'Night',0,0);\nwindow.drawText('Level: ' + level,0,0);\nwindow.drawText('Color\\\\C[2]Name',0,0);\n`;
  await writeFile(path.join(game, 'js/plugins/fixture.js'), source);
  const output = path.join(root, 'copy'); await cp(game, output, { recursive: true });
  return { game, output, source };
}

test('script extraction keeps display bindings and never evaluates game code', async t => {
  const { game } = await fixture(t);
  const extracted = await extractDisplayText(game);
  assert.equal(extracted.units.length, 6);
  assert.ok(extracted.units.every(unit => !unit.source.includes('images/title')));
  assert.ok(extracted.units.every(unit => !unit.source.includes('cancel')));
  assert.equal(extracted.units.at(-1).tokens.length, 1);
});

test('script write preserves resource IDs, expressions, controls and original bytes', async t => {
  const { game, output, source } = await fixture(t);
  const { units, binding } = await extractDisplayText(game);
  await applyDisplayText({ outputDir: output, binding, translations: units.map(unit => ({ id: unit.id, translation: unit.source.replace('Continue', '继续').replace('Return', '返回') })) });
  const result = await readFile(path.join(output, 'js/plugins/fixture.js'), 'utf8');
  assert.match(result, /"继续"/); assert.match(result, /"返回", 'cancel'/);
  assert.match(result, /'Level: ' \+ level/); assert.match(result, /images\/title.png/);
  assert.equal(await readFile(path.join(game, 'js/plugins/fixture.js'), 'utf8'), source);
});

test('script rejects modified baseline, duplicate IDs and broken controls', async t => {
  const { game, output } = await fixture(t);
  const { units, binding } = await extractDisplayText(game);
  const last = units.at(-1);
  await assert.rejects(applyDisplayText({ outputDir: output, binding, translations: [{ id: last.id, translation: 'broken' }] }), /保护标记/);
  await assert.rejects(applyDisplayText({ outputDir: output, binding, translations: [{ id: units[0].id, translation: 'a' }, { id: units[0].id, translation: 'b' }] }), /重复/);
  await writeFile(path.join(output, 'js/plugins/fixture.js'), '// edited');
  await assert.rejects(applyDisplayText({ outputDir: output, binding, translations: [] }), /已经变化/);
});
