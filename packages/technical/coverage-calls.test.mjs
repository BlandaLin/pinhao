import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { scanCoverage } from './coverage.mjs';

async function inspect(t, text, extension = '.js') {
  const parent = path.resolve('local/display-call-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'command-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  await writeFile(path.join(directory, `menu${extension}`), text);
  const coverage = await scanCoverage({ rootDir: directory, scanCache: false });
  return [...coverage.classifiedCandidates, ...coverage.dynamicCandidates].filter(item => /^script_display_/.test(item.kind));
}

test('JavaScript addCommand follows only its first display argument', async t => {
  const candidates = await inspect(t, "this.addCommand(caption, 'exitGame', true, 'https://example.invalid');");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'script_display_expression_candidate');
  assert.equal(candidates[0].source, 'caption');
  assert.equal(candidates[0].classification, 'adapter_required');
  assert.ok(candidates[0].context.displaySite.end > candidates[0].target.end, 'call evidence retains the complete invocation');
});

test('JavaScript addCommand does not offer symbols and extension strings for translation', async t => {
  const candidates = await inspect(t, "this.addCommand('Leave, please', 'exitGame', true, { url: 'Open this website' });");
  assert.deepEqual(candidates.map(item => item.source), ['Leave, please']);
});

test('first argument boundaries preserve nested expressions, object commas, and array commas', async t => {
  const expression = 'chooseLabel({ choices: [first, second] }, next(a, b))';
  const candidates = await inspect(t, `this.addCommand(${expression}, 'businessKey');`);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, expression);
});

test('a single label argument remains inspectable and empty calls make no text', async t => {
  const candidates = await inspect(t, 'this.addCommand(label); this.addCommand();');
  assert.deepEqual(candidates.map(item => item.source), ['label']);
});

test('JavaScript drawText/Ex follow text, not layout or alignment arguments; Ruby discovery remains', async t => {
  const js = await inspect(t, "this.drawTextEx(text, x, y, 'existing layout argument');");
  assert.deepEqual(js.map(item => item.source), ['text']);
  const draw = await inspect(t, "this.drawText(info.playtime, rect.x, playtimeY, rect.width, 'right'); this.drawText('right', 0, 0, 100, 'left');");
  assert.deepEqual(draw.map(item => item.source), ['info.playtime', 'right']);
  const ruby = await inspect(t, 'add_command("Continue", :continue, true)\n', '.rb');
  assert.deepEqual(ruby.map(item => item.source), ['Continue']);
});

test('Godot key-only display sites retain an indirect expression without offering the key as text', async t => {
  const candidates = await inspect(t, 'label.text = record["name"]\n', '.gd');
  const open = candidates.filter(item => item.status !== 'ignored');
  assert.deepEqual(open.map(item => item.source), ['record["name"]']);
  assert.equal(open[0].kind, 'script_display_expression_candidate');
  assert.equal(open[0].requiresAdapter, true);
  assert.ok(candidates.some(item => item.source === 'name' && item.classification === 'logic_identity' && item.status === 'ignored'));
});

test('Godot templates and indexed display values remain candidates while their keys stay identities', async t => {
  const candidates = await inspect(t, 'label.text = "Turn %d" % [int(record["turn"])]\nother.text = ["Yes", "No"][index]\n', '.gd');
  const open = candidates.filter(item => item.status !== 'ignored');
  assert.deepEqual(open.filter(item => item.kind === 'script_display_literal_candidate').map(item => item.source), ['Turn %d', 'Yes', 'No']);
  assert.ok(candidates.some(item => item.source === 'turn' && item.classification === 'logic_identity'));
});
