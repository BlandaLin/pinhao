import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

/** Only a stage newly created by this invocation may be collected. */
export async function cleanupDesktopStage({ stageRoot, stage, createdByThisRun = false }) {
  if (!createdByThisRun) throw new Error('Refusing to remove an unowned desktop stage');
  const expectedRoot = path.resolve(stageRoot), expectedStage = path.resolve(stage);
  if (path.dirname(expectedStage) !== expectedRoot) throw new Error('Desktop stage must be an immediate child of its staging root');
  const info = await lstat(expectedStage);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Desktop stage must be an ordinary directory');
  const [canonicalRoot, canonicalStage] = await Promise.all([realpath(expectedRoot), realpath(expectedStage)]);
  if (path.dirname(canonicalStage) !== canonicalRoot || path.basename(canonicalStage) !== path.basename(expectedStage)) {
    throw new Error('Desktop stage resolved outside its expected staging directory');
  }
  await rm(canonicalStage, { recursive: true });
}
