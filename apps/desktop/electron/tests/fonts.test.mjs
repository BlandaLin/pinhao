import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { builtinFonts, copyFontLicense, fontCatalog, fontPreview, seedDefaultFont } from '../fonts.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function withBundledFonts(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-font-fixture-'));
  const bundledFontDir = path.join(directory, 'bundled');
  const dataDir = path.join(directory, 'data');
  const outputDir = path.join(directory, 'output');
  const hashes = builtinFonts.map(({ hash, licenseHash }) => ({ hash, licenseHash }));
  try {
    await mkdir(bundledFontDir);
    await mkdir(outputDir);
    for (const font of builtinFonts) {
      const bytes = Buffer.from(`OTTO-neutral-test-font-${font.id}`);
      const license = Buffer.from(`${font.id}: SIL OPEN FONT LICENSE Version 1.1`);
      await writeFile(path.join(bundledFontDir, font.file), bytes);
      await writeFile(path.join(bundledFontDir, font.licenseFile), license);
      font.hash = sha256(bytes);
      font.licenseHash = sha256(license);
    }
    await run({ directory, bundledFontDir, dataDir, outputDir });
  } finally {
    builtinFonts.forEach((font, index) => Object.assign(font, hashes[index]));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^pinhao-font-fixture-/);
    await rm(directory, { recursive: true, force: true });
  }
}

test('font catalog uses full names and fixed preview IDs', () => {
  const catalog = fontCatalog(builtinFonts.map(font => ({ ...font, path: font.file, licensePath: 'private-license', legacyPath: 'private-managed-path' })));
  assert.deepEqual(catalog.map(font => font.name), ['思源宋体', '思源黑体', '霞鹜文楷']);
  assert.equal(catalog[0].previewUrl, 'pinhao-font://builtin/song');
  assert.ok(catalog.every(font => !Object.hasOwn(font, 'licensePath')));
  assert.ok(catalog.every(font => !Object.hasOwn(font, 'legacyPath')));
  assert.equal(fontCatalog([{ id: 'hei' }], 'http://127.0.0.1:5190/fonts/')[0].previewUrl, 'http://127.0.0.1:5190/fonts/hei');
});

test('font preview serves only catalog entries and carries the real font bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-font-preview-'));
  try {
    const selected = { id: 'song', path: path.join(directory, 'font.otf') };
    const bytes = Buffer.from('OTTO-neutral-test-font');
    await writeFile(selected.path, bytes);
    const response = await fontPreview([selected], 'song');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'font/otf');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await fontPreview([selected], '../font.otf')).status, 404);
    assert.equal((await fontPreview([selected], 'kai')).status, 404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all built-in font licenses follow the chosen font into a game', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pinhao-font-license-'));
  try {
    const fonts = await Promise.all(builtinFonts.map(async font => {
      const licensePath = path.join(directory, 'source-' + font.licenseFile);
      await writeFile(licensePath, `${font.name}: SIL OPEN FONT LICENSE Version 1.1`);
      return { id: font.id, path: path.join(directory, font.file), licensePath };
    }));
    for (const font of fonts) {
      await copyFontLicense(fonts, font.path, directory);
      const filename = font.id === 'kai' ? 'LXGWWenKai-OFL.txt' : builtinFonts.find(row => row.id === font.id).licenseFile;
      assert.match(await readFile(path.join(directory, filename), 'utf8'), /SIL OPEN FONT LICENSE/);
    }
    await copyFontLicense(fonts, '', directory);
    await copyFontLicense(fonts, path.join(directory, 'custom.ttf'), directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bundled fonts provide all three styles without creating a data copy', async () => {
  await withBundledFonts(async ({ dataDir, bundledFontDir }) => {
    const result = await seedDefaultFont({ dataDir, bundledFontDir });
    assert.equal(result.fonts.length, 3);
    assert.equal(result.fontPath, result.fonts.find(font => font.id === 'kai').path);
    for (const font of result.fonts) {
      const definition = builtinFonts.find(row => row.id === font.id);
      assert.equal(font.path, path.join(bundledFontDir, definition.file));
      assert.equal(font.licensePath, path.join(bundledFontDir, definition.licenseFile));
      assert.equal(sha256(await readFile(font.path)), definition.hash);
      assert.equal(sha256(await readFile(font.licensePath)), definition.licenseHash);
      const preview = await fontPreview(result.fonts, font.id);
      assert.equal(sha256(Buffer.from(await preview.arrayBuffer())), definition.hash);
    }
    assert.deepEqual(await seedDefaultFont({ dataDir, bundledFontDir }), result);
    await assert.rejects(access(dataDir), { code: 'ENOENT' });
  });
});

test('existing managed and custom data files are not repaired or removed at startup', async () => {
  await withBundledFonts(async ({ dataDir, bundledFontDir }) => {
    const legacyDir = path.join(dataDir, 'fonts');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, builtinFonts[0].file), 'interrupted old copy');
    await writeFile(path.join(legacyDir, 'custom.ttf'), 'user-selected font');
    await seedDefaultFont({ dataDir, bundledFontDir });
    await seedDefaultFont({ dataDir, bundledFontDir });
    assert.equal(await readFile(path.join(legacyDir, builtinFonts[0].file), 'utf8'), 'interrupted old copy');
    assert.equal(await readFile(path.join(legacyDir, 'custom.ttf'), 'utf8'), 'user-selected font');
    assert.deepEqual((await readdir(legacyDir)).sort(), [builtinFonts[0].file, 'custom.ttf'].sort());
  });
});

for (const field of ['file', 'licenseFile']) {
  test(`corrupt bundled ${field} fails validation without replacing data files`, async () => {
    await withBundledFonts(async ({ dataDir, bundledFontDir }) => {
      const corrupted = path.join(bundledFontDir, builtinFonts[0][field]);
      await writeFile(corrupted, 'corrupt fixture');
      await assert.rejects(seedDefaultFont({ dataDir, bundledFontDir }), /内置字体资源校验失败/);
      assert.equal(await readFile(corrupted, 'utf8'), 'corrupt fixture');
      await assert.rejects(access(dataDir), { code: 'ENOENT' });
    });
  });
}

test('all built-in licenses accompany new bundled and verified legacy selections', async () => {
  await withBundledFonts(async ({ dataDir, bundledFontDir, outputDir }) => {
    const { fonts } = await seedDefaultFont({ dataDir, bundledFontDir });
    await mkdir(path.join(dataDir, 'fonts'), { recursive: true });
    for (const font of fonts) {
      const definition = builtinFonts.find(row => row.id === font.id);
      const filename = font.id === 'kai' ? 'LXGWWenKai-OFL.txt' : definition.licenseFile;
      await copyFontLicense(fonts, font.path, outputDir);
      assert.equal(sha256(await readFile(path.join(outputDir, filename))), definition.licenseHash);
      const legacyOutput = path.join(outputDir, font.id);
      await mkdir(legacyOutput);
      const oldBytes = await readFile(font.path);
      await writeFile(font.legacyPath, oldBytes);
      await copyFontLicense(fonts, font.legacyPath, legacyOutput);
      assert.equal(sha256(await readFile(path.join(legacyOutput, filename))), definition.licenseHash);
      assert.deepEqual(await readFile(font.legacyPath), oldBytes);
    }
  });
});

test('custom fonts with a built-in basename or different legacy bytes are not misidentified', async () => {
  await withBundledFonts(async ({ dataDir, bundledFontDir, outputDir, directory }) => {
    const { fonts } = await seedDefaultFont({ dataDir, bundledFontDir });
    const font = fonts[0];
    await mkdir(path.join(dataDir, 'fonts'), { recursive: true });
    await writeFile(font.legacyPath, 'custom replacement');
    await copyFontLicense(fonts, font.legacyPath, outputDir);
    const customPath = path.join(directory, builtinFonts[0].file);
    await writeFile(customPath, await readFile(font.path));
    await copyFontLicense(fonts, customPath, outputDir);
    assert.deepEqual(await readdir(outputDir), []);
    assert.equal(await readFile(font.legacyPath, 'utf8'), 'custom replacement');
  });
});
