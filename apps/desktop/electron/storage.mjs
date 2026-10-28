import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';

export function desktopDataDirectory({ packaged, execPath, sourceRoot, override, smoke = false }) {
  if (override) return path.resolve(override);
  if (packaged) return path.join(path.dirname(execPath), 'data');
  return path.join(sourceRoot, 'local', smoke ? 'desktop-smoke-data' : 'product-data');
}

/** Configure Chromium before app readiness, without consulting an old system profile. */
export function configureDesktopStorage(app, directory) {
  const dataDir = path.resolve(directory), profileDir = path.join(dataDir, 'electron-profile');
  try {
    for (const target of [dataDir, profileDir]) {
      mkdirSync(target, { recursive: true });
      const probe = path.join(target, `.pinhao-write-${randomUUID()}`);
      const descriptor = openSync(probe, 'wx');
      try { closeSync(descriptor); } finally { unlinkSync(probe); }
    }
    app.setPath('userData', profileDir);
    app.setPath('sessionData', profileDir);
  } catch (cause) {
    throw Object.assign(new Error(`无法写入拼好数据文件夹：${dataDir}\n请将软件放到可写且空间充足的文件夹，或检查已指定的数据位置后重新打开。软件没有改用其他目录。`, { cause }),
      { code: 'PORTABLE_DATA_UNWRITABLE' });
  }
  return dataDir;
}

/** The host can offer another location before import, never after arbitrary task failures. */
export async function importWithWorkspaceSelection(operation, input, chooseWorkspaceParent) {
  try { return await operation(input); }
  catch (error) {
    if (error?.code !== 'WORKSPACE_LOCATION_REQUIRED') throw error;
    const workspaceParent = await chooseWorkspaceParent(error);
    if (!workspaceParent) throw error;
    return operation({ ...input, workspaceParent });
  }
}
