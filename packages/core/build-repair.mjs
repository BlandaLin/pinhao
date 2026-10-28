import { mkdir, lstat, realpath, rename } from 'node:fs/promises';
import path from 'node:path';

const within = (root, value) => {
  const relative = path.relative(root, value);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Retain generated failure evidence by moving it, without making another game copy. */
export async function retainBuildArtifacts({ workspaceDir, attemptId, buildDir, outputDir, outputOwner, retainOutput }) {
  const root = path.resolve(workspaceDir);
  const destination = path.join(root, 'technical', 'build-repairs', 'artifacts', attemptId);
  if (!within(root, destination)) throw new Error('构建诊断目录定位无效');
  await mkdir(destination, { recursive: true });
  const actualRoot = await realpath(root);
  if (!within(actualRoot, await realpath(destination))) throw new Error('构建诊断目录包含链接');
  const artifacts = [];
  for (const [id, source, owner] of [['build', path.dirname(buildDir), path.join(root, 'builds')],
    ...(retainOutput ? [['output', outputDir, outputOwner ?? path.join(root, 'outputs')]] : [])]) {
    const resolved = path.resolve(source);
    if (!within(owner, resolved)) throw new Error('构建工件需要位于当前项目的生成目录');
    let info;
    try { info = await lstat(resolved); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const actualOwner = await realpath(owner);
    if ((id !== 'output' || !outputOwner) && !within(actualRoot, actualOwner)
        || !info.isDirectory() || info.isSymbolicLink() || !within(actualOwner, await realpath(resolved))) throw new Error('构建工件目录包含链接');
    const target = path.join(destination, id);
    try { await rename(resolved, target); }
    catch (error) {
      // Do not copy a whole failed product across disks just to retain diagnostics.
      if (id === 'output' && error.code === 'EXDEV') continue;
      throw error;
    }
    artifacts.push({ id, path: target, originalPath: resolved });
  }
  return { directory: destination, artifacts };
}
