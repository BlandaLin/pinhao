import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { extract } from '@electron-internal/extract-zip';

const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = [
  ['assetstools.net', '3.0.4', '8c3e3844ec0dacd192cb158993deeb8f4e5ae08f31f994c7db8a55580a4548db', 'assets', 'AssetsTools.NET.dll'],
  ['assetstools.net.monocecil', '3.0.4', '8568bb453c60719b64025147b260d98b33af9f946855d1cf43f176a5a5ab16ad', 'monocecil', 'AssetsTools.NET.MonoCecil.dll'],
  ['mono.cecil', '0.10.4', '3451a4a112a81be0bf76b8dc2bca396acdf0455d80c8961e7903ce1fb35c2a9a', 'cecil', 'Mono.Cecil.dll'],
];
const licenses = [
  ['AssetsTools.NET-LICENSE.txt', 'https://raw.githubusercontent.com/nesrak1/AssetsTools.NET/main/LICENSE', 'ab26018f961d37d489bcd0f8277b602d1a41586cda867e59173778c7214ae29f'],
  ['Mono.Cecil-LICENSE.txt', 'https://raw.githubusercontent.com/jbevain/cecil/0.10.4/LICENSE.txt', '13d58ecbed676511c0c4c4009bff107025e50007ff5e7901dc562700ec62509e'],
];

async function obtain(url, file, hash) {
  try { await access(file); } catch {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Unity schema dependency HTTP ${response.status}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort',
        '--max-time', '180', '--output', file, url], { windowsHide: true, timeout: 200_000 });
    }
  }
  if (sha256(await readFile(file)) !== hash) throw new Error(`Unity schema dependency checksum mismatch: ${path.basename(file)}`);
}

export async function prepareUnitySchemaTools(root) {
  const directory = path.join(root, 'local/dependencies/unity-schema');
  await mkdir(directory, { recursive: true });
  const sources = [];
  for (const [name, version, hash, folder, library] of packages) {
    const url = `https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`;
    const archive = path.join(directory, `${name}.${version}.nupkg`);
    await obtain(url, archive, hash);
    await extract(archive, { dir: path.join(directory, folder) });
    await copyFile(path.join(directory, folder, 'lib/net40', library), path.join(directory, library));
    sources.push({ name, version, url, sha256: hash, license: 'MIT' });
  }
  for (const [file, url, hash] of licenses) await obtain(url, path.join(directory, file), hash);
  await copyFile(path.join(directory, 'cecil/lib/net40/Mono.Cecil.Rocks.dll'), path.join(directory, 'Mono.Cecil.Rocks.dll'));
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await run(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${path.join(directory, 'Pinhao.UnitySchema.exe')}`,
    `/reference:${path.join(directory, 'AssetsTools.NET.dll')}`, `/reference:${path.join(directory, 'AssetsTools.NET.MonoCecil.dll')}`,
    `/reference:${path.join(directory, 'Mono.Cecil.dll')}`,
    '/reference:System.Web.Extensions.dll', path.join(root, 'adapters/python/unity_schema.cs')], { windowsHide: true });
  const files = {};
  for (const name of ['Pinhao.UnitySchema.exe', 'Mono.Cecil.Rocks.dll', ...packages.map(row => row[4]), ...licenses.map(row => row[0])]) {
    files[name] = sha256(await readFile(path.join(directory, name)));
  }
  const manifest = { name: 'Pinhao Mono Unity schema recovery', version: 1, license: 'GPL-3.0-or-later',
    dependencyLicense: 'MIT', backend: 'AssetsTools.NET.MonoCecil', sources, files };
  await writeFile(path.join(directory, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
