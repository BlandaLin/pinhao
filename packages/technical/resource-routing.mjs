import path from 'node:path';

export const RESOURCE_ROUTING_VERSION = 'pinhao-resource-routing-1';

// Routing selects an investigation tool, never whether a string is player-facing.
const extensions = {
  text: 'json jsonl csv tsv txt text xml yaml yml ini cfg conf toml html htm xhtml tres tscn godot import po pot vtt srt ass ssa',
  script: 'js mjs cjs gd rpy rpym ks tjs rb py lua cs yarn ink nani shader cginc hlsl glsl uss uxml',
  container: 'zip 7z rar gz tgz bz2 xz zst lz4 lzma tar iso cab pak arc pck xp3 rpa rgssad rgss2a rgss3a rxdata rvdata rvdata2 ldb lmu wolf mps sgr rbr assets asset bundle unity3d assetbundle res scn gdc gde rpyc rpymc cpk ain mdf wad jar apk ipa',
  image: 'png apng jpg jpeg jfif gif bmp dib tga tif tiff webp ico cur psd psb svg svgz dds ktx ktx2 pvr astc exr hdr ctex stex rpgmvp png_',
  media: 'mp2 mp3 mp4 m4a m4v wav wave ogg oga opus flac aif aiff wma wmv avi mkv mov flv webm mpg mpeg awb acb usm sfd hca at9 rpgmvo rpgmvm ogg_ m4a_',
  font: 'ttf otf ttc woff woff2 eot fnt',
  binary: 'exe dll sys drv so dylib a lib obj o wasm pyc pyo class dex sqlite sqlite3 mdb pdf doc docx xls xlsx ppt pptx ress',
};
export const RESOURCE_ROUTES = Object.freeze([...Object.keys(extensions), 'unknown']);
const byExtension = new Map(Object.entries(extensions).flatMap(([route, names]) => names.split(' ').map(name => [`.${name}`, route])));
const extensionOf = file => path.posix.extname(String(file).replaceAll('\\', '/')).toLowerCase();
const displaySampleExtensions = new Set('json csv tsv txt xml yaml yml tres tscn rpy ks gd js rb'.split(' ').map(name => `.${name}`));

export function resourceRoute(file) {
  return byExtension.get(extensionOf(file)) ?? 'unknown';
}

export function isTextSearchResource(file) {
  const route = resourceRoute(file);
  // These formats can contain text. Actual bytes, not the suffix, decide searchability.
  return ['text', 'script', 'unknown'].includes(route) || ['.svg', '.fnt', '.asset'].includes(extensionOf(file));
}

export function isSourceContextResource(file) {
  // Compiled consumers must still invalidate decisions even though UTF-8 search skips them.
  return resourceRoute(file) !== 'unknown' && isTextSearchResource(file)
    || ['.dll', '.gdc', '.gde', '.rpyc', '.rpymc'].includes(extensionOf(file));
}

export function isDisplaySampleResource(file) {
  // Keyword sampling supports these formats; mere readability must not create paid review work.
  return displaySampleExtensions.has(extensionOf(file)) || resourceRoute(file) === 'unknown';
}

export function resourceRouteSummary(resources = []) {
  const counts = Object.fromEntries(RESOURCE_ROUTES.map(route => [route, 0]));
  for (const item of resources) counts[resourceRoute(item.file ?? item.path)]++;
  return counts;
}
