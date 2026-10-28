import { access, readFile, writeFile, unlink, mkdir, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';

export const sessionFileName = 'PinHao-assist-session.json';

export async function clearAssistSession(outputDir) {
  const roots = [outputDir];
  try { await access(path.join(outputDir, 'www/index.html')); roots.push(path.join(outputDir, 'www')); } catch {}
  for (const root of roots) {
    const file = path.join(root, sessionFileName);
    try {
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (previous.schema !== 'pinhao-assist-session-v1') throw new Error('游玩辅助会话文件与已有文件重名，请检查成品目录');
      await unlink(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) throw new Error('辅助会话文件无法读取，请保留并检查成品目录中的 PinHao-assist-session.json 后重试');
      throw error;
    }
  }
}

export async function writeAssistSession(outputDir, environment) {
  if (!environment.PINHAO_ASSIST_DIR || !environment.PINHAO_ASSIST_TOKEN) return async () => {};
  const value = JSON.stringify({ schema: 'pinhao-assist-session-v1', directory: environment.PINHAO_ASSIST_DIR,
    token: environment.PINHAO_ASSIST_TOKEN, backupDir: environment.PINHAO_ASSIST_BACKUP_DIR || '' })
    // Older KAG readers use the system code page before parsing JSON.
    .replace(/[\u0080-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const roots = [outputDir];
  try { await access(path.join(outputDir, 'www/index.html')); roots.push(path.join(outputDir, 'www')); } catch {}
  const written = [];
  async function cleanup() {
    for (const file of written) {
      try { if (await readFile(file, 'utf8') === value) await unlink(file); } catch {}
    }
  }
  try {
    for (const root of roots) {
      const file = path.join(root, sessionFileName);
      try {
        const previous = JSON.parse(await readFile(file, 'utf8'));
        if (previous.schema !== 'pinhao-assist-session-v1') throw new Error('游玩辅助会话文件与已有文件重名，请检查成品目录');
        await unlink(file);
      } catch (error) {
        if (error instanceof SyntaxError) {
          const directory = path.resolve(environment.PINHAO_ASSIST_BACKUP_DIR || environment.PINHAO_ASSIST_DIR);
          const relative = path.relative(path.resolve(outputDir), directory);
          if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('请选择工作台数据目录保存辅助会话备份');
          await mkdir(directory, { recursive: true });
          await copyFile(file, path.join(directory, `session-recovered-${randomUUID()}.json`), constants.COPYFILE_EXCL);
          await unlink(file);
        } else if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(file, value, { flag: 'wx' });
      written.push(file);
    }
  } catch (error) { await cleanup(); throw error; }
  return cleanup;
}
