import policy from '../../adapters/python/private-paths.json' with { type: 'json' };

const names = new Set(policy.directoryNames.map(value => value.toLowerCase()));
const roots = new Set(policy.rootDirectories.map(value => value.toLowerCase()));
const paths = policy.directoryPaths.map(value => value.toLowerCase());
const files = new Set(policy.files.map(value => value.toLowerCase()));
const fileNamePatterns = policy.fileNamePatterns.map(value => new RegExp(value, 'i'));

/** Shared with the native worker; authored cache/image folders remain game resources. */
export function isPrivateGamePath(relative, { directory = false } = {}) {
  const parts = relative.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  if (!parts.length) return false;
  const directories = directory ? parts : parts.slice(0, -1);
  if (directories.some(value => names.has(value)) || roots.has(directories[0])) return true;
  const joined = directories.join('/');
  if (paths.some(value => joined === value || joined.startsWith(`${value}/`))) return true;
  if (directory) return false;
  const name = parts.at(-1);
  return files.has(name) || policy.extensions.some(value => name.endsWith(value))
    || policy.prefixes.some(value => name.startsWith(value)) || policy.suffixes.some(value => name.endsWith(value))
    || fileNamePatterns.some(pattern => pattern.test(name));
}
