import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extract } from '@electron-internal/extract-zip';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareGodotTools } from './prepare-godot-tools.mjs';
import { preparePgmmTools } from './prepare-pgmm-tools.mjs';
import { prepareUnityTools } from './prepare-unity-tools.mjs';
import { prepareManagedTools } from './prepare-managed-tools.mjs';
import { prepareLegacyAssist } from './prepare-assist-legacy.mjs';
import { builtinFonts } from '../apps/desktop/electron/fonts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const resources = [
  { file: 'local/runtime/python-3.12.10-embeddable-amd64.zip', url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embeddable-amd64.zip', hash: '156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da' },
  { file: 'local/runtime/electron-v44.8.0-win32-x64.zip', url: 'https://github.com/electron/electron/releases/download/v44.8.0/electron-v44.8.0-win32-x64.zip', hash: '1c9319bab793492715f7668e0be0e6a30bf2a8577275e40035bd33601bf6f573' },
  { file: 'local/dependencies/wolftl/WolfTL.exe', url: 'https://github.com/Sinflower/WolfTL/releases/download/v0.6.2/WolfTL.exe', hash: 'a66ffcdb8efa6340b6003cb0afe0cb2bcf3aba5c14499d0b67f8fb868bcfc276', localBuilds: ['9075f9d199800b9ea306196513b273a4925c17b471edb0e5e6db7883fb589b6f'] },
  { file: 'local/dependencies/uberwolf/UberWolfCli.exe', url: 'https://github.com/Sinflower/UberWolf/releases/download/v0.6.4/UberWolfCli.exe', hash: '0c9645733ae9544df11ee0c859a7f2cb51aa547d5d13f7935cb480bdab96fb3a' },
  { file: 'local/dependencies/lcf/lcf2xml.exe', url: 'https://ci.easyrpg.org/job/liblcf-win32/277/artifact/build/bin/lcf2xml.exe', hash: '5822020672595ecc046a79be1ce7f3a4d76e33453575e271ea7c5dce6467ab8a' },
  { file: 'local/runtime/easyrpg-player-0.8.1.1-windows-x64.zip', url: 'https://easyrpg.org/downloads/player/0.8.1.1/easyrpg-player-0.8.1.1-windows-x64.zip', hash: '49590bd595f60cd3a2833f9bea7dcb4b2f90b9a0d86ebf57423378fcdd50cd88' },
  { file: 'local/dependencies/easyrpg/easyrpg-player-0.8.1.1.tar.gz', url: 'https://easyrpg.org/downloads/player/0.8.1.1/easyrpg-player-0.8.1.1.tar.gz', hash: '1f095c75a0e3150dd7e056500d7740b01f2d4d1696170346721d6e864c014629' },
];
resources.push(...builtinFonts.flatMap(font => [
  { file: 'local/runtime/fonts/' + font.file, url: font.url, hash: font.hash },
  { file: 'local/runtime/fonts/' + font.licenseFile, url: font.licenseUrl, hash: font.licenseHash },
]));

async function obtain(resource) {
  const destination = path.join(root, resource.file);
  await mkdir(path.dirname(destination), { recursive: true });
  let bytes;
  try { bytes = await readFile(destination); } catch { /* A missing cache is downloaded below. */ }
  if (!bytes) {
    console.log(`Downloading ${resource.file}`);
    try {
      const response = await fetch(resource.url, { signal: AbortSignal.timeout(25_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(destination, bytes);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort', '--max-time', '600', '--output', destination, resource.url], { windowsHide: true, timeout: 620_000 });
      bytes = await readFile(destination);
    }
  }
  const actual = sha256(bytes);
  if (![resource.hash, ...(resource.localBuilds || [])].includes(actual)) {
    throw new Error(`${resource.file}: SHA-256 mismatch (${actual}). Keep the fixed artifact or update its reviewed version and checksum together.`);
  }
  return { file: resource.file, url: resource.url, sha256: actual, variant: actual === resource.hash ? 'upstream' : 'reproducible-local-patch' };
}

const manifest = [];
for (const resource of resources) manifest.push(await obtain(resource));
async function unpack(archive, directory, expectedFile) {
  try { await access(path.join(root, directory, expectedFile)); return; } catch { /* Install from the verified archive. */ }
  await mkdir(path.join(root, directory), { recursive: true });
  await extract(path.join(root, archive), { dir: path.join(root, directory) });
  await access(path.join(root, directory, expectedFile));
}
await unpack(resources[0].file, 'local/runtime/python', 'python.exe');
await unpack(resources[1].file, 'node_modules/electron/dist', 'electron.exe');
await writeFile(path.join(root, 'node_modules/electron/path.txt'), 'electron.exe');
await unpack('local/runtime/easyrpg-player-0.8.1.1-windows-x64.zip', 'local/runtime/easyrpg-extracted', 'Player.exe');
await copyFile(path.join(root, 'local/runtime/easyrpg-extracted/Player.exe'), path.join(root, 'local/dependencies/easyrpg/Player.exe'));
await copyFile(path.join(root, 'COPYING'), path.join(root, 'local/dependencies/easyrpg/COPYING'));
await copyFile(path.join(root, 'adapters/vendor/easyrpg/README.md'), path.join(root, 'local/dependencies/easyrpg/SOURCE.txt'));
manifest.push(await prepareGodotTools(root));
manifest.push(await preparePgmmTools(root));
manifest.push(await prepareUnityTools(root));
manifest.push(await prepareManagedTools(root));
manifest.push(await prepareLegacyAssist(root));
await run(process.execPath, [path.join(root, 'scripts/prepare-kirikiri-tools.mjs')], { windowsHide: true });
manifest.push(JSON.parse(await readFile(path.join(root, 'local/dependencies/kirikiri/provenance.json'), 'utf8')));
await writeFile(path.join(root, 'local/runtime/tool-versions.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.length} verified Windows resources.`);
