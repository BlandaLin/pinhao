import { access, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '@electron-internal/extract-zip';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packageHash = 'd2a23832aaa948ba9a01acc42b5726e34c5f995958f1b30d45c0e7c70b3a72d5';
const packageUrl = 'https://api.nuget.org/v3-flatcontainer/mono.cecil/0.11.6/mono.cecil.0.11.6.nupkg';
const licenseUrl = 'https://raw.githubusercontent.com/jbevain/cecil/0.11.6/LICENSE.txt';
const licenseHash = '13d58ecbed676511c0c4c4009bff107025e50007ff5e7901dc562700ec62509e';
const cecilHash = 'c41bdb9ffd3c5f6e17d2382c1012d73703e035e3f1100245fdd4e08c8dc6eb5b';
const managedFiles = ['Mono.Cecil.dll', 'Mono.Cecil-LICENSE.txt', 'Pinhao.ManagedPatch.exe', 'Pinhao.UnityDisplay.exe', 'net20/Pinhao.ManagedAssist.dll', 'net40/Pinhao.ManagedAssist.dll'];
const managedSources = ['Patch.cs', 'UnityDisplay.cs', 'Bridge.cs'];

async function managedSourceHashes(directory) {
  return Object.fromEntries(await Promise.all(managedSources.map(async file =>
    [file, sha256(await readFile(path.join(directory, 'packages/runtime/managed', file)))])));
}

export async function validateManagedSourceIdentity(directory, sourceHashes) {
  const sources = await managedSourceHashes(directory);
  for (const file of managedSources) {
    if (sources[file] !== sourceHashes?.[file]) throw new Error(`Managed tool source identity mismatch: ${file}; run prepare-managed-tools.mjs`);
  }
}

export async function validateManagedTools(directory = root) {
  const target = path.join(directory, 'local/dependencies/managed');
  const manifest = JSON.parse(await readFile(path.join(target, 'provenance.json'), 'utf8'));
  if (manifest.dependency !== 'Mono.Cecil 0.11.6') throw new Error('Managed tools require the prepared Mono.Cecil 0.11.6 set');
  const hashes = Object.fromEntries(await Promise.all(managedFiles.map(async file => [file, sha256(await readFile(path.join(target, file)))])));
  for (const file of managedFiles) {
    if (hashes[file] !== manifest.files?.[file] || file === 'Mono.Cecil.dll' && hashes[file] !== cecilHash) {
      throw new Error(`Managed tool set SHA-256 mismatch: ${file}; run prepare-managed-tools.mjs`);
    }
  }
  await validateManagedSourceIdentity(directory, manifest.sourceHashes);
  return manifest;
}

async function download(url, destination) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort', '--max-time', '180', '--output', destination, url], { windowsHide: true, timeout: 200_000 });
  }
}

export async function prepareManagedTools(directory = root) {
  const target = path.join(directory, 'local/dependencies/managed');
  await mkdir(target, { recursive: true });
  const archive = path.join(target, 'mono.cecil.0.11.6.nupkg');
  try { await access(archive); } catch { await download(packageUrl, archive); }
  if (sha256(await readFile(archive)) !== packageHash) throw new Error('Mono.Cecil 0.11.6 package SHA-256 mismatch');
  const unpacked = path.join(target, 'cecil');
  await extract(archive, { dir: unpacked });
  await copyFile(path.join(unpacked, 'lib/net40/Mono.Cecil.dll'), path.join(target, 'Mono.Cecil.dll'));
  const license = path.join(target, 'Mono.Cecil-LICENSE.txt');
  try { await access(license); } catch { await download(licenseUrl, license); }
  if (sha256(await readFile(license)) !== licenseHash) throw new Error('Mono.Cecil license SHA-256 mismatch');
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await access(compiler);
  const source = path.join(directory, 'packages/runtime/managed');
  await run(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + path.join(target, 'Pinhao.ManagedPatch.exe'), '/reference:' + path.join(target, 'Mono.Cecil.dll'), path.join(source, 'Patch.cs')], { windowsHide: true });
  await run(compiler, ['/nologo', '/optimize+', '/target:exe', '/out:' + path.join(target, 'Pinhao.UnityDisplay.exe'), '/reference:' + path.join(target, 'Mono.Cecil.dll'), '/reference:System.Web.Extensions.dll', path.join(source, 'UnityDisplay.cs')], { windowsHide: true });
  for (const framework of ['net20', 'net40']) {
    const output = path.join(target, framework);
    await mkdir(output, { recursive: true });
    const frameworkDirectory = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework', framework === 'net20' ? 'v2.0.50727' : 'v4.0.30319');
    await run(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/optimize+', '/target:library', '/out:' + path.join(output, 'Pinhao.ManagedAssist.dll'), '/reference:' + path.join(frameworkDirectory, 'mscorlib.dll'), '/reference:' + path.join(frameworkDirectory, 'System.dll'), path.join(source, 'Bridge.cs')], { windowsHide: true });
  }
  const hashes = {};
  for (const file of managedFiles) hashes[file] = sha256(await readFile(path.join(target, file)));
  const manifest = { name: 'Pinhao managed frame assistance and display consumers', version: 3, license: 'GPL-3.0-or-later', dependency: 'Mono.Cecil 0.11.6', dependencyLicense: 'MIT', source: packageUrl, packageSha256: packageHash,
    sourceHashes: await managedSourceHashes(directory), files: hashes };
  await writeFile(path.join(target, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareManagedTools(), null, 2));
