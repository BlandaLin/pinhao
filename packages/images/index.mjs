import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseModelResponse } from '../core/provider.mjs';
import { createTechnicalTransport } from '../technical/model-transport.mjs';

export const IMAGE_PROMPT_VERSION = 'pinhao-image-ocr-0.1';
const FORMAT = 'pinhao-images-1';
const MAX_PIXELS = 8_000_000;
const MAX_BYTES = 12 * 1024 * 1024;
// Vision input is billed by sent pixels, not stored pixels: a 1080p asset costs about four
// times the image tokens of the same UI at 1536px, where OCR still resolves 12-14px glyphs,
// and a 2048px long edge saves nothing at all on 1080p because the tile count is unchanged.
const OCR_LONG_EDGE = 1536;
// Only the transport copy may be lossy; decoding, coordinates and writeback stay exact.
const OCR_JPEG_BYTES = 700_000;
// A fuse, not a cost knob: it only stops a completion stuck past the 90s wall clock. It sits
// below the transport's OUTPUT_TOKEN_LIMIT so this stage never inherits that ceiling.
const OCR_OUTPUT_TOKENS = 16_384;
const OCR_REFINE_TOKENS = 4_096;
const OCR_REFINE_TIMEOUT_MS = 45_000;
// A downscaled glyph under this height is unreadable, so one native crop replaces the guess.
const OCR_SMALL_TEXT_PX = 12;
const OCR_REFINE_CROPS = 1;
const OCR_REFINE_MIN_NATIVE = 24;
// Header probes and OCR results are memoised per project; both are bounded so a sweep over
// tens of thousands of assets cannot grow memory or disk work without limit.
const SNIFF_PROBES = 4_096;
const SIGNATURE_ENTRIES = 20_000;
const CACHE_ENTRIES = 4_096;
const CACHE_PROJECTS = 32;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 16x16 grey is the smallest raster that still separates two labels on one button shape:
// identical art re-encoded stays under the mean gate, different glyphs blow the max gate.
const GREY_SIDE = 16;
const GREY_MEAN_DIFF = 1.5;
const GREY_MAX_DIFF = 16;
const DHASH_HAMMING = 2;
const hash = value => createHash('sha256').update(value).digest('hex');
const decoderOptions = { limitInputPixels: MAX_PIXELS, failOn: 'warning' };
const issue = (file, code, message, extra = {}) => ({ file, code, message, ...extra });

function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f:*?"<>|]/.test(value) || value.startsWith('/') || value.startsWith('\\') || path.isAbsolute(value)) throw new Error('图片定位需要相对文件路径');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('图片定位路径无效');
  return parts.join('/');
}

async function regularFile(root, relative) {
  const rel = relativeFile(relative);
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('图片文件和目录需要位于本项目内');
  }
  const info = await lstat(cursor);
  if (!info.isFile()) throw new Error('图片需要普通文件');
  const canonical = await realpath(cursor);
  const actual = path.relative(canonicalRoot, canonical);
  if (actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('图片文件位于项目之外');
  return { target: cursor, info };
}

// Engine packs decorate real assets instead of renaming them ("tutorial.png_", "logo.PNG.bak",
// "menu.png~", "title.png.orig"): the pixels are a plain PNG/JPEG the decoder handles, so a
// short decoration tail after a known image extension must not disqualify the file.
const IMAGE_NAME = /^.*\.(?:png|jpe?g)(?:[._~-][^/]{0,16})?$/i;
const PACKED_DIR = /(?:^|\/)(?:cg|ev|eventcg|hcg|backgrounds?|battlebacks?[12]?|characters?|faces?|portraits?|tilesets?|animations?|enemies|battlers|sv_actors|sv_enemies|parallaxes)(?:\/|$)/i;
const UI_DIR = /(?:^|\/)(?:ui|gui|system|buttons?|titles?[12]?|menus?|interface)(?:\/|$)/i;
const UI_NAME = /(?:button|btn|menu|title|logo|help|tutorial|guide|select|option|confirm|cancel|save|load|deck|cardname|explain|説明|操作|タイトル|ボタン|メニュー)/i;

const recognizedImageName = file => IMAGE_NAME.test(file);

function interfaceName(normalized) {
  if (PACKED_DIR.test(normalized)) return false;
  return UI_DIR.test(normalized) || UI_NAME.test(path.posix.basename(normalized));
}

function likelyInterface(file) {
  const normalized = file.toLowerCase();
  return recognizedImageName(normalized) && interfaceName(normalized);
}

/** Deterministic UI-first scope, shared by the scheduler and OCR worker. */
export function imageCandidates(inventory) {
  const files = [], excluded = [];
  const seen = new Set();
  for (const item of inventory ?? []) {
    const file = relativeFile(typeof item === 'string' ? item : item?.file);
    if (seen.has(file)) continue;
    seen.add(file);
    if (likelyInterface(file)) files.push(file); else excluded.push(file);
  }
  files.sort(); excluded.sort();
  return { files, excluded };
}

// Per-project memory: header probes (so an unknown name is read once, not once per batch) and
// OCR results addressed by content. Keyed by project path because assets, not runs, repeat.
const projectCaches = new Map();

function projectCache(gameDir) {
  const key = path.resolve(gameDir).toLowerCase();
  const existing = projectCaches.get(key);
  if (existing) return existing;
  const cache = { signatures: new Map(), probes: 0, byBytes: new Map(), byArt: new Map(), order: [] };
  if (projectCaches.size >= CACHE_PROJECTS) projectCaches.delete(projectCaches.keys().next().value);
  projectCaches.set(key, cache);
  return cache;
}

/** Drop memoised OCR results for one project, e.g. after its assets changed on disk. */
export function forgetImageCaches(gameDir) {
  const key = path.resolve(gameDir).toLowerCase();
  return gameDir === undefined ? projectCaches.clear() : projectCaches.delete(key);
}

/** True when the file header is a PNG or JPEG regardless of what the name claims. */
async function headerFormat(gameDir, relative, cache, materialize) {
  if (cache.signatures.has(relative)) return cache.signatures.get(relative);
  await materialize?.([relative]);
  let format = null;
  try {
    const { target } = await regularFile(gameDir, relative);
    const handle = await open(target, 'r');
    try {
      const head = Buffer.alloc(12);
      const { bytesRead } = await handle.read(head, 0, 12, 0);
      if (bytesRead >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) format = 'png';
      else if (bytesRead >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) format = 'jpeg';
    } finally { await handle.close(); }
  } catch { format = null; }
  if (cache.signatures.size >= SIGNATURE_ENTRIES) cache.signatures.clear();
  cache.signatures.set(relative, format);
  return format;
}

/**
 * Names decide nothing on their own: an engine may store a plain PNG under a name the
 * extension rule cannot know. Every excluded file with an unrecognised name is probed once,
 * and a real PNG/JPEG header puts it back into the candidate list under the same directory
 * rules, so the scope stays deterministic and cheap to recompute.
 */
async function widenScope({ gameDir, scope, cache, signal, materialize }) {
  const recovered = [];
  for (const file of scope.excluded) {
    if (cache.probes >= SNIFF_PROBES) break;
    if (recognizedImageName(file)) continue;
    signal?.throwIfAborted();
    if (!cache.signatures.has(file)) cache.probes++;
    if (await headerFormat(gameDir, file, cache, materialize) && interfaceName(file)) recovered.push(file);
  }
  if (!recovered.length) return { files: scope.files, excluded: scope.excluded, recovered };
  const recoveredSet = new Set(recovered);
  return {
    files: [...scope.files, ...recovered].sort(),
    excluded: scope.excluded.filter(file => !recoveredSet.has(file)),
    recovered,
  };
}

// --- content identity -------------------------------------------------------------------
// Three tiers, cheapest first. Bytes catch copies; the art tier catches the same picture
// re-encoded or re-packed under another name. Both are only ever used to reuse OCR output.

async function greyRaster(bytes) {
  const { data, info } = await sharp(bytes, decoderOptions).greyscale()
    .resize(GREY_SIDE, GREY_SIDE, { fit: 'fill', kernel: sharp.kernel.area }).raw().toBuffer({ resolveWithObject: true });
  return info.channels === 1 && data.length === GREY_SIDE * GREY_SIDE ? data : null;
}

const ART_CELLS = GREY_SIDE / 2;

/** dHash over 8x8 cells (56 bits) reduced from the 16x16 raster: gradient, not brightness. */
function artBits(raster) {
  let bits = '';
  for (let y = 0; y < ART_CELLS; y++) for (let x = 0; x < ART_CELLS - 1; x++) {
    let left = 0, right = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      left += raster[(y * 2 + dy) * GREY_SIDE + x * 2 + dx];
      right += raster[(y * 2 + dy) * GREY_SIDE + (x + 1) * 2 + dx];
    }
    bits += left > right ? '1' : '0';
  }
  return bits;
}

const artKey = (width, height, bits) => `${width}x${height}:${bits}`;

function artDistance(a, b) {
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); sum += delta; if (delta > max) max = delta; }
  return { mean: sum / a.length, max };
}

/**
 * Exact bytes always match. A perceptual match additionally needs identical canvas, a dHash
 * within DHASH_HAMMING, and a 16x16 comparison inside both the mean and max gates: the max
 * gate is what keeps "Start" and "End" on one button shape from collapsing into one result,
 * because a differing glyph lights up a whole cell. Anything that fails any gate is a
 * separate picture and is recognised on its own.
 */
function cachedResult(cache, { byteHash, width, height, raster, bits }) {
  const exact = cache.byBytes.get(byteHash);
  if (exact) return { entry: exact, how: 'exact' };
  if (!raster) return null;
  for (const entry of cache.byArt.get(artKey(width, height, bits)) ?? []) {
    if (entry.width !== width || entry.height !== height) continue;
    const { mean, max } = artDistance(entry.raster, raster);
    if (mean > GREY_MEAN_DIFF || max > GREY_MAX_DIFF) continue;
    return { entry, how: 'perceptual' };
  }
  return null;
}

function rememberResult(cache, { byteHash, width, height, raster, bits, regions }) {
  const entry = { byteHash, width, height, raster, bits, key: artKey(width, height, bits), regions: regions.map(region => ({ source: region.source, box: { ...region.box } })) };
  cache.byBytes.set(byteHash, entry);
  cache.byArt.set(entry.key, [...(cache.byArt.get(entry.key) ?? []), entry]);
  cache.order.push(entry);
  while (cache.order.length > CACHE_ENTRIES) {
    const stale = cache.order.shift();
    if (cache.byBytes.get(stale.byteHash) === stale) cache.byBytes.delete(stale.byteHash);
    const rest = (cache.byArt.get(stale.key) ?? []).filter(item => item !== stale);
    if (rest.length) cache.byArt.set(stale.key, rest); else cache.byArt.delete(stale.key);
  }
}

// --- request shaping --------------------------------------------------------------------

/**
 * One downscaled page per image. The native canvas is never sent: coordinates come back in
 * the scaled space this function reports, and the caller maps them onto the real canvas.
 */
async function ocrPayload(bytes, width, height) {
  const longEdge = Math.max(width, height);
  if (longEdge <= OCR_LONG_EDGE) {
    return { image: await sharp(bytes, decoderOptions).png().toBuffer(), mediaType: 'image/png', width, height, sx: 1, sy: 1, resized: false };
  }
  const scaleX = OCR_LONG_EDGE / width, scaleY = OCR_LONG_EDGE / height;
  const scaledWidth = Math.max(1, Math.round(width * scaleX)), scaledHeight = Math.max(1, Math.round(height * scaleY));
  const pipeline = sharp(bytes, decoderOptions).resize({ width: scaledWidth, height: scaledHeight, fit: 'fill', kernel: 'lanczos3' });
  let image = await pipeline.clone().png({ compressionLevel: 9 }).toBuffer();
  let mediaType = 'image/png';
  // Lossless first for glyph edges; fall back to lossy only when the upload itself is large.
  if (image.length > OCR_JPEG_BYTES) { image = await pipeline.clone().jpeg({ quality: 88 }).toBuffer(); mediaType = 'image/jpeg'; }
  return { image, mediaType, width: scaledWidth, height: scaledHeight, sx: scaledWidth / width, sy: scaledHeight / height, resized: true };
}

const clampInt = (value, low, high) => Math.min(high, Math.max(low, Math.round(value)));

/** Map scaled-space boxes back onto the native canvas and prove they are still legal there. */
function remapRegions(regions, { sx, sy }, width, height) {
  const mapped = regions.map(({ source, box }) => {
    const left = clampInt(box.left / sx, 0, width - 4);
    const top = clampInt(box.top / sy, 0, height - 4);
    const right = clampInt((box.left + box.width) / sx, left + 4, width);
    const bottom = clampInt((box.top + box.height) / sy, top + 4, height);
    return { source, box: { left, top, width: right - left, height: bottom - top } };
  });
  const kept = [];
  for (const region of mapped.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)) {
    const clash = kept.find(item => overlaps(item.box, region.box));
    if (!clash) { kept.push(region); continue; }
    // Rounding can push two boxes into each other. Trim the lower one to the free band
    // instead of dropping recognised text, and drop it only when nothing usable is left.
    const top = clash.box.top + clash.box.height;
    const bottom = region.box.top + region.box.height;
    if (bottom - top < 4) continue;
    kept.push({ ...region, box: { ...region.box, top, height: bottom - top } });
  }
  return validateRegions({ regions: kept }, width, height);
}

/** One native-resolution crop, only for text the downscale left below the legibility floor. */
async function refineSource({ bytes, width, height, region, connection, signal, artifactDir, requestArtifacts }) {
  const pad = Math.max(8, Math.round(region.box.height * 0.4));
  const left = Math.max(0, region.box.left - pad), top = Math.max(0, region.box.top - pad);
  const cropWidth = Math.min(width - left, region.box.width + pad * 2);
  const cropHeight = Math.min(height - top, region.box.height + pad * 2);
  if (cropWidth < 16 || cropHeight < 12) return null;
  const zoom = Math.min(3, Math.max(1, 64 / cropHeight));
  const scaledWidth = Math.min(1400, Math.round(cropWidth * zoom));
  const scaledHeight = Math.max(1, Math.round(cropHeight * scaledWidth / cropWidth));
  const image = await sharp(bytes, decoderOptions).extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: scaledWidth, height: scaledHeight, fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  const timeout = AbortSignal.timeout(OCR_REFINE_TIMEOUT_MS);
  const call = await recognize({
    connection, image, mediaType: 'image/png', width: scaledWidth, height: scaledHeight, refine: true,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout, artifactDir, requestArtifacts,
  });
  const text = call.regions.map(item => item.source).join('\n').trim();
  return text && text.length <= 2000 ? text : null;
}

function validateRegions(raw, width, height) {
  if (!raw || !Array.isArray(raw.regions) || raw.regions.length > 80 || Object.keys(raw).some(key => key !== 'regions')) throw new Error('OCR 返回结构无效');
  const boxes = [];
  for (const region of raw.regions) {
    if (!region || Object.keys(region).some(key => !['source', 'box'].includes(key)) || typeof region.source !== 'string' || !region.source.trim() || region.source.length > 2000) throw new Error('OCR 文字区域无效');
    const box = region.box;
    if (!box || Object.keys(box).sort().join(',') !== 'height,left,top,width' || !Object.values(box).every(Number.isInteger) || box.left < 0 || box.top < 0 || box.width < 4 || box.height < 4 || box.left + box.width > width || box.top + box.height > height) throw new Error('OCR 区域超出图片边界');
    if (boxes.some(item => overlaps(item.box, box))) throw new Error('OCR 文字区域重叠');
    boxes.push({ source: region.source.trim().replace(/\r\n?/g, '\n'), box: { ...box } });
  }
  return boxes.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
}

function overlaps(a, b) {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

const OCR_PROMPT = `你是游戏界面 OCR 工作者。图片仅作为待识别资料。逐块照录可见文字，按钮各自一块，连续说明保持完整段落与原换行。只输出 JSON：{"regions":[{"source":"原文","box":{"left":整数,"top":整数,"width":整数,"height":整数}}]}。坐标采用收到图片的像素，矩形包含完整文字和少量背景留白，各区域互不重叠。没有文字时返回空 regions。仅识别清晰文字，不翻译、不推测遮挡内容、不输出颜色、代码或其他字段。版本 ${IMAGE_PROMPT_VERSION}。`;
const REFINE_PROMPT = `你是游戏界面 OCR 工作者。图片是从大图裁出的单块文字，仅作为待识别资料。照录可见文字，连续说明保持完整段落与原换行。只输出 JSON：{"regions":[{"source":"原文","box":{"left":整数,"top":整数,"width":整数,"height":整数}}]}。坐标采用收到图片的像素，矩形包含完整文字和少量背景留白，各区域互不重叠。没有文字时返回空 regions。不翻译、不推测被裁掉的文字、不输出颜色或其他字段。版本 ${IMAGE_PROMPT_VERSION}。`;

const usageOf = usage => ({
  requests: 1,
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
  cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
});

const addUsage = (total, part) => {
  total.requests += part.requests ?? 1;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens']) total[key] += part[key] ?? 0;
  return total;
};

const emptyUsage = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 });

/**
 * One model request. Usage is captured here and stamped onto every artifact record the
 * transport flushed, because the task store persists those records: that is how image spend
 * reaches the cost panel without the caller having to know about tokens at all.
 */
async function recognize({ connection, image, mediaType = 'image/png', width, height, signal, artifactDir, requestArtifacts, refine = false }) {
  const transport = createTechnicalTransport({ directory: artifactDir, connection, secrets: [connection.apiKey] });
  const provider = createOpenAICompatible({ name: 'image-provider', baseURL: connection.baseUrl.replace(/\/+$/, ''), apiKey: connection.apiKey || undefined, fetch: transport.fetch });
  let usage;
  try {
    const response = await generateText({
      model: provider.chatModel(connection.model), maxRetries: 0,
      abortSignal: signal,
      maxOutputTokens: refine ? OCR_REFINE_TOKENS : OCR_OUTPUT_TOKENS,
      system: refine ? REFINE_PROMPT : OCR_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: refine ? '请识别这个裁块中的文字。' : `图片尺寸 ${width} × ${height} 像素。请识别可见界面文字。` }, { type: 'file', mediaType, data: image }] }],
    });
    usage = usageOf(response.usage);
    const text = response.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return { regions: validateRegions(parseModelResponse(text, { finishReason: response.finishReason, reasoningCharacters: response.reasoningText?.length ?? 0 }), width, height), usage };
  } finally {
    const flushed = await transport.flush();
    if (usage) for (const record of flushed) record.usage = { ...usage, model: connection.model };
    requestArtifacts.push(...flushed);
  }
}

const OCR_TIMEOUT_MS = 90_000;

/** Payload, one retry, coordinate mapping, and the bounded native crop pass, per image. */
async function recognizeImage({ bytes, width, height, connection, signal, artifactDir, requestArtifacts }) {
  const usage = emptyUsage();
  const payload = await ocrPayload(bytes, width, height);
  if (payload.image.length > MAX_BYTES) return { regions: null, usage, oversized: true };
  let regions = null;
  for (let attempt = 0; attempt < 2 && !regions; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(OCR_TIMEOUT_MS);
      const call = await recognize({
        connection, image: payload.image, mediaType: payload.mediaType, width: payload.width, height: payload.height,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, artifactDir, requestArtifacts,
      });
      addUsage(usage, call.usage);
      regions = payload.resized ? remapRegions(call.regions, payload, width, height) : call.regions;
    } catch {
      signal?.throwIfAborted();
    }
  }
  if (!regions) return { regions: null, usage };
  if (payload.resized) {
    let budget = OCR_REFINE_CROPS;
    for (const region of regions) {
      if (!budget) break;
      if (region.box.height * payload.sy >= OCR_SMALL_TEXT_PX || region.box.height < OCR_REFINE_MIN_NATIVE) continue;
      signal?.throwIfAborted();
      budget--;
      try {
        const call = { regions: [], usage: emptyUsage() };
        const text = await refineSource({ bytes, width, height, region, connection, signal, artifactDir, requestArtifacts });
        addUsage(usage, { ...call.usage, requests: 1 });
        if (text) region.source = text;
      } catch { signal?.throwIfAborted(); }
    }
  }
  return { regions, usage };
}

/** Persist one accounting line per image batch beside the request artifacts, best effort. */
async function journalUsage({ artifactDir, relative, width, height, model, usage, reused, how }) {
  if (!artifactDir) return;
  try {
    await mkdir(artifactDir, { recursive: true });
    await appendFile(path.join(artifactDir, 'usage.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), file: relative, width, height, model,
      requests: usage.requests, reused, matched: how,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens, reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
    })}\n`, 'utf8');
  } catch { /* accounting must never fail the batch */ }
}

/** Called inside one scheduler slot; model requests are deliberately sequential. */
export async function prepareImages({ gameDir, inventory, connection, signal, onProgress, offset = 0, limit = 40, artifactDir, dedupe = true, materialize }) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('图片批次范围无效');
  const cache = projectCache(gameDir);
  const scope = await widenScope({ gameDir, scope: imageCandidates(inventory), cache, signal, materialize });
  const selected = scope.files.slice(offset, offset + limit);
  const units = [], files = [], issues = [], requestArtifacts = [];
  const usage = emptyUsage();
  const dedupe_ = { exact: 0, perceptual: 0, reused: 0 };
  for (const [index, relative] of selected.entries()) {
    signal?.throwIfAborted();
    await materialize?.([relative]);
    try {
      const { target, info } = await regularFile(gameDir, relative);
      if (info.size > MAX_BYTES) { issues.push(issue(relative, 'IMAGE_SIZE_LIMIT', '图片超过本轮大小限制，保留原图')); continue; }
      const bytes = await readFile(target);
      const metadata = await sharp(bytes, decoderOptions).metadata();
      if (!['png', 'jpeg'].includes(metadata.format) || metadata.pages > 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) { issues.push(issue(relative, 'IMAGE_FORMAT_LIMIT', '图片格式或画布需要专项处理，保留原图')); continue; }
      const { width, height } = metadata;
      if (width < 12 || height < 10) continue;
      const sourceHash = hash(bytes);
      const raster = dedupe ? await greyRaster(bytes) : null;
      const bits = raster ? artBits(raster) : '';
      const hit = dedupe ? cachedResult(cache, { byteHash: sourceHash, width, height, raster, bits }) : null;
      let regions, imageUsage = emptyUsage();
      if (hit) {
        // Same pixels under another name: reuse the recognised text, never the model call.
        regions = hit.entry.regions.map(region => ({ source: region.source, box: { ...region.box } }));
        dedupe_[hit.how]++;
        dedupe_.reused++;
      } else {
        const result = await recognizeImage({ bytes, width, height, connection, signal, artifactDir, requestArtifacts });
        if (result.oversized) { issues.push(issue(relative, 'IMAGE_SIZE_LIMIT', '标准化图片超过本轮大小限制，保留原图')); continue; }
        addUsage(usage, result.usage); imageUsage = result.usage;
        if (!result.regions) { issues.push(issue(relative, 'IMAGE_OCR_FAILED', '图片识别失败，已保留原图；请更换视觉模型后重试')); continue; }
        regions = result.regions;
        if (dedupe) rememberResult(cache, { byteHash: sourceHash, width, height, raster, bits, regions });
      }
      const bound = regions.map(region => ({ ...region, id: `image:${hash(`${relative}:${JSON.stringify(region.box)}:${region.source}`).slice(0, 24)}` }));
      files.push({ relative, sourceHash, width, height, format: metadata.format, regions: bound });
      for (const region of bound) units.push({ id: region.id, kind: 'image_text', source: region.source, translation: region.source, tokens: [], notes: '', context: { file: relative, imageSourceHash: sourceHash, region: region.box, imageWidth: width, imageHeight: height, promptVersion: IMAGE_PROMPT_VERSION } });
      await journalUsage({ artifactDir, relative, width, height, model: connection.model, usage: imageUsage, reused: Boolean(hit), how: hit?.how });
    } catch (error) {
      signal?.throwIfAborted();
      issues.push(issue(relative, 'IMAGE_READ_FAILED', '图片读取或解码失败，已保留原图'));
    } finally {
      onProgress?.({ completed: offset + index + 1, total: scope.files.length, file: relative });
    }
  }
  const nextOffset = Math.min(offset + selected.length, scope.files.length);
  return {
    units,
    usage,
    dedupe: dedupe_,
    binding: { format: FORMAT, files, scope: {
      inventoried: scope.files.length + scope.excluded.length, candidateCount: scope.files.length,
      excludedCount: scope.excluded.length, excludedFiles: scope.excluded,
      recoveredCount: scope.recovered.length, deduct: undefined, dedupe: dedupe_,
      offset, processed: selected.length, nextOffset,
    } },
    issues, requestArtifacts, nextOffset, done: nextOffset >= scope.files.length,
  };
}

const distance = (a, b) => a[3] < 8 && b[3] < 8 ? 0 : Math.max(...a.map((value, index) => Math.abs(value - b[index])));
const colorKey = color => color[3] < 8 ? '0,0,0,0' : color.map(value => Math.round(value / 16) * 16).join(',');

function dominant(pixels) {
  const bins = new Map();
  for (const pixel of pixels) {
    const key = colorKey(pixel);
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0, 0] };
    bin.count++;
    pixel.forEach((value, index) => bin.sum[index] += value);
    bins.set(key, bin);
  }
  const best = [...bins.values()].sort((a, b) => b.count - a.count)[0];
  return best ? best.sum.map(value => Math.round(value / best.count)) : null;
}

function flatTextStyle(data, width, height, box) {
  const get = (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  const edge = [], inside = [];
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      const pixel = get(x, y); inside.push(pixel);
      if (x < box.left + 2 || y < box.top + 2 || x >= box.left + box.width - 2 || y >= box.top + box.height - 2) edge.push(pixel);
    }
  }
  const background = dominant(edge);
  if (!background || edge.filter(pixel => distance(pixel, background) <= 24).length / edge.length < 0.95) return null;
  if (inside.filter(pixel => distance(pixel, background) <= 24).length / inside.length < 0.55) return null;
  const ink = inside.filter(pixel => distance(pixel, background) >= 64 && pixel[3] > 100);
  if (!ink.length) return null;
  const foreground = dominant(ink);
  // Antialiased glyph edges interpolate between paper and ink rather than forming
  // one flat colour. Reject chromatic detail, while allowing that interpolation.
  const direction = foreground.map((value, index) => value - background[index]);
  const norm = direction.reduce((sum, value) => sum + value * value, 0);
  const isGlyph = pixel => {
    if (background[3] < 8) return Math.max(...pixel.slice(0, 3).map((value, index) => Math.abs(value - foreground[index]))) <= 32;
    const ratio = Math.max(0, Math.min(1, pixel.reduce((sum, value, index) => sum + (value - background[index]) * direction[index], 0) / norm));
    return Math.max(...pixel.map((value, index) => Math.abs(value - background[index] - ratio * direction[index]))) <= 24;
  };
  if (ink.filter(isGlyph).length / ink.length < 0.95) return null;
  if (box.left + box.width > width || box.top + box.height > height) return null;
  return { background, foreground };
}

function fontFamily(bytes) {
  const count = bytes.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16;
    if (bytes.toString('ascii', entry, entry + 4) !== 'name') continue;
    const start = bytes.readUInt32BE(entry + 8), end = start + bytes.readUInt32BE(entry + 12);
    if (end > bytes.length) throw new Error('字体名称表无效');
    const records = bytes.readUInt16BE(start + 2), strings = start + bytes.readUInt16BE(start + 4);
    const names = [];
    for (let n = 0; n < records; n++) {
      const at = start + 6 + n * 12;
      const platform = bytes.readUInt16BE(at), nameId = bytes.readUInt16BE(at + 6);
      if (![0, 3].includes(platform) || ![1, 16].includes(nameId)) continue;
      const length = bytes.readUInt16BE(at + 8), offset = strings + bytes.readUInt16BE(at + 10);
      if (offset + length > end || length % 2) continue;
      const buffer = Buffer.from(bytes.subarray(offset, offset + length)); buffer.swap16();
      names.push({ name: buffer.toString('utf16le'), score: (nameId === 16 ? 2 : 0) + (bytes.readUInt16BE(at + 4) === 0x409 ? 1 : 0) });
    }
    const name = names.sort((a, b) => b.score - a.score)[0]?.name;
    if (name && !/[\x00-\x1f"<>]/.test(name)) return name;
  }
  throw new Error('需要具有标准名称表的 TTF/OTF 字体');
}

const markup = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Repaint bounded, flat-background PNG labels in the assembled copy only. */
export async function applyImageText({ outputDir, binding, translations, fontPath }) {
  if (binding?.format !== FORMAT || !Array.isArray(binding.files)) throw new Error('请用当前版本重新提取图片文字定位');
  const known = new Map();
  for (const file of binding.files) {
    relativeFile(file.relative);
    const regions = validateRegions({ regions: file.regions.map(({ source, box }) => ({ source, box })) }, file.width, file.height);
    if (regions.length !== file.regions.length) throw new Error('图片定位区域无效');
    for (const region of file.regions) {
      if (known.has(region.id)) throw new Error('图片定位 ID 重复');
      known.set(region.id, region);
    }
  }
  const selected = new Map();
  for (const row of translations) {
    if (!known.has(row.id) || selected.has(row.id) || typeof row.translation !== 'string' || row.translation.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(row.translation)) throw new Error('图片译文包含未知、重复或无效记录');
    selected.set(row.id, row.translation.replace(/\r\n?/g, '\n'));
  }
  const pending = binding.files.filter(file => file.regions.some(region => selected.has(region.id) && selected.get(region.id) !== region.source));
  if (!pending.length) return { changed: 0, files: [], issues: [] };
  let family;
  try { family = fontFamily(await readFile(fontPath)); }
  catch { return { changed: 0, files: [], issues: [issue('', 'IMAGE_FONT_UNAVAILABLE', '已保留原图，请在设置中选择有效的 TTF/OTF 字体后重新生成')] }; }
  const files = [], issues = [];
  for (const file of pending) {
    try {
      const { target } = await regularFile(outputDir, file.relative);
      const bytes = await readFile(target);
      if (hash(bytes) !== file.sourceHash) { issues.push(issue(file.relative, 'IMAGE_BASELINE_CHANGED', '图片与识别基线不同，保留当前图片')); continue; }
      if (file.format !== 'png') { issues.push(issue(file.relative, 'IMAGE_REDRAW_FORMAT', '有损格式已提取文字，原图重绘留待专项处理')); continue; }
      const { data, info } = await sharp(bytes, decoderOptions).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== file.width || info.height !== file.height || info.channels !== 4) throw new Error('图片画布与定位不一致');
      const output = Buffer.from(data);
      let changed = 0;
      for (const region of file.regions) {
        if (!selected.has(region.id) || selected.get(region.id) === region.source) continue;
        const translation = selected.get(region.id);
        const box = region.box;
        const style = flatTextStyle(data, info.width, info.height, box);
        if (!style || !translation.trim()) { issues.push(issue(file.relative, 'IMAGE_COMPLEX_BACKGROUND', '文字背景或排版需要专项重绘，保留原图区域', { unitId: region.id })); continue; }
        const color = '#' + style.foreground.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
        const rendered = await sharp({ text: { text: `<span foreground="${color}">${markup(translation)}</span>`, font: `${family} 24`, fontfile: fontPath, rgba: true, width: box.width - 4, height: box.height - 4, align: 'centre', wrap: 'word-char' } }).png().toBuffer({ resolveWithObject: true });
        const { data: ink, info: textInfo } = await sharp(rendered.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (textInfo.width > box.width || textInfo.height > box.height || textInfo.height < 5 || 24 * rendered.info.textAutofitDpi / 72 < Math.min(10, box.height / 2)) { issues.push(issue(file.relative, 'IMAGE_TEXT_FIT', '译文在当前区域排版过密，保留原图区域', { unitId: region.id })); continue; }
        const x0 = box.left + Math.floor((box.width - textInfo.width) / 2), y0 = box.top + Math.floor((box.height - textInfo.height) / 2);
        // Copy raw pixels to keep the canvas and every pixel outside accepted boxes intact.
        for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) output.set(style.background, (y * info.width + x) * 4);
        for (let y = 0; y < textInfo.height; y++) for (let x = 0; x < textInfo.width; x++) {
          const at = (y * textInfo.width + x) * 4, dest = ((y0 + y) * info.width + x0 + x) * 4;
          const alpha = ink[at + 3] / 255, baseAlpha = output[dest + 3] / 255;
          const resultAlpha = alpha + baseAlpha * (1 - alpha);
          for (let c = 0; c < 3; c++) output[dest + c] = resultAlpha ? Math.round((ink[at + c] * alpha + output[dest + c] * baseAlpha * (1 - alpha)) / resultAlpha) : 0;
          output[dest + 3] = Math.round(resultAlpha * 255);
        }
        changed++;
      }
      if (changed) {
        const result = await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
        const temp = `${target}.pinhao-${randomUUID()}.tmp`;
        let staged = false;
        try { await writeFile(temp, result, { flag: 'wx' }); staged = true; await rename(temp, target); }
        finally { if (staged) await unlink(temp).catch(() => {}); }
        files.push({ file: file.relative, changed });
      }
    } catch {
      issues.push(issue(file.relative, 'IMAGE_REDRAW_FAILED', '图片重绘失败，已保留原图'));
    }
  }
  return { changed: files.reduce((sum, file) => sum + file.changed, 0), files, issues };
}

/** Prepare only selected image copies before an engine rebuilds its resource pack. */
export async function stageImageText({ sourceDir, outputDir, binding, translations, fontPath, materialize }) {
  if (binding?.format !== FORMAT || !Array.isArray(binding.files)) throw new Error('请用当前版本重新提取图片文字定位');
  const known = new Set(binding.files.flatMap(file => file.regions.map(region => region.id)));
  const selected = new Map();
  for (const row of translations) {
    if (!known.has(row.id) || selected.has(row.id) || typeof row.translation !== 'string') throw new Error('图片译文包含未知、重复或无效记录');
    selected.set(row.id, row.translation);
  }
  await mkdir(outputDir);
  const copied = [], issues = [];
  for (const file of binding.files) {
    if (!file.regions.some(region => selected.has(region.id) && selected.get(region.id) !== region.source)) continue;
    const relative = relativeFile(file.relative);
    await materialize?.([relative]);
    try {
      const { target } = await regularFile(sourceDir, relative);
      if (hash(await readFile(target)) !== file.sourceHash) {
        issues.push(issue(relative, 'IMAGE_BASELINE_CHANGED', '图片与识别基线不同，保留当前图片'));
        continue;
      }
      let directory = await realpath(outputDir);
      const parts = relative.split('/');
      for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('图片输出目录需要普通目录');
      }
      await copyFile(target, path.join(directory, parts.at(-1)), 1);
      copied.push(file);
    } catch {
      issues.push(issue(relative, 'IMAGE_REDRAW_FAILED', '图片暂存失败，已保留原图'));
    }
  }
  const result = await applyImageText({ outputDir, binding: { ...binding, files: copied },
    translations: translations.filter(row => copied.some(file => file.regions.some(region => region.id === row.id))), fontPath });
  return { ...result, issues: [...issues, ...result.issues], files: await Promise.all(result.files.map(async file =>
    ({ ...file, sourceHash: copied.find(source => source.relative === file.file).sourceHash,
      sha256: hash(await readFile(path.join(outputDir, file.file))) }))) };
}
