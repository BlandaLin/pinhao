// 诊断可观测性——只在 `%APPDATA%/拼好汉化工作台/diagnostics.on` 存在时启用。
//
// 用户的要求：试用版要能 DEBUG，发行版一点痕迹不留。所以这里不用 build flag、不做两套产物，
// 只做运行期检查：没有那个标记文件时，所有导出函数立即返回，不注册监听、不写文件、不计算摘要。
// 发行版只是没有这个文件，代码一字不改。
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readdir, writeFile, rename } from 'node:fs/promises';
import { readJsonProjection } from '../../../packages/technical/native-targets.mjs';

let enabled; // 检查一次就缓存：这是热路径（每次 IPC 调用都会问）
let logDir;

export function diagnosticsEnabled(dataDir) {
  if (enabled === undefined) {
    try {
      enabled = existsSync(path.join(dataDir, 'diagnostics.on'));
      logDir = path.join(dataDir, 'logs');
      if (enabled) mkdirSync(logDir, { recursive: true });
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

const stamp = (date = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
};

/** 保留最近 n 个 crash 文件，多了删掉。诊断代码自己不能把盘写满。 */
function pruneCrashes(keep = 10) {
  try {
    const files = readdirSync(logDir).filter(name => name.startsWith('crash-')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(path.join(logDir, name));
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * 主进程未捕获异常落盘。必须同步写：进程可能立刻死，异步写会丢。
 * recentCommands 是最近若干条 IPC 调用，能回答“点了什么才炸的”。
 */
export function writeCrashLog(dataDir, { kind, error, extra = {}, recentCommands = [] }) {
  if (!diagnosticsEnabled(dataDir)) return;
  try {
    pruneCrashes();
    const file = path.join(logDir, `crash-${stamp()}.log`);
    const lines = [
      `kind: ${kind}`,
      `at: ${new Date().toISOString()}`,
      `error.name: ${error?.name ?? ''}`,
      `error.message: ${error?.message ?? String(error)}`,
      '',
      '--- stack ---',
      String(error?.stack ?? '(no stack)'),
      '',
      '--- extra ---',
      JSON.stringify(extra, null, 2),
      '',
      '--- recent ipc commands (oldest first) ---',
      ...recentCommands.map(item => JSON.stringify(item)),
      '',
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');
  } catch { /* 磁盘满或权限不足时静默 */ }
}

/** 渲染进程错误按天追加，单文件超 2 MB 轮转。 */
export function appendRendererError(dataDir, payload) {
  if (!diagnosticsEnabled(dataDir)) return;
  try {
    const file = path.join(logDir, `renderer-${stamp().slice(0, 8)}.log`);
    try { if (statSync(file).size > 2 * 1024 * 1024) return; } catch { /* 文件还不存在 */ }
    appendFileSync(file, `[${new Date().toISOString()}] ${JSON.stringify(payload)}\n`, 'utf8');
  } catch { /* 静默 */ }
}

/** IPC 调用的环形缓冲，崩溃时随日志落盘。 */
export function createCommandLog(limit = 30) {
  const items = [];
  return {
    record(method, input) {
      let size = 0;
      try { size = JSON.stringify(input ?? null).length; } catch { size = -1; }
      items.push({ at: Date.now(), method, inputSize: size });
      if (items.length > limit) items.shift();
    },
    snapshot() { return [...items]; },
  };
}

/** 运行摘要：项目转入暂停/完成/失败时写一份，省掉手工查库算批大小的过程。 */
export async function writeRunSummary(dataDir, snapshot) {
  if (!diagnosticsEnabled(dataDir)) return;
  try {
    const technical = await technicalRequestStats(snapshot.workspaceDir);
    const requests = snapshot.requests ?? { total: 0, retained: 0, historyLimited: false, byRole: {} };
    const summary = {
      schema: 'pinhao-run-summary-2',
      at: new Date().toISOString(),
      projectId: snapshot.id ?? snapshot.projectId,
      runId: snapshot.runId,
      status: snapshot.status,
      durationMs: snapshot.durationMs,
      durationBasis: snapshot.durationMs === undefined ? 'unavailable' : 'observed-session',
      tasks: snapshot.tasks,
      requests: { ...requests, total: requests.total + technical.total, technicalArtifacts: technical },
      batchSize: snapshot.batchSize,
      failures: snapshot.failures ?? [],
    };
    const target = path.join(snapshot.workspaceDir ?? dataDir, 'run-summary.json');
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(summary, null, 2), 'utf8');
    await rename(temporary, target);
  } catch { /* 摘要失败不影响主流程 */ }
}

async function directories(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => path.join(root, entry.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Technical requests live outside text-task histories; read only their result metadata. */
export async function technicalRequestStats(workspaceDir) {
  const total = { total: 0, received: 0, failed: 0, cancelled: 0, timeout: 0, sent: 0, incomplete: 0, codes: {} };
  if (!workspaceDir) return total;
  const roots = [];
  for (const run of await directories(path.join(workspaceDir, 'technical'))) {
    for (const work of [run, path.join(run, 'adapter-workbench')]) {
      for (const owner of [work, ...await directories(path.join(work, 'jobs'))]) {
        roots.push(path.join(owner, 'request-artifacts'), path.join(owner, 'display-review', 'request-artifacts'));
      }
    }
  }
  const seen = new Set();
  for (const root of roots) for (const directory of await directories(root)) {
    if (seen.has(directory)) continue;
    seen.add(directory); total.total++;
    try {
      const { value } = await readJsonProjection(path.join(directory, 'result.json'), { select: parts => !parts.length
        || ['status', 'sentAt'].includes(parts[0])
        || parts[0] === 'error' && (parts.length === 1 || ['name', 'code', 'category'].includes(parts[1])) });
      if (value.sentAt) total.sent++;
      if (value.status === 'received') total.received++;
      else if (value.error?.name === 'AbortError' || value.error?.code === 20 || value.error?.category === 'cancelled') total.cancelled++;
      else if (value.status === 'failed') total.failed++;
      if (['ETIMEDOUT', 'TECHNICAL_REQUEST_TIMEOUT'].includes(value.error?.code) || value.error?.category === 'timeout') total.timeout++;
      if (value.error?.code !== undefined) total.codes[value.error.code] = (total.codes[value.error.code] ?? 0) + 1;
    } catch (error) { total.incomplete++; }
  }
  return total;
}

/** Observe status changes only while diagnostics are enabled, including automatic pauses. */
export function createRunSummaryMonitor({ enabled, getHeads, getSnapshot, write, delayMs = 250, clock = Date.now }) {
  const statuses = new Map(), starts = new Map(), pending = new Set();
  const stopped = new Set(['paused', 'completed', 'failed', 'cancelled']);
  let timer, draining, dirty = false, closed = false;
  const schedule = () => {
    if (closed || !enabled() || timer) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, delayMs);
    timer.unref?.();
  };
  async function drain() {
    if (closed || !enabled()) return;
    if (draining) { dirty = true; return; }
    draining = (async () => {
      try {
        const heads = await getHeads();
        const liveIds = new Set(heads.map(head => head.id));
        for (const id of statuses.keys()) if (!liveIds.has(id)) {
          statuses.delete(id); starts.delete(id); pending.delete(id);
        }
        for (const head of heads) {
          const previous = statuses.get(head.id);
          statuses.set(head.id, head.status);
          if (head.status === 'running' || head.status === 'preparing') {
            if (!['running', 'preparing'].includes(previous)) starts.set(head.id, clock());
            pending.delete(head.id);
          } else if (stopped.has(head.status) && previous && previous !== head.status) pending.add(head.id);
        }
        for (const id of pending) {
          const snapshot = await getSnapshot(id);
          if (!stopped.has(snapshot.status)) { pending.delete(id); continue; }
          if (snapshot.inFlight > 0 || snapshot.tasks?.running > 0) continue;
          const start = starts.get(id);
          await write({ ...snapshot, ...(start === undefined ? {} : { durationMs: Math.max(0, clock() - start) }) });
          pending.delete(id);
        }
      } catch { /* Diagnostics never interfere with work or shutdown. */ }
    })();
    try { await draining; }
    finally { draining = undefined; if (dirty || pending.size) { dirty = false; schedule(); } }
  }
  return {
    async prime() {
      if (!enabled()) return;
      try { for (const head of await getHeads()) { statuses.set(head.id, head.status); if (['running', 'preparing'].includes(head.status)) starts.set(head.id, clock()); } } catch {}
    },
    changed() { if (!enabled() || closed) return; dirty = true; schedule(); },
    async flush() { clearTimeout(timer); timer = undefined; await drain(); },
    async close() { closed = true; clearTimeout(timer); await draining; },
  };
}

export const __testing = { stamp, pruneCrashes, resetEnabled() { enabled = undefined; logDir = undefined; } };
