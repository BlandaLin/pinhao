import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extract } from '@electron-internal/extract-zip';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const url = 'https://krkrz.github.io/download/kr2_232r2.zip';
const expected = '645a6dc0898e41e20603e134ca6ff6a22994e66a9ed9049c059c83ac91b8fa2d';
const archive = path.join(root, 'local/runtime/kr2_232r2.zip');
await mkdir(path.dirname(archive), { recursive: true });
try { await access(archive); } catch {
  await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort',
    '--max-time', '300', '--output', archive, url], { windowsHide: true, timeout: 320_000 });
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== expected) throw new Error('KiriKiri SDK SHA-256 mismatch');
const unpacked = path.join(root, 'local/runtime/kirikiri-sdk');
await mkdir(unpacked, { recursive: true });
await extract(archive, { dir: unpacked });
const sdk = path.join(unpacked, 'kr2_232r2');
const output = path.join(root, 'local/dependencies/kirikiri');
await mkdir(output, { recursive: true });
await copyFile(path.join(sdk, 'kirikiri2/plugin/addFont.dll'), path.join(output, 'addFont.dll'));
const license = new TextDecoder('shift_jis').decode(await readFile(path.join(sdk, 'license.txt')));
await writeFile(path.join(output, 'LICENSE.txt'), license);
const manifest = { tool: 'KiriKiri2 addFont (x86)', version: '2.32r2 SDK', url, sha256: expected,
  files: ['kirikiri/addFont.dll', 'kirikiri/LICENSE.txt'], license: 'W.Dee KiriKiri license (dual GPL-2.0)' };
await writeFile(path.join(output, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared verified KiriKiri private-font plugin.');
