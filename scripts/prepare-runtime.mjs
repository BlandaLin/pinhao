import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extract } from '@electron-internal/extract-zip';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, 'local', 'runtime');
const pythonDir = path.join(runtime, 'python');
const archive = path.join(runtime, 'python-3.12.10-embeddable-amd64.zip');
const pythonUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embeddable-amd64.zip';
const expected = '156c7eea90d58cd7e91a23f28a0056616b13e9f4cf4901b7b99b837b7848c6da';
await mkdir(runtime, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch {
  console.log('Downloading Python embeddable 3.12.10 from python.org');
  const response = await fetch(pythonUrl);
  if (!response.ok) throw new Error(`Python download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Python runtime checksum mismatch');
await writeFile(archive, bytes);
let installed = true;
try { await access(path.join(pythonDir, 'python.exe')); } catch { installed = false; }
if (!installed) {
  await mkdir(pythonDir, { recursive: true });
  await extract(archive, { dir: pythonDir });
}
await writeFile(path.join(runtime, 'python-runtime.json'), JSON.stringify({ version: '3.12.10', url: pythonUrl, sha256: expected }, null, 2) + '\n');
console.log(pythonDir);
