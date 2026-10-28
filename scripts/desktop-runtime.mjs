import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

// The adapter sandbox uses the release synchronous variant, including normal JS promises.
export const quickJsRuntimePackages = ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'];
export const desktopLocales = ['en-US', 'zh-CN', 'zh-TW'];

export async function pruneDesktopLocales(outputDirectory) {
  const directory = path.join(path.resolve(outputDirectory), 'locales');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Electron locales must be a real directory');
  const keep = new Set(desktopLocales.map(locale => `${locale}.pak`));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const name of keep) {
    const entry = entries.find(entry => entry.name === name);
    if (!entry?.isFile()) throw new Error(`Required Electron locale is missing: ${name}`);
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.pak') || keep.has(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`Unexpected Electron locale entry: ${entry.name}`);
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unexpected Electron locale file: ${entry.name}`);
    removed.push({ file, name: entry.name, bytes: stat.size });
  }
  for (const item of removed) await unlink(item.file);
  return { kept: [...keep], removed: removed.map(item => item.name), removedBytes: removed.reduce((sum, item) => sum + item.bytes, 0) };
}
