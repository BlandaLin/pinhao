import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const wolfSaveResource = {
  version: '0.1.0',
  url: 'https://github.com/Sinflower/WolfSave/releases/download/v0.1.0/WolfSave.exe',
  sha256: 'bf05866896bf7a41211842a20c56581f8707c7c1a08a538d28bcf271525cf020',
};

export async function prepareLegacyAssist(root) {
  const directory = path.join(root, 'local/dependencies/wolfsave');
  const executable = path.join(directory, 'WolfSave.exe');
  await mkdir(directory, { recursive: true });
  let bytes;
  try { bytes = await readFile(executable); } catch {}
  if (!bytes) {
    const run = promisify(execFile);
    await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort',
      '--max-time', '180', '--output', executable, wolfSaveResource.url], { windowsHide: true, timeout: 200000 });
    bytes = await readFile(executable);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== wolfSaveResource.sha256) throw new Error('WolfSave SHA-256 mismatch');
  for (const name of ['LICENSE', 'README.md']) await copyFile(path.join(root, 'adapters/vendor/wolfsave', name), path.join(directory, name));
  const provenance = { tool: 'Sinflower/WolfSave', ...wolfSaveResource, license: 'MIT',
    source: 'https://github.com/Sinflower/WolfSave/tree/v0.1.0',
    files: ['wolfsave/WolfSave.exe', 'wolfsave/LICENSE', 'wolfsave/README.md'] };
  await writeFile(path.join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareLegacyAssist(fileURLToPath(new URL('../', import.meta.url)));
  console.log('Prepared verified native WOLF save codec.');
}
