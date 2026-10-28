import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLiteralSelections } from './adaptation/text-adapter.mjs';
import { createAdapterLab } from './adaptation/adapter-lab.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pinhao-literal-selection-'));
  const gameDir = path.join(root, 'source'); await mkdir(gameDir);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return { root, gameDir };
}

test('Agent literal selection builds Unicode Ruby text through the ordinary validated adapter lab', async t => {
  const { root, gameDir } = await fixture(t);
  const original = '# 中文😀 prefix\r\nmodule Vocab\r\n  Buy = "Buy"\r\n  Key = "shop-buy"\r\nend\r\n';
  await writeFile(path.join(gameDir, 'Vocab.rb'), original);
  const reason = 'Vocab::Buy is passed to add_command by the shop window; Key retains its business identity.';
  const definition = await createLiteralSelections({ gameDir, engine: 'Ruby fixture',
    selections: [{ file: 'Vocab.rb', text: 'Buy', reason }] });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extracted = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, 'work') });
  assert.equal(extracted.units.length, 1);
  assert.equal(extracted.units[0].source, 'Buy');
  assert.equal(extracted.units[0].context.selectionReason, reason);
  const built = await lab.dispatch('build', { workspaceDir: extracted.workspaceDir, outputDir: path.join(root, 'built'),
    translations: [{ id: extracted.units[0].id, translation: '购买' }] });
  assert.equal(await readFile(path.join(built.buildDir, 'Vocab.rb'), 'utf8'), original.replace('"Buy"', '"购买"'));
  assert.equal(await readFile(path.join(gameDir, 'Vocab.rb'), 'utf8'), original);
});

test('text occurrence counts parsed source strings, never comments or selection positions', async t => {
  const { gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'Vocab.rb'), '# "Buy"\nFirst = "Buy"\nSecond = "Buy"\n');
  const selection = { file: 'Vocab.rb', text: 'Buy', reason: 'Observed shop display consumer.' };
  await assert.rejects(createLiteralSelections({ gameDir, selections: [selection] }), /2.*occurrence/);
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ ...selection, occurrence: -1 }] }), /occurrence/);
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ ...selection, occurrence: 2 }] }), /occurrence/);
  assert.ok((await createLiteralSelections({ gameDir, selections: [{ ...selection, occurrence: 0 }, { ...selection, occurrence: 1 }] })).code);
});

test('literal selections retain assignment, ownership, exact source, UTF8 and path checks', async t => {
  const { gameDir } = await fixture(t);
  const original = 'Buy = "Buy"\n';
  await writeFile(path.join(gameDir, 'Vocab.rb'), original);
  const selection = { file: 'Vocab.rb', text: 'Buy', reason: 'Observed display use.' };
  const base = { gameDir, selections: [selection] };
  await assert.rejects(createLiteralSelections({ ...base, selections: [{ ...selection, text: 'Missing' }] }), /精确匹配/);
  await assert.rejects(createLiteralSelections({ ...base, selections: [{ ...selection, reason: ' ' }] }), /reason/);
  await assert.rejects(createLiteralSelections({ ...base, selections: [{ file: 'Vocab.rb', literal: '"Buy"', reason: selection.reason }] }), /只接受 text/);
  await assert.rejects(createLiteralSelections({ ...base, selections: [{ ...selection, file: '../Vocab.rb' }] }), /路径/);
  await assert.rejects(createLiteralSelections({ ...base, assignment: { files: ['Other.rb'] } }), /分工/);
  const byteStart = Buffer.byteLength(original.slice(0, original.indexOf('"Buy"') + 1));
  await assert.rejects(createLiteralSelections({ ...base, existingUnits: [{ locator: { file: 'Vocab.rb', byteStart, byteEnd: byteStart + 3 } }] }), /已经/);
  await assert.rejects(createLiteralSelections({ ...base, selections: [selection, selection] }), /结构|重复|边界/);
  await writeFile(path.join(gameDir, 'Vocab.rb'), Buffer.from([0xff, 0xfe, 0x00, 0x22]));
  await assert.rejects(createLiteralSelections(base), /encoded|encoding|UTF|有效/i);
});

test('a failed literal batch identifies its zero-based row without accepting the other rows', async t => {
  const { gameDir } = await fixture(t);
  const original = 'Buy = "Buy"\nSell = "Sell"\n';
  const file = 'Vocab.rb';
  await writeFile(path.join(gameDir, file), original);
  const selection = { file, text: 'Buy', reason: 'Observed shop display.' };
  const missing = 'Missing\n"Label"';
  await assert.rejects(createLiteralSelections({ gameDir, selections: [selection, { ...selection, text: missing }] }), error => {
    assert.match(error.message, /selections\[1\].*0-based/);
    assert.ok(error.message.includes(`file=${JSON.stringify(file)}`));
    assert.ok(error.message.includes(`text=${JSON.stringify(missing)}`));
    assert.match(error.message, /精确匹配/);
    return true;
  });
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
  const corrected = await createLiteralSelections({ gameDir, selections: [selection, { ...selection, text: 'Sell' }] });
  assert.ok(corrected.code);
  assert.equal(await readFile(path.join(gameDir, file), 'utf8'), original);
  const longText = 'x'.repeat(300);
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ ...selection, text: longText }] }), error => {
    assert.ok(error.message.includes(`text=${JSON.stringify(longText.slice(0, 100))}`));
    assert.ok(!error.message.includes(longText));
    return true;
  });
});

test('ambiguous and invalid literal occurrences identify their selection row', async t => {
  const { gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'Vocab.rb'), 'Shop = "Shop"\nFirst = "Buy"\nSecond = "Buy"\n');
  const first = { file: 'Vocab.rb', text: 'Shop', reason: 'Observed shop display.' };
  for (const occurrence of [undefined, -1, 2]) {
    const second = { ...first, text: 'Buy', ...(occurrence === undefined ? {} : { occurrence }) };
    await assert.rejects(createLiteralSelections({ gameDir, selections: [first, second] }), error => {
      assert.match(error.message, /selections\[1\].*0-based/);
      assert.ok(error.message.includes('text="Buy"'));
      assert.match(error.message, /occurrence/);
      return true;
    });
  }
});

test('a matching substring inside Ruby percent strings and JavaScript comments is not a scalar literal', async t => {
  const { gameDir } = await fixture(t);
  for (const [file, text] of [
    ['Vocab.rb', 'Opaque = %q{ "Buy" }\n'],
    ['Vocab.rb', 'Pattern = /"Buy"/\n'],
    ['Vocab.rb', 'Opaque = <<TEXT\n"Buy"\nTEXT\n'],
    ['view.js', '// "Buy"\nconst label = "Other";\n'],
  ]) {
    await writeFile(path.join(gameDir, file), text);
    await assert.rejects(createLiteralSelections({ gameDir, selections: [{ file, text: 'Buy', reason: 'Agent selected text.' }] }), /精确匹配/);
  }
});

test('host-generated literal bindings retain existing quote injection protection', async t => {
  const { root, gameDir } = await fixture(t);
  await writeFile(path.join(gameDir, 'Vocab.rb'), 'Buy = "Buy"\n');
  const definition = await createLiteralSelections({ gameDir, selections: [{ file: 'Vocab.rb', text: 'Buy', reason: 'Display consumer observed.' }] });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  const recipe = await lab.submitRecipe({ ...candidate, validationId: validation.validationId });
  const extracted = await lab.extractRecipe({ ...recipe, gameDir, workspaceDir: path.join(root, 'work') });
  await assert.rejects(lab.dispatch('build', { workspaceDir: extracted.workspaceDir, outputDir: path.join(root, 'built'),
    translations: [{ id: extracted.units[0].id, translation: 'buy"; evil(); #' }] }), /结构|边界/);
});

test('plain text resolves real escaped source strings and JSON must use field pointers', async t => {
  const { root, gameDir } = await fixture(t);
  const source = String.raw`// "A complete line."
const line = "A complete\nline.";
const message = 'It\'s ready.';
`;
  await writeFile(path.join(gameDir, 'message.js'), source);
  const definition = await createLiteralSelections({ gameDir, selections: [
    { file: 'message.js', text: 'A complete\nline.', reason: 'Observed message label.' },
    { file: 'message.js', text: "It's ready.", reason: 'Observed scene dialogue.' },
  ] });
  const lab = await createAdapterLab({ dataDir: path.join(root, 'lab') });
  const candidate = await lab.writeAdapter(definition);
  const validation = await lab.validateAdapter({ ...candidate, gameDir });
  assert.equal(validation.passed, true, validation.error?.message);
  await writeFile(path.join(gameDir, 'data.json'), '{"name":"Buy"}');
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ file: 'data.json', text: 'Buy', reason: 'Inspected field.' }] }), /JSON.*pointer/);
  await writeFile(path.join(gameDir, 'only-comment.js'), '// "Buy"\n');
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ file: 'only-comment.js', text: 'Buy', reason: 'Not executable text.' }] }), /精确匹配/);
  await writeFile(path.join(gameDir, 'key.js'), 'const table = {"Buy": 1}; const selected = table["Buy"];');
  await assert.rejects(createLiteralSelections({ gameDir, selections: [{ file: 'key.js', text: 'Buy', reason: 'Property identity is not display text.' }] }), /精确匹配/);
});
