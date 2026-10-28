import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, file);
}

function catalogueIdentity(scan) {
  return { fingerprint: scan.fingerprint, analysisRulesVersion: scan.analysisRulesVersion,
    candidates: scan.candidates.map(({ confidence, selected, ...candidate }) => candidate),
    recipes: scan.recipes.map(({ confidence, ...recipe }) => recipe) };
}
function compatibleScan(left, right) {
  return Boolean(left?.analysisRulesVersion && left.analysisRulesVersion === right?.analysisRulesVersion &&
    isDeepStrictEqual(catalogueIdentity(left), catalogueIdentity(right)));
}
const pendingCandidates = scan => scan.candidates.filter(candidate => candidate.selectable !== false && candidate.confidence !== 'confirmed');

export function createRecollectionManager({ projectFor, worker, connectionFor, onChanged, tools, diagnostics = false }) {
  const scans = new Map();
  const controllers = new Map();
  const paths = project => ({ scan: path.join(project.workspaceDir, 'assist', 'scan.json'), backups: path.join(project.workspaceDir, 'assist', 'backups.json') });
  const loadTools = async () => tools ?? import('../technical/recollection.mjs');
  function source(project) {
    const build = project.builds?.at(-1);
    return { rootDir: build?.path ?? project.gameDir, buildId: build?.id ?? null };
  }
  async function saved(project) {
    return readJson(paths(project).scan, null);
  }
  async function current(project, binding, signal) {
    const scanner = await loadTools();
    return scanner.scanRecollection({ gameDir: binding.rootDir, engine: project.engine, worker: (command, input) => worker(command, { ...input, projectId: project.id }, signal), signal });
  }
  return {
    cancel(projectId) { controllers.get(projectId)?.abort(); },
    close() { for (const controller of controllers.values()) controller.abort(); },
    async get({ projectId }) {
      const project = await projectFor(projectId);
      const value = await saved(project);
      return { scan: value?.scan ?? null, backups: await readJson(paths(project).backups, []) };
    },
    async scan({ projectId, analyze = false }) {
      if (scans.has(projectId)) throw new Error('正在扫描此项目的回想条件');
      const controller = new AbortController();
      controllers.set(projectId, controller);
      const pending = (async () => {
        const project = await projectFor(projectId);
        const binding = source(project);
        const previous = await saved(project);
        const observation = await current(project, binding, controller.signal);
        let confirmation = previous?.confirmation ?? (previous?.scan?.analysis ? { rootDir: previous.rootDir, buildId: previous.buildId, scan: previous.scan } : null);
        const reusable = confirmation?.rootDir === binding.rootDir && confirmation?.buildId === binding.buildId && compatibleScan(confirmation.scan, observation);
        let scan = reusable ? (await loadTools()).applySelection(observation, confirmation.scan.analysis) : observation;
        const history = previous?.history ?? [];
        controller.signal.throwIfAborted();
        if (!pendingCandidates(scan).length) {
          scan = { ...scan, analysisNotice: scan.candidates.length ? '没有可供本轮审核的候选：已有确认可直接使用，其余条件仍被阻塞。' : '没有可供本轮审核的候选：本轮未提取到可审核条件。' };
        }
        await saveJson(paths(project).scan, { ...binding, observation, scan, confirmation, history });
        onChanged();
        if (analyze && pendingCandidates(scan).length) {
          const scanner = await loadTools();
          const connection = await connectionFor();
          let analysis = await scanner.analyzeRecollection({ scan, connection, signal: controller.signal, diagnostics,
            artifactDir: path.join(project.workspaceDir, 'requests', 'recollection') });
          if (reusable) analysis = { ...analysis, selectedCandidateIds: [...new Set([...confirmation.scan.analysis.selectedCandidateIds, ...analysis.selectedCandidateIds])] };
          scan = scanner.applySelection(scan, analysis);
          controller.signal.throwIfAborted();
          if (confirmation && !reusable) history.push(confirmation);
          confirmation = { ...binding, observation, scan };
          await saveJson(paths(project).scan, { ...binding, observation, scan, confirmation, history });
          onChanged();
        }
        controller.signal.throwIfAborted();
        return scan;
      })();
      scans.set(projectId, pending);
      try { return await pending; }
      finally { scans.delete(projectId); controllers.delete(projectId); }
    },
    async selection({ projectId, recipeIds, buildId }) {
      const project = await projectFor(projectId);
      if (!Array.isArray(recipeIds) || !recipeIds.length || recipeIds.length > 2000 || new Set(recipeIds).size !== recipeIds.length) throw new Error('请选择需要解锁的回想条目');
      const value = await saved(project);
      if (!value) throw new Error('请先扫描回想条件');
      const binding = source(project);
      if (!binding.buildId || binding.buildId !== value.buildId || (buildId && buildId !== binding.buildId)) throw new Error('请启动扫描所用的最新成品，并重新扫描回想条件');
      const fresh = await current(project, binding);
      if (fresh.fingerprint !== value.scan.fingerprint) throw new Error('游戏资源已变化，请重新扫描回想条件');
      if (!compatibleScan(value.scan, fresh)) throw new Error('回想规则或候选条件已变化，请重新扫描并确认');
      const recipes = recipeIds.map(id => value.scan.recipes.find(recipe => recipe.id === id));
      if (recipes.some(recipe => !recipe || recipe.confidence !== 'confirmed')) throw new Error('所选条目需要先完成技术分析');
      const selected = new Map(value.scan.candidates.map(candidate => [candidate.id, candidate]));
      const operations = new Map();
      for (const recipe of recipes) for (const id of recipe.candidateIds) {
        const candidate = selected.get(id);
        if (!candidate || candidate.confidence !== 'confirmed') throw new Error('回想方案包含未确认条件，请重新扫描');
        const operation = candidate.operation.type === 'variable' ? { ...candidate.operation, mode: candidate.operation.mode ?? 'set' } : candidate.operation;
        const key = operation.type === 'selfSwitch' ? `${operation.type}:${operation.mapId}:${operation.eventId}:${operation.key}` : operation.type === 'recollectionMode' ? `${operation.type}:${JSON.stringify(operation.switchIds)}` : `${operation.type}:${operation.id}`;
        const previous = operations.get(key);
        if (previous && !isDeepStrictEqual(previous, operation)) {
          if (operation.type === 'variable' && previous.mode === operation.mode && ['min', 'max'].includes(operation.mode)) {
            operations.set(key, { ...operation, value: Math[operation.mode === 'min' ? 'max' : 'min'](previous.value, operation.value) });
            continue;
          }
          throw new Error('所选回想的条件值存在冲突，请分别应用');
        }
        operations.set(key, operation);
      }
      if (!operations.size) throw new Error('请选择包含已确认解锁条件的回想条目');
      return { recipeId: randomUUID(), recipeIds, labels: recipes.map(recipe => recipe.label), fingerprint: fresh.fingerprint, buildId: binding.buildId, operations: [...operations.values()] };
    },
    async capture({ projectId, selection, capture }) {
      const project = await projectFor(projectId);
      if (!capture || capture.recipeId !== selection.recipeId || !capture.gameSessionId || !Array.isArray(capture.entries) || capture.entries.length !== selection.operations.length || capture.entries.some((entry, index) => !isDeepStrictEqual(entry.operation, selection.operations[index]))) throw new Error('游戏返回的回想备份与方案不一致');
      const backup = { id: randomUUID(), recipeIds: selection.recipeIds, labels: selection.labels, fingerprint: selection.fingerprint, buildId: selection.buildId, createdAt: new Date().toISOString(), status: 'captured', capture };
      const records = await readJson(paths(project).backups, []);
      records.unshift(backup);
      await saveJson(paths(project).backups, records);
      onChanged();
      return backup;
    },
    async backup({ projectId, backupId, verify = false }) {
      const project = await projectFor(projectId);
      const records = await readJson(paths(project).backups, []);
      const backup = records.find(record => record.id === backupId);
      if (!backup) throw new Error('请从回想备份列表重新选择备份');
      if (verify) {
        const binding = source(project);
        if (binding.buildId !== backup.buildId || (await current(project, binding)).fingerprint !== backup.fingerprint) throw new Error('游戏版本已变化，请使用对应成品恢复');
      }
      return backup;
    },
    async update({ projectId, backupId, status, error }) {
      const project = await projectFor(projectId);
      const records = await readJson(paths(project).backups, []);
      const backup = records.find(record => record.id === backupId);
      if (!backup) throw new Error('请从回想备份列表重新选择备份');
      backup.status = status;
      if (error) backup.error = error;
      else delete backup.error;
      if (status === 'restored') backup.restoredAt = new Date().toISOString();
      await saveJson(paths(project).backups, records);
      onChanged();
      return backup;
    },
  };
}
