import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const gameExtensions = new Set(['.exe', '.rgssad', '.rgss2a', '.rgss3a', '.rpgproject', '.rmmzproject', '.rvproj', '.rvproj2', '.rxproj', '.ldb', '.lmt']);

/** Resolve a user-selected entry without starting it or changing the game. */
export async function resolveGameImport(input, readShortcut) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请拖入游戏文件夹或启动程序');
  let target = await realpath(input);
  let metadata = await stat(target);
  if (metadata.isFile() && path.extname(target).toLowerCase() === '.lnk' && readShortcut) {
    const shortcut = await readShortcut(target);
    if (!shortcut?.target) throw new Error('此快捷方式的游戏目标为空，请拖入游戏启动程序');
    target = await realpath(shortcut.target);
    metadata = await stat(target);
  }
  if (metadata.isDirectory()) return { gameDir: target };
  if (!metadata.isFile()) throw new Error('请拖入游戏文件夹或启动程序');
  const extension = path.extname(target).toLowerCase();
  if (['.zip', '.7z', '.rar'].includes(extension)) throw new Error('请先解压游戏，再拖入游戏文件夹或启动程序');
  if (!gameExtensions.has(extension)) throw new Error('请拖入游戏文件夹、启动程序或 RPG Maker 工程文件');
  return { gameDir: path.dirname(target) };
}
