import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '@electron-internal/extract-zip';
import { prepareUnitySchemaTools } from './prepare-unity-schema.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const digest = data => createHash('sha256').update(data).digest('hex');
export const unityPackages = [
  ['UnityPy', '1.23.0', 'unitypy-1.23.0-cp312-cp312-win_amd64.whl', 'f4bf06fe72d7220a8bb26fe5a7ad6e206c5cfbe51ed2915c141bb98fa35197bd'],
  ['lz4', '4.4.5', 'lz4-4.4.5-cp312-cp312-win_amd64.whl', '713a777de88a73425cf08eb11f742cd2c98628e79a8673d6a52e3c5f0c116f33'],
  ['brotli', '1.2.0', 'brotli-1.2.0-cp312-cp312-win_amd64.whl', 'b35c13ce241abdd44cb8ca70683f20c0c079728a36a996297adb5334adfc1c44'],
  ['Pillow', '13.0.0', 'pillow-13.0.0-cp312-cp312-win_amd64.whl', 'ff3fe9eb621fbb9db4c4be33ab946f6bac5f98ab50ca8d3260503653656c961b'],
  ['texture2ddecoder', '1.0.6', 'texture2ddecoder-1.0.6-cp311-abi3-win_amd64.whl', '1bad8209d9dfbfc7daf13ea2e545236ea2bbc1e423b2992b6e7563909975a47b'],
  ['etcpak', '0.9.15', 'etcpak-0.9.15-cp37-abi3-win_amd64.whl', '669d902eeb774bc6d4df226183c09c3d03c9fc0f47b4c0c20030fc2b39eec2f2'],
  ['astc-encoder-py', '0.1.12', 'astc_encoder_py-0.1.12-cp37-abi3-win_amd64.whl', 'a45d375fc6b0ff2cd3d772aab3eef19a6b7f3e067306e11fab37820ea9576121'],
  ['pyfmodex', '0.7.2', 'pyfmodex-0.7.2-py3-none-any.whl', '1c42112b788e80ee7b4b57ae25bbbc0a98eb1e32a8e7c9e1246698cdf72efa9d'],
  ['fsspec', '2026.9.0', 'fsspec-2026.9.0-py3-none-any.whl', '8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f'],
  ['attrs', '26.1.0', 'attrs-26.1.0-py3-none-any.whl', 'c647aa4a12dfbad9333ca4e71fe62ddc36f4e63b2d260a37a8b83d2f043ac309'],
  ['archspec', '0.2.6', 'archspec-0.2.6-py3-none-any.whl', '22463371fe8e9fa92fa144bf320cb445373a99f2ca6a5914c890e0c0b7816f8f'],
];

export function includeUnityRuntimePath(relative) {
  const normalized = relative.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  return !/^bin(?:\/|$)/i.test(normalized)
    && !/^(?:TypeTreeGeneratorAPI|typetreegeneratorapi-[^/]+\.dist-info)(?:\/|$)/i.test(normalized)
    && !/(?:^|\/)__pycache__(?:\/|$)|\.py[co]$/i.test(normalized);
}

async function download(url, file) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await run('curl.exe', ['--location', '--fail', '--silent', '--show-error', '--ssl-revoke-best-effort', '--max-time', '240', '--output', file, url], { windowsHide: true, timeout: 260_000 });
  }
}

export async function prepareUnityTools(directory = root) {
  const wheels = path.join(directory, 'local/dependencies/unitypy-wheels');
  const target = path.join(directory, 'local/dependencies/unitypy');
  await mkdir(wheels, { recursive: true });
  await mkdir(target, { recursive: true });
  const resources = [];
  for (const [name, version, file, sha256] of unityPackages) {
    const wheel = path.join(wheels, file);
    let bytes;
    try { bytes = await readFile(wheel); } catch { /* Obtain the fixed official artifact. */ }
    if (!bytes) {
      const metadata = path.join(wheels, `${name}-${version}.json`);
      await download(`https://pypi.org/pypi/${name}/${version}/json`, metadata);
      const entry = JSON.parse(await readFile(metadata, 'utf8')).urls.find(entry => entry.filename === file);
      if (!entry || entry.digests.sha256 !== sha256 || !entry.url.startsWith('https://files.pythonhosted.org/')) {
        throw new Error(`Unity dependency metadata differs from the reviewed artifact: ${file}`);
      }
      await download(entry.url, wheel);
      bytes = await readFile(wheel);
    }
    if (digest(bytes) !== sha256) throw new Error(`Unity dependency SHA-256 mismatch: ${file}`);
    await extract(wheel, { dir: target });
    resources.push({ name, version, file, sha256, source: `https://pypi.org/project/${name}/${version}/` });
  }
  // Asset editing uses neither audio decoders nor pip-generated command launchers.
  const excluded = ['UnityPy/lib/FMOD/Windows/x64/fmod.dll', 'UnityPy/lib/FMOD/Windows/x86/fmod.dll', 'bin/archspec.exe'];
  for (const file of excluded) await rm(path.join(target, file), { force: true });
  await access(path.join(target, 'unitypy-1.23.0.dist-info/licenses/LICENSE'));
  const manifest = { name: 'UnityPy native asset tools', version: '1.23.0', platform: 'CPython 3.12 Windows x64',
    directory: 'local/dependencies/unitypy', license: 'MIT; dependency licenses retained in each .dist-info directory',
    source: 'https://github.com/K0lb3/UnityPy', excluded, resources,
    schemaRecovery: await prepareUnitySchemaTools(directory) };
  await writeFile(path.join(target, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareUnityTools(), null, 2));
}
