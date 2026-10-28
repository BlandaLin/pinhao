import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const mutableDirectory = /^(?:(?:saves?|save_mtool|savedata|savegames?)|www\/save|game\/saves|\.pinhao-assist)$/i;
const mutableFile = /\.(?:log|rpgsave|rmmzsave|lsd|sav|save|dmp)$|^(?:save|file)\d+\.(?:rxdata|rvdata|rvdata2|dat)$|^(?:pinhao-assist-session\.json|pinhao-assist-state\.json)$/i;

export async function outputManifest(directory) {
  const files = [];
  const visit = async (folder, prefix = '') => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory() && mutableDirectory.test(relative) || entry.isFile() && mutableFile.test(entry.name)) continue;
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('成品文件包含链接，请生成新的独立副本');
      if (info.isDirectory()) await visit(file, `${relative}/`);
      else if (info.isFile()) {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        files.push({ path: relative, size: info.size, sha256: digest.digest('hex') });
      } else throw new Error('成品包含特殊文件，请生成新的独立副本');
    }
  };
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('请选择独立成品目录');
  await visit(directory);
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { version: 1, hash, files };
}

export async function verifyOutput(directory, expected) {
  if (!expected?.hash) return { valid: false, reason: '成品将补充内容核验后重新生成' };
  try {
    const actual = await outputManifest(directory);
    return { valid: actual.hash === expected.hash, actual, ...(actual.hash !== expected.hash ? { reason: '成品文件已有修改，原副本保留，可重新生成成品' } : {}) };
  } catch (error) { return { valid: false, reason: error.message }; }
}
