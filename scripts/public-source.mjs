import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const rootFiles = new Set(['.gitignore', 'COPYING', 'LICENSE', 'README.md', 'README.en.md', 'package.json', 'package-lock.json']);
const publicRoots = new Set(['adapters', 'apps', 'docs', 'kits', 'packages', 'scripts', 'tools', '.github']);
const privateFiles = new Set(['docs/product/FEEDBACK.md', 'scripts/consolidate_legacy.py', 'scripts/index_cases.py', 'scripts/verify_project.py']);
const privateDirectories = new Set(['local', 'games', 'work', 'artifacts', 'toolchains', 'node_modules', 'dist', 'dist-host', 'release', 'releases', '__pycache__', '.git', '.codex', '.agents', '.venv']);
const sourceExtensions = new Set(['.md', '.mjs', '.cjs', '.py', '.rb', '.cs', '.gd', '.tjs', '.json', '.txt', '.js', '.ts', '.tsx', '.css', '.html', '.rpy', '.ks', '.edb', '.emu', '.ico', '.png', '.svg', '.webp', '.yml', '.yaml']);

export function isPublicSourcePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.posix.isAbsolute(relative)) return false;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || parts.some(part => privateDirectories.has(part.toLowerCase()))) return false;
  if (rootFiles.has(relative)) return true;
  if (parts[0] === 'tests') return parts[1] === 'evals' && parts[2] === 'technical' && parts.length >= 4 && (path.posix.extname(parts.at(-1)) === '.mjs' || relative === 'tests/evals/technical/README.md');
  if (!publicRoots.has(parts[0]) || privateFiles.has(relative) || parts.length < 2) return false;
  const name = parts.at(-1);
  if (name.startsWith('.env') && name !== '.env.example') return false;
  if (name === '.gitignore' || name === 'LICENSE' || name === 'COPYING' || name === '.env.example') return true;
  return sourceExtensions.has(path.posix.extname(name).toLowerCase());
}

export function sourcePrivacyFindings(raw) {
  const findings = new Set();
  const utf16be = Buffer.from(raw.subarray(0, raw.length - raw.length % 2)).swap16();
  for (const text of [raw.toString('utf8'), raw.toString('utf16le'), utf16be.toString('utf16le')]) {
    const normalized = text.replace(/\\+/g, '/');
    if (/(?:[a-z]:\/Users|\/Users|\/home)\/[^/\s]+\//i.test(normalized)) findings.add('personal-profile-path');
    if (/\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAIza[0-9A-Za-z_-]{25,}\b/.test(text)) findings.add('credential-token');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.add('private-key');
    if (/https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text)) findings.add('credential-url');
  }
  return [...findings];
}

export async function validatePublicSourceFiles(root, candidates) {
  const sourceRoot = path.resolve(root);
  const files = [...new Set(candidates.filter(isPublicSourcePath))].sort();
  const findings = [];
  const checkedDirectories = new Set();
  for (const relative of files) {
    const file = path.join(sourceRoot, ...relative.split('/'));
    let current = file;
    while (current !== sourceRoot && !checkedDirectories.has(current)) {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Public source must use ordinary files and directories: ${relative}`);
      if (current !== file) checkedDirectories.add(current);
      current = path.dirname(current);
    }
    if (!(await lstat(file)).isFile()) throw new Error(`Public source entry must be a file: ${relative}`);
    for (const category of sourcePrivacyFindings(await readFile(file))) findings.push({ path: relative, category });
  }
  if (findings.length) throw new Error(`Public source privacy check failed: ${JSON.stringify(findings)}`);
  return { files, excluded: [...new Set(candidates)].filter(file => !isPublicSourcePath(file)).sort() };
}

export async function collectPublicSourceFiles(root) {
  const listing = await run('git', ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const deleted = await run('git', ['-c', 'core.quotePath=false', 'ls-files', '--deleted', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const removed = new Set(deleted.stdout.split('\0').filter(Boolean));
  return validatePublicSourceFiles(root, listing.stdout.split('\0').filter(file => file && !removed.has(file)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collectPublicSourceFiles(fileURLToPath(new URL('../', import.meta.url)));
  if (result.excluded.length) throw new Error(`Git source listing contains entries outside the public boundary: ${JSON.stringify(result.excluded)}`);
  console.log(JSON.stringify({ publicFiles: result.files.length, excludedFiles: result.excluded.length, privacyIssues: [] }));
}
