import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertScriptFieldsWritable, scriptFieldIdentities } from './script-field-policy.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';
import { createTextAdapter } from './adaptation/text-adapter.mjs';
import { SCRIPT_FIELD_POLICY_VERSION } from './script-field-policy.mjs';

const unitFor = (text, literal, id = literal) => {
  const start = text.indexOf(literal);
  return { id, rawSource: literal.slice(1, -1), locator: { file: 'view.js', byteStart: Buffer.byteLength(text.slice(0, start + 1)), byteEnd: Buffer.byteLength(text.slice(0, start + literal.length - 1)) } };
};
const windowSource = `// 中文 😀\nfunction Window_Status() {}\nWindow_Status.prototype = Object.create(Window_Base.prototype);\nWindow_Status.prototype.drawContents = function() { this.drawText('right', 0, 0, 100, 'new-alignment-value'); };`;

test('known Window UI parameter roles block non-text by position, not by string value', () => {
  const align = unitFor(windowSource, "'new-alignment-value'");
  const found = scriptFieldIdentities({ file: 'view.js', before: Buffer.from(windowSource), units: [align] });
  assert.equal(found.length, 1); assert.equal(found[0].argument, 4); assert.equal(found[0].role, 'align');
  assert.equal(found[0].consumer, 'Window_Base.drawText argument 5');
  assert.throws(() => assertScriptFieldsWritable({ file: 'view.js', before: Buffer.from(windowSource), units: [align] }), { code: 'PROTECTED_SCRIPT_ARGUMENT' });
  assert.doesNotThrow(() => assertScriptFieldsWritable({ file: 'view.js', before: Buffer.from(windowSource), units: [unitFor(windowSource, "'right'")] }));
});

test('unknown same-name methods, local overrides and nested independent calls do not inherit a made-up UI contract', () => {
  for (const text of [
    "custom.drawText(1, 2, 3, 4, 'A real custom caption');",
    "Window_Status.prototype = Object.create(Window_Base.prototype); Window_Status.prototype.drawText=function(a,b,c,d,caption) {}; Window_Status.prototype.show=function(){this.drawText(1,2,3,4,'A real custom caption');};",
    "Window_Status.prototype = Object.create(Window_Base.prototype); Window_Status.prototype.show=()=>{this.drawText(1,2,3,4,'A real custom caption');};",
    "Window_Status.prototype = Object.create(Window_Base.prototype); Window_Status.prototype.show=function(){this.drawText('Text',0,0,100,otherApi('A real custom caption'));};",
  ]) assert.doesNotThrow(() => assertScriptFieldsWritable({ file: 'view.js', before: Buffer.from(text), units: [unitFor(text, "'A real custom caption'")] }));
  const command = "Window_Menu.prototype=Object.create(Window_Command.prototype);Window_Menu.prototype.makeCommandList=function(){this.addCommand('Continue','continueSymbol',true);};";
  assert.equal(scriptFieldIdentities({ file: 'view.js', before: Buffer.from(command), units: [unitFor(command, "'continueSymbol'")] })[0].role, 'symbol');
  const extended = "Window_Status.prototype=Object.create(Window_Base.prototype);Window_Status.prototype.show=function(){this.drawTextEx('Text',0,0,'width-control');};";
  assert.equal(scriptFieldIdentities({ file: 'view.js', before: Buffer.from(extended), units: [unitFor(extended, "'width-control'")] })[0].role, 'width');
  const nested = "Window_Status.prototype=Object.create(Window_Base.prototype);Window_Status.prototype.show=function(){const draw=()=>this.drawText('Text',0,0,100,'alignment-value');};";
  assert.equal(scriptFieldIdentities({ file: 'view.js', before: Buffer.from(nested), units: [unitFor(nested, "'alignment-value'")] })[0].role, 'align');
});

test('AST property/member/module identities remain keys while ordinary values remain language', () => {
  for (const [text, literal, role] of [
    ["const table = {'logicalKey': 'Visible caption'};", "'logicalKey'", 'property-key'],
    ["const value = table['logicalKey'];", "'logicalKey'", 'member-key'],
    ["import view from 'module-path';", "'module-path'", 'module-source'],
    ["export { value } from 'module-path';", "'module-path'", 'module-source'],
    ["class View { 'method-key'() {} }", "'method-key'", 'property-key'],
  ]) assert.equal(scriptFieldIdentities({ file: 'view.js', before: Buffer.from(text), units: [unitFor(text, literal)] })[0].role, role);
  const text = "const table = {'logicalKey': 'Visible caption'};";
  assert.doesNotThrow(() => assertScriptFieldsWritable({ file: 'view.js', before: Buffer.from(text), units: [unitFor(text, "'Visible caption'")] }));
});

test('handwritten UTF8 adapters cannot bypass UI argument protection while real label text still validates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-script-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  const text = windowSource.replace('// 中文 😀\n', ''), file = 'view.js', original = Buffer.from(text);
  await writeFile(path.join(gameDir, file), original);
  const unit = unitFor(text, "'new-alignment-value'", 'alignment');
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const written = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'wrong-ui-alignment', version: '1.0.0', engine: 'RPG Maker', license: 'MIT', scope: { files: [file] } }, code: `({
    detect() {return {matched:true};}, extract() {return {units:[${JSON.stringify({ ...unit, source: unit.rawSource })}]};}, validate(){return {valid:true};},
    roundtrip(host){host.writeBytes('${file}',host.readBytes('${file}'));return {};},
    build(host,input){let text=host.readText('${file}');if(Object.hasOwn(input.translations,'alignment'))text=text.slice(0,${unit.locator.byteStart})+input.translations.alignment+text.slice(${unit.locator.byteEnd});host.writeText('${file}',text);return {};},assemble(){return {};}
  })` });
  const result = await lab.validateAdapter({ ...written, gameDir });
  assert.equal(result.passed, false); assert.equal(result.error.code, 'PROTECTED_SCRIPT_ARGUMENT');
  assert.equal(result.error.evidence.role, 'align');
  const start = text.indexOf("'right'");
  const good = await createTextAdapter({ gameDir, engine: 'RPG Maker', candidates: [{ file, source: 'right', target: { start, end: start + 7, render: 'quoted' } }] });
  const candidate = await lab.writeAdapter(good), accepted = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(accepted.passed, true, accepted.error?.message);
  assert.equal(accepted.dependencies.identity.scriptFieldPolicy, SCRIPT_FIELD_POLICY_VERSION);
  assert.deepEqual(await readFile(path.join(gameDir, file)), original);
});

test('Godot direct subscript and dictionary keys are identities regardless of display assignment', () => {
  for (const [text, literal, role] of [
    ['label.text = record["name"]', '"name"', 'subscript-key'],
    ['label.text = "Treasury %d" % int(players[HUMAN]["gold"])', '"gold"', 'subscript-key'],
    ['label.text = "“%s”" % record["plea"]', '"plea"', 'subscript-key'],
    ['label.text = record["name"] if owned else "Unknown"', '"name"', 'subscript-key'],
    ['label.text = "Turn %d / %d" % [int(given["turn"]), int(given["price"])]', '"turn"', 'subscript-key'],
    ['label.text = "Turn %d / %d" % [int(given["turn"]), int(given["price"])]', '"price"', 'subscript-key'],
    ['var table = {"identity": "Visible name"}', '"identity"', 'dictionary-key'],
    ['label.text = get_record()[ # a comment\n "name"\n ]', '"name"', 'subscript-key'],
    ['# 中文 😀\nlabel.text = records[0]["名称"]', '"名称"', 'subscript-key'],
    ['label.text = record[(("name"))]', '"name"', 'subscript-key'],
    ['label.text = record[&"name"]', '"name"', 'subscript-key'],
    ['var table = {"""identity""": "Visible name"}', '"""identity"""', 'dictionary-key'],
  ]) {
    const unit = unitFor(text, literal);
    if (literal.startsWith('"""')) { unit.locator.byteStart += 2; unit.locator.byteEnd -= 2; }
    const found = scriptFieldIdentities({ file: 'view.gd', before: Buffer.from(text), units: [unit] });
    assert.equal(found.length, 1, text); assert.equal(found[0].role, role, text);
    assert.equal(found[0].classification, 'logic_identity');
    assert.throws(() => assertScriptFieldsWritable({ file: 'view.gd', before: Buffer.from(text), units: [unit] }), { code: 'PROTECTED_SCRIPT_ARGUMENT' });
  }
});

test('Godot indexed arrays, dictionary values and display templates stay writable', () => {
  for (const [text, literal] of [
    ['label.text = ["Yes", "No"][index]', '"Yes"'],
    ['func choices():\n return ["Yes", "No"]', '"Yes"'],
    ['var table = {"identity": "Visible name"}', '"Visible name"'],
    ['label.text = "Turn %d" % [int(record["turn"])]', '"Turn %d"'],
    ['card.tooltip_text = "A %s remains." % title.to_lower()', '"A %s remains."'],
    ['label.text = table[find_key("Displayed argument")]', '"Displayed argument"'],
    ['label.text = "[brackets] and : punctuation"', '"[brackets] and : punctuation"'],
    ['# table["Not code"]\nlabel.text = "Real caption"', '"Real caption"'],
  ]) assert.doesNotThrow(() => assertScriptFieldsWritable({ file: 'view.gd', before: Buffer.from(text), units: [unitFor(text, literal)] }), text);
});

test('Godot handwritten byte adapters cannot submit a key but real tooltip text still validates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-gd-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const gameDir = path.join(root, 'game'); await mkdir(gameDir);
  const file = 'view.gd', text = 'label.text = record["name"]\ncard.tooltip_text = "A %s remains." % title\n';
  await writeFile(path.join(gameDir, file), text);
  const unit = { ...unitFor(text, '"name"', 'key'), locator: { ...unitFor(text, '"name"').locator, file } };
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const written = await lab.writeAdapter({ manifest: { schemaVersion: 1, id: 'wrong-gd-key', version: '1.0.0', engine: 'Godot', license: 'MIT', scope: { files: [file] } }, code: `({
    detect(){return {matched:true};},extract(host){let unit=${JSON.stringify(unit)},source=host.readText('${file}').slice(${unit.locator.byteStart}).split('"')[0];unit.source=unit.rawSource=source;unit.locator.byteEnd=${unit.locator.byteStart}+[...source].reduce((n,c)=>n+(c.codePointAt(0)<128?1:c.codePointAt(0)<2048?2:c.codePointAt(0)<65536?3:4),0);return {units:[unit]};},validate(){return {valid:true};},
    roundtrip(host){host.writeBytes('${file}',host.readBytes('${file}'));return {};},
    build(host,input){let text=host.readText('${file}');host.writeText('${file}',text.slice(0,${unit.locator.byteStart})+(input.translations.key||'name')+text.slice(${unit.locator.byteEnd}));return {};},assemble(){return {};}
  })` });
  const rejected = await lab.validateAdapter({ ...written, gameDir });
  assert.equal(rejected.passed, false); assert.equal(rejected.error.code, 'PROTECTED_SCRIPT_ARGUMENT', rejected.error.message);
  const quote = '"A %s remains."', start = text.indexOf(quote);
  const good = await createTextAdapter({ gameDir, engine: 'Godot', candidates: [{ file, source: 'A %s remains.', target: { start, end: start + quote.length, render: 'quoted' } }] });
  const candidate = await lab.writeAdapter(good), accepted = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(accepted.passed, true, accepted.error?.message);
  assert.equal(accepted.dependencies.identity.scriptFieldPolicy, SCRIPT_FIELD_POLICY_VERSION);
  const translated = accepted.extraction.units[0], translation = `中文测试：${translated.source}`;
  const probe = await lab.runProbe({ ...candidate, gameDir, translations: { [translated.id]: translation } });
  assert.equal(probe.passed, true, probe.error?.message);
  assert.equal(await readFile(path.join(root, 'lab', 'runs', probe.probeId, file), 'utf8'), text.replace('A %s remains.', '中文测试：A %s remains.'));
  const old = { ...accepted, dependencies: { ...accepted.dependencies, identity: { ...accepted.dependencies.identity, scriptFieldPolicy: 2 } } };
  await writeFile(path.join(root, 'lab', 'validations', `${accepted.validationId}.json`), JSON.stringify(old));
  await assert.rejects(lab.submitRecipe({ ...candidate, validationId: accepted.validationId }), /验证|变化|依赖/);
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), text);
});
