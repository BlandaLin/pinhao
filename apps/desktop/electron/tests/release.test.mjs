import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const helper = path.join(root, 'scripts/portable-release.py');
const python = process.env.PINHAO_PYTHON || path.join(root, 'local/runtime/python/python.exe');
const run = promisify(execFile);
const options = { windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };

test('portable release preserves source, licenses and runtime while selecting the release whitelist', async () => {
  const base = await mkdtemp(path.join(root, 'local/portable-release-test-'));
  const directory = path.join(base, 'PinhaoWorkbench-win32-x64');
  const archive = path.join(base, 'neutral-release.zip');
  const metadata = await run(python, ['-B', '-c', 'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["ROOT_FILES"]))', helper], options);
  const whitelist = JSON.parse(metadata.stdout);
  const resources = [
    'locales/en-US.pak', 'resources/app/main.mjs', 'resources/app/ui/index.html',
    'resources/app/resources/adapters/worker.py', 'resources/app/node_modules/sharp/package.json',
    'resources/app/THIRD_PARTY_LICENSES/font/OFL.txt',
  ];
  for (const relative of [...whitelist, ...resources, 'user-data/pinhao.sqlite', 'data/catalog.sqlite',
    'data/electron-profile/Preferences', 'logs/test.log', 'private-fixture.txt']) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'Neutral fixture; executable files are never run.');
  }
  await run(python, ['-B', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("README.txt","neutral source fixture"); z.close()', path.join(directory, 'SOURCE-CODE.zip')], options);
  const result = JSON.parse((await run(python, ['-B', helper, directory, archive], options)).stdout);
  const inspection = JSON.parse((await run(python, ['-B', '-c', 'import io,json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); source=zipfile.ZipFile(io.BytesIO(z.read("PinhaoWorkbench-win32-x64/SOURCE-CODE.zip"))); print(json.dumps({"names":z.namelist(),"bad":z.testzip(),"source":source.namelist()}))', archive], options)).stdout);
  assert.equal(result.files, whitelist.length + resources.length);
  assert.deepEqual(inspection.names.sort(), [...whitelist, ...resources].map(file => `PinhaoWorkbench-win32-x64/${file}`).sort());
  assert.equal(inspection.bad, null);
  assert.deepEqual(inspection.source, ['README.txt']);
  await assert.rejects(run(python, ['-B', helper, directory, path.join(directory, 'nested.zip')], options), /发行目录与压缩包路径需要分开/);
  await assert.rejects(run(python, ['-B', helper, directory, archive], options), /FileExistsError/);
});
