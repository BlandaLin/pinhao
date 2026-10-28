import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_LAYOUT, projectFileName } from './project-layout.mjs';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const saveDirectory = /^(?:saves?|save_mtool|savedata|savegames?|www[\\/]save)$/i;
const saveFile = /\.(?:rpgsave|rmmzsave|rvdata2save|rxsave|rvsave|lsd|sav|save)$|^(?:save|file)\d+\.(?:rxdata|rvdata|rvdata2|dat)$/i;
// Only executables can be held open by a running game in a way that matters here; probing every
// asset with an r+ open costs a Defender scan per file (seconds per thousand) for no benefit.
const executableFile = /\.(?:exe|dll|so|dylib|node)$/i;

// Only generated directories are eligible; links and gameplay saves stay intact.
export async function removeArtifact(directory, owner, { protectSaves = false } = {}) {
  directory = path.resolve(directory);
  owner = path.resolve(owner);
  if (!inside(owner, directory)) throw new Error('清理目标必须位于所属输出目录中');
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return { removed: true, bytes: 0 }; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) return { removed: false, bytes: 0 };
  for (let parent = owner; ; parent = path.dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) return { removed: false, bytes: 0 };
    if (path.dirname(parent) === parent) break;
  }
  const actualOwner = await realpath(owner);
  if (!inside(actualOwner, await realpath(directory))) return { removed: false, bytes: 0 };
  let bytes = 0, protectedEntry = false;
  async function inspect(folder) {
    let names;
    try { names = await readdir(folder); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      const entry = path.join(folder, name);
      let entryInfo;
      try { entryInfo = await lstat(entry); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // Symlinks are refused outright. The tree is already proven to live inside the owner by the
      // single realpath above, so a per-entry realpath would only add a Windows path walk per file.
      if (entryInfo.isSymbolicLink()) { protectedEntry = true; continue; }
      if (protectSaves && (saveDirectory.test(name) || saveFile.test(name))) { protectedEntry = true; continue; }
      if (entryInfo.isDirectory()) await inspect(entry);
      else if (entryInfo.isFile()) {
        if (protectSaves && executableFile.test(name)) {
          // A loaded executable is the only thing Windows refuses to delete; probe just those.
          try { const handle = await open(entry, 'r+'); await handle.close(); }
          catch { protectedEntry = true; }
        }
        bytes += entryInfo.size;
      }
      else protectedEntry = true;
    }
  }
  await inspect(directory);
  if (protectedEntry) return { removed: false, bytes: 0 };
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    // Best effort: a file still held open leaves the directory behind instead of failing the delete.
    return { removed: false, bytes: 0, code: error.code };
  }
  return { removed: true, bytes };
}

export function managedBuildOwner(project, build) {
  const output = path.resolve(build.path);
  if (project.storageLayout === PROJECT_LAYOUT && build.managedOwner) {
    const owner = path.resolve(build.managedOwner);
    const name = path.basename(output), prefix = `${projectFileName(project.name)}-汉化版`;
    if (path.dirname(output) === owner
        && (name === prefix || name.startsWith(`${prefix} (`) && /^\d+\)$/.test(name.slice(prefix.length + 2)))) return owner;
    return null;
  }
  const internal = path.join(project.workspaceDir, 'outputs');
  if (output === path.resolve(internal, build.id)) return internal;
  if (project.outputDir && output === path.resolve(project.outputDir, `${project.name}-${build.id.slice(0, 8)}`)) return path.resolve(project.outputDir);
  return null;
}
