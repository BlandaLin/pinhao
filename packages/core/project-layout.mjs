import path from 'node:path';
import { lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';

export const PROJECT_LAYOUT = 'pinhao-project-2';
const markerName = 'pinhao-project.json';
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export const projectFileName = name => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim() || '游戏';

export function workspaceLocationError(directory, cause) {
  return Object.assign(new Error(`无法在“${directory}”创建工程，请选择有写入权限和足够空间的工作位置。${cause?.code === 'ENOSPC' ? ' 当前磁盘空间不足。' : ''}`, { cause }),
    { code: 'WORKSPACE_LOCATION_REQUIRED', directory, reason: cause?.code });
}

/** A new project claims its own directory; existing games and older projects are never adopted. */
export async function createProjectWorkspace({ id, gameDir, workspaceParent }) {
  const source = await realpath(gameDir), requested = path.resolve(workspaceParent ?? path.dirname(source));
  let parent;
  try {
    parent = await realpath(requested);
    if (within(source, parent)) throw new Error('工程目录必须位于原游戏之外');
    for (let number = 1; number <= 10000; number++) {
      const suffix = number === 1 ? '' : ` (${number})`;
      const directory = path.join(parent, `${projectFileName(path.basename(source))}-拼好工程${suffix}`);
      try { await mkdir(directory); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      await writeFile(path.join(directory, markerName), JSON.stringify({ format: PROJECT_LAYOUT, id, gameDir: source }, null, 2), { flag: 'wx' });
      return directory;
    }
    throw new Error('同名工程目录过多，请选择其他工作位置');
  } catch (error) { throw workspaceLocationError(requested, error); }
}

export async function ownsProjectWorkspace(project) {
  try {
    const directory = await realpath(project.workspaceDir), game = await realpath(project.gameDir);
    if (within(game, directory)) return false;
    const marker = JSON.parse(await readFile(path.join(directory, markerName), 'utf8'));
    return marker.format === PROJECT_LAYOUT && marker.id === project.id && path.resolve(marker.gameDir) === game;
  } catch { return false; }
}

export async function readProjectWorkspace(workspaceDir) {
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) throw new Error('请选择现有工程目录');
  const directory = await realpath(workspaceDir);
  const marker = JSON.parse(await readFile(path.join(directory, markerName), 'utf8'));
  if (marker.format !== PROJECT_LAYOUT || typeof marker.id !== 'string' || !marker.id || typeof marker.gameDir !== 'string') throw new Error('只能重新连接当前版本创建的工程目录');
  const gameDir = await realpath(marker.gameDir).catch(cause => { throw new Error('原游戏目录无法访问，请先放回原路径或重新连接磁盘', { cause }); });
  if (!(await stat(gameDir)).isDirectory() || within(gameDir, directory)) throw new Error('工程目录必须位于仍可访问的原游戏目录之外');
  return { id: marker.id, workspaceDir: directory, gameDir };
}

const productReservation = directory => path.join(path.dirname(directory), `.${path.basename(directory)}.pinhao-reservation`);

/** Reserve a name without creating the output: native assemblers require a fresh directory. */
export async function createProductDirectory(project, parentDirectory) {
  const parent = await realpath(parentDirectory ?? project.outputDir ?? path.dirname(project.workspaceDir));
  if (within(await realpath(project.gameDir), parent)) throw new Error('成品必须生成在原游戏目录之外');
  const base = `${projectFileName(project.name)}-汉化版`;
  for (let number = 1; number <= 10000; number++) {
    const directory = path.join(parent, `${base}${number === 1 ? '' : ` (${number})`}`);
    const reservation = productReservation(directory);
    try { await writeFile(reservation, project.id, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return directory;
      await unlink(reservation).catch(() => {}); throw error;
    }
    await unlink(reservation);
  }
  throw new Error('同名成品目录过多，请选择其他输出位置');
}

export async function releaseProductDirectory(directory, projectId) {
  const reservation = productReservation(directory);
  try { if (await readFile(reservation, 'utf8') === projectId) await unlink(reservation); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

