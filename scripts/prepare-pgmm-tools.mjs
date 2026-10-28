import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extract } from '@electron-internal/extract-zip';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const filename = 'pgmdec-0.6.0-cp312-cp312-win_amd64.whl';
const url = `https://github.com/wqhanginge/PGMMV_Decrypter/releases/download/v0.6.0/${filename}`;
const sha256 = '6f7826cefa88f1e0060fa5104d644750dfb87a7a12816f64f6d56f77aef90958';

export async function preparePgmmTools(directory = root) {
  const destination = path.join(directory, 'local/dependencies/pgmm');
  const archive = path.join(destination, filename);
  await mkdir(destination, { recursive: true });
  let bytes;
  try { bytes = await readFile(archive); } catch {
    await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort',
      '--max-time', '180', '--output', archive, url], { windowsHide: true, timeout: 200_000 });
    bytes = await readFile(archive);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('PGMM codec SHA-256 mismatch');
  await extract(archive, { dir: destination });
  const manifest = { file: `local/dependencies/pgmm/${filename}`, url, sha256, version: '0.6.0',
    commit: 'dd3a35176789dc39667159c6efaf1054cdde9051', variant: 'upstream', license: 'MIT' };
  await writeFile(path.join(destination, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await preparePgmmTools()));
}
