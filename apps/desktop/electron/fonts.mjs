import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';

export const builtinFonts = [
  {
    id: 'song', style: '宋体', name: '思源宋体', family: 'Source Han Serif SC',
    description: '端正文雅，适合叙事与古典氛围。', version: '2.003',
    file: 'SourceHanSerifSC-Regular.otf', licenseFile: 'SourceHanSerif-OFL.txt',
    url: 'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf',
    hash: '78aa7a328fd974df2d688c8a9fd74a33d8334dfa84ab24d9d11efb2ffc464117',
    licenseUrl: 'https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/LICENSE.txt',
    licenseHash: '9ff5bb567e1b92c801fc1069e5fbf992ff8efccacb9db94e5959a5b3ba9bb903',
  },
  {
    id: 'hei', style: '黑体', name: '思源黑体', family: 'Source Han Sans SC',
    description: '清晰利落，适合菜单与密集信息。', version: '2.005',
    file: 'SourceHanSansSC-Regular.otf', licenseFile: 'SourceHanSans-OFL.txt',
    url: 'https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf',
    hash: 'f1d8611151880c6c336aabeac4640ef434fa13cbfbf1ffe82d0a71b2a5637256',
    licenseUrl: 'https://raw.githubusercontent.com/adobe-fonts/source-han-sans/2.005R/LICENSE.txt',
    licenseHash: 'fcac737e761ec63dbfbdce11030a1780161920d80315edba9c8beff1c2bac5a2',
  },
  {
    id: 'kai', style: '楷体', name: '霞鹜文楷', family: 'LXGW WenKai',
    description: '自然舒展，适合对白与轻松故事。', version: '1.522',
    file: 'LXGWWenKai-Regular.ttf', licenseFile: 'OFL.txt',
    url: 'https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf',
    hash: '39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009',
    licenseUrl: 'https://raw.githubusercontent.com/lxgw/LxgwWenKai/v1.522/OFL.txt',
    licenseHash: 'c38b1994a5e48ac30ac7d1da7d0409fd8fd8127dfe28a13d6e787d5b1ef34a5e',
  },
];

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function seedDefaultFont({ dataDir, bundledFontDir }) {
  const fonts = [];
  for (const definition of builtinFonts) {
    for (const [file, expected] of [[definition.file, definition.hash], [definition.licenseFile, definition.licenseHash]]) {
      if (hash(await readFile(path.join(bundledFontDir, file))) !== expected) throw new Error(`内置字体资源校验失败：${file}`);
    }
    fonts.push({
      id: definition.id, style: definition.style, name: definition.name, family: definition.family,
      description: definition.description, path: path.join(bundledFontDir, definition.file),
      license: 'OFL-1.1', licensePath: path.join(bundledFontDir, definition.licenseFile),
      legacyPath: path.join(dataDir, 'fonts', definition.file),
    });
  }
  const selected = fonts.find(font => font.id === 'kai');
  return { fontPath: selected.path, licensePath: selected.licensePath, fonts };
}

export function fontCatalog(fonts, previewPrefix = 'pinhao-font://builtin/') {
  return fonts.map(({ licensePath: _licensePath, legacyPath: _legacyPath, ...font }) => ({ ...font, previewUrl: previewPrefix + font.id }));
}

export async function fontPreview(fonts, id) {
  const font = fonts.find(font => font.id === id);
  if (!font) return new Response('Font not found', { status: 404 });
  return new Response(await readFile(font.path), {
    headers: {
      'Content-Type': path.extname(font.path) === '.otf' ? 'font/otf' : 'font/ttf',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function copyFontLicense(fonts, selectedPath, outputDir) {
  const resolved = path.resolve(selectedPath || '.');
  const selected = fonts.find(font => path.resolve(font.path) === resolved
    || font.legacyPath && path.resolve(font.legacyPath) === resolved);
  if (!selected) return;
  const definition = builtinFonts.find(font => font.id === selected.id);
  // Old settings may still reference an existing managed copy; never identify a custom font by basename.
  if (path.resolve(selected.path) !== resolved && hash(await readFile(resolved)) !== definition.hash) return;
  const filename = definition.id === 'kai' ? 'LXGWWenKai-OFL.txt' : definition.licenseFile;
  await cp(selected.licensePath, path.join(outputDir, filename));
}
