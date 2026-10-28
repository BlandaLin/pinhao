import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extract } from '@electron-internal/extract-zip';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const godotResources = ['gdre_tools.exe', 'gdre_tools.pck', 'GodotMonoDecompNativeAOT.dll'];
const unpackedHashes = [
  'dbcda88ded28b4c9cd0252ba5a4e9af416f91766d9067ca930876e7d4e07215a',
  '150c5f4d585e88d113d71c3e479cc1cf8c56d563a03ac36dd011204558609150',
  '9e5325bdb219331048b3ae7a6fc7e4737e00157383095d73f141bf4ecfb2c54d',
];
const url = 'https://github.com/GDRETools/gdsdecomp/releases/download/v2.7.4/GDRE_tools-v2.7.4-windows.zip';
const sha256 = 'af24c563eee501effb194d83595de64696c32547b2246034dbfb891a24bfa0ad';

export async function prepareGodotTools(directory = root) {
  const destination = path.join(directory, 'local/dependencies/gdre');
  const archive = path.join(destination, 'gdre.zip');
  await mkdir(destination, { recursive: true });
  let bytes;
  try { bytes = await readFile(archive); } catch { /* Acquire the fixed upstream artifact. */ }
  if (!bytes) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(archive, bytes);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort', '--max-time', '600', '--output', archive, url], { windowsHide: true, timeout: 620_000 });
      bytes = await readFile(archive);
    }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('GDRETools archive SHA-256 mismatch');
  let installed = true;
  for (const [index, resource] of godotResources.entries()) {
    try {
      if (createHash('sha256').update(await readFile(path.join(destination, resource))).digest('hex') !== unpackedHashes[index]) installed = false;
    } catch { installed = false; }
  }
  if (!installed) await extract(archive, { dir: destination });
  for (const resource of godotResources) await access(path.join(destination, resource));
  await copyFile(path.join(directory, 'adapters/vendor/gdre/LICENSE'), path.join(destination, 'LICENSE'));
  await copyFile(path.join(directory, 'adapters/vendor/gdre/README.md'), path.join(destination, 'SOURCE.txt'));
  return { file: 'local/dependencies/gdre/gdre.zip', url, sha256, version: '2.7.4', variant: 'upstream' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareGodotTools()));
}
