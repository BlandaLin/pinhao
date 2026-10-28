import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const hash = value => value === null ? null : createHash('sha256').update(value).digest('hex');
async function bytes(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function commitAssistFiles(entries, { replace = rename, createDirectory = mkdtemp } = {}) {
  const records = [];
  let recoveryDirectory;
  async function receipt(state) {
    if (!recoveryDirectory) return;
    await writeFile(path.join(recoveryDirectory, 'receipt.json'), JSON.stringify({ schema: 'pinhao-assist-rollback-1', state,
      files: records.map((record, index) => ({ file: record.file, backup: record.before === null ? null : String(index), before: hash(record.before), after: hash(record.after) })) }));
  }
  async function atomic(file, content) {
    const temporary = path.join(path.dirname(file), `.pinhao-assist-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await replace(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  try {
    recoveryDirectory = await createDirectory(path.join(os.tmpdir(), 'pinhao-assist-recovery-'));
    for (const { file, content, expected } of entries) {
      const before = await bytes(file);
      if (expected !== undefined && hash(before) !== hash(expected)) throw new Error('辅助安装文件已在其他地方更改，请保留成品并重新检查');
      records.push({ file, before, after: Buffer.from(content) });
      if (before !== null) await writeFile(path.join(recoveryDirectory, String(records.length - 1)), before, { flag: 'wx' });
      await receipt('installing');
      await mkdir(path.dirname(file), { recursive: true });
      await atomic(file, content);
      if (hash(await bytes(file)) !== hash(content)) throw new Error('辅助安装文件读回不一致');
    }
    if (recoveryDirectory) await rm(recoveryDirectory, { recursive: true, force: true });
    return { status: 'installed' };
  } catch (error) {
    try {
      for (const record of records.toReversed()) {
        const current = hash(await bytes(record.file));
        if (![hash(record.before), hash(record.after)].includes(current)) throw new Error('辅助安装文件被其他程序更改');
        if (current !== hash(record.before)) {
          if (record.before === null) await unlink(record.file);
          else await atomic(record.file, record.before);
        }
        if (hash(await bytes(record.file)) !== hash(record.before)) throw new Error('辅助安装恢复读回不一致');
      }
    } catch (cause) {
      throw Object.assign(new Error(`游玩辅助安装未完成，文件恢复尚未确认。请保留当前成品及恢复记录：${recoveryDirectory}`, { cause }),
        { code: 'ASSIST_INSTALL_RECOVERY_REQUIRED', hostFailure: true, recoveryDirectory });
    }
    await receipt('restored');
    if (recoveryDirectory) await rm(recoveryDirectory, { recursive: true, force: true });
    return { supported: false, status: 'install_failed', restored: true,
      detail: '游玩辅助安装未完成，本次触及的文件已恢复并核对；可不启用辅助继续游玩。',
      installationError: { code: error.code || 'ASSIST_INSTALL_FAILED', message: error.message },
      recovery: { schema: 'pinhao-assist-rollback-1', state: 'restored', files: records.map(record => ({ file: record.file, before: hash(record.before) })) } };
  }
}
