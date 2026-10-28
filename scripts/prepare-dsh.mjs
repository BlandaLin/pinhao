import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
export const DSH_COMMIT = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'local/upstream/deepseek-harness');
const execute = async (program, args, cwd) => {
  const result = await run(program, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
};

/** Prepare the exact upstream, not a registry package sharing its version label. */
export async function prepareDsh({ build = false } = {}) {
  try { await access(path.join(directory, '.git/HEAD')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(directory), { recursive: true });
    await execute('git', ['clone', '--no-checkout', '--filter=blob:none', 'https://github.com/deepseek-ai/deepseek-harness.git', directory], root);
    await execute('git', ['checkout', '--detach', DSH_COMMIT], directory);
  }
  const head = await execute('git', ['rev-parse', 'HEAD'], directory);
  if (head !== DSH_COMMIT) throw new Error('Existing DSH checkout has a different revision; preserve it and select the expected source explicitly.');
  const changed = await execute('git', ['diff', '--name-only', 'HEAD'], directory);
  if (changed) throw new Error('Fixed DSH source has local edits; refusing to treat it as the pinned runtime.');
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.packageManager !== 'pnpm@11.28.5') throw new Error('Unexpected upstream dependency manager');
  const args = ['--yes', metadata.packageManager, '--filter', '*',
    '--filter', '!@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    'install', '--frozen-lockfile', '--ignore-scripts', '--reporter=append-only'];
  // These are fixed developer setup arguments, not model-supplied shell text.
  if (process.platform === 'win32') await execute('cmd.exe', ['/d', '/s', '/c', ['npx', ...args].join(' ')], directory);
  else await execute('npx', args, directory);
  if (build) {
    const compile = ['--yes', metadata.packageManager, 'exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'host-libraries'];
    if (process.platform === 'win32') await execute('cmd.exe', ['/d', '/s', '/c', ['npx', ...compile].join(' ')], directory);
    else await execute('npx', compile, directory);
  }
  return { directory, commit: head, upstreamVersion: metadata.version, packageManager: metadata.packageManager, built: build };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareDsh({ build: process.argv.includes('--build') })));
