/**
 * Progress visibility for long-running translations.
 *
 * Pure functions only: no store, no filesystem, no timers. The caller supplies the
 * current time so the same snapshot can be replayed in tests and logs.
 *
 * ETA is derived from the active working time of finished tasks, not from wall clock,
 * because a paused project has no useful wall-clock rate.
 */

const DONE_STATUSES = new Set(['translated', 'proofread', 'skipped']);
const PHASES = ['pending', 'translated', 'proofread', 'skipped'];
const STALL_MS = 10 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Timestamps arrive as epoch milliseconds from the store, but tolerate ISO strings. */
function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  return null;
}

const round1 = value => Math.round(value * 10) / 10;

/** Concurrent requests share elapsed time; queueing and overnight pauses do not. */
export function activeMilliseconds(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let elapsed = 0, first, last;
  for (const [start, end] of sorted) {
    if (last === undefined || start > last) { if (last !== undefined) elapsed += last - first; first = start; last = end; }
    else last = Math.max(last, end);
  }
  return elapsed + (last === undefined ? 0 : last - first);
}

function creditedWork(tasks, statusOf, taskStats) {
  const projected = taskStats?.timing?.translation;
  const unitIds = projected?.unitIds ?? tasks.filter(task => task.role !== 'proofreading' && task.role !== 'technical'
    && task.kind !== 'glossary' && task.status === 'succeeded').flatMap(task => task.unitIds ?? []);
  const intervals = projected?.intervals ?? tasks.filter(task => task.role !== 'proofreading' && task.role !== 'technical' && task.kind !== 'glossary')
    .flatMap(task => task.requestHistory?.length ? task.requestHistory.map(request => [time(request.artifact?.sentAt), time(request.finishedAt)])
      : [[time(task.startedAt), time(task.finishedAt)]]);
  const credited = new Set(unitIds.filter(id => DONE_STATUSES.has(statusOf.get(id)))).size;
  const elapsedMs = activeMilliseconds(intervals);
  return { elapsedMs, credited, perUnitMs: credited && elapsedMs ? elapsedMs / credited : null };
}

const phaseNames = { translation: '正在翻译', scene: '正在校对场景', consistency: '正在核对人物与术语一致性',
  commit: '正在保存校对结果', completed: '本轮制作完成', complete: '校对已完成', finished: '本轮制作完成' };

export function estimateProgress(units, tasks, { now = Date.now(), taskStats, phase, projectStatus, runMode, proofreadingEnabled = true } = {}) {
  const unitList = Array.isArray(units) ? units : [];
  const taskList = Array.isArray(tasks) ? tasks : [];
  const phases = { pending: 0, translated: 0, proofread: 0, skipped: 0 };
  const statusOf = new Map();
  for (const unit of unitList) {
    // Unknown statuses stay in `pending` so the four phases always add up to `total`.
    const status = PHASES.includes(unit?.status) ? unit.status : 'pending';
    phases[status] += 1;
    if (unit?.id !== undefined) statusOf.set(unit.id, status);
  }
  const total = unitList.length;
  // Same definition as `project.done`: handled means translated or proofread. Skipped units are
  // counted separately and stay out of the denominator, so a project with skips can still reach 100%.
  const done = phases.translated + phases.proofread;
  const remaining = total - done - phases.skipped;
  const denominator = total - phases.skipped;
  // Nothing left to do means done: a vacuous 100% beats a misleading 0%.
  const percent = denominator > 0 ? round1((done / denominator) * 100) : 100;

  const counts = taskStats?.counts ?? taskList.reduce((result, task) => ({ ...result, [task.status]: (result[task.status] ?? 0) + 1 }), {});
  const active = (counts.running ?? 0) > 0 || (counts.queued ?? 0) > 0;
  const pausedAll = projectStatus === 'paused' || (!projectStatus && !active && (counts.paused ?? 0) > 0);

  const { elapsedMs, credited, perUnitMs } = creditedWork(taskList, statusOf, taskStats);
  const throughput = credited && elapsedMs > 0 ? round1(credited / (elapsedMs / MINUTE)) : null;
  // 20/100/500 land in the lower bucket; tiny samples never produce an ETA.
  const confidence = credited < 20 || !elapsedMs ? 'none' : credited <= 100 ? 'low' : credited <= 500 ? 'medium' : 'high';
  const etaMs = confidence !== 'none' && perUnitMs !== null && remaining > 0 ? Math.round(remaining * perUnitMs) : null;

  const blockers = [];
  if (remaining > 0) {
    if (pausedAll) blockers.push('所有任务已暂停');
    else if (!active) blockers.push('没有在跑的任务，需要点继续');
    const stalled = taskStats ? (counts.running ?? 0) > 0 && Number.isFinite(taskStats.latestRunningAt) && now - taskStats.latestRunningAt > STALL_MS
      : taskList.some(task => task?.status === 'running' && time(task.finishedAt) === null
        && now - (time(task.startedAt) ?? now) > STALL_MS);
    if (stalled) blockers.push('有任务长时间无响应');
  }

  return {
    total, done, remaining, percent, throughput, etaMs,
    // `counted` is the denominator `percent` uses (total minus skipped); the UI prints it as-is so it
    // never re-derives the progress rule on its own.
    counted: denominator,
    // While paused the active-time remainder would be a lie as a wall-clock instant.
    etaAt: etaMs === null || pausedAll ? null : new Date(now + etaMs).toISOString(),
    confidence, phases, blockers,
    paused: pausedAll,
    coverageComplete: remaining === 0,
    finished: projectStatus === 'completed',
    phase, phaseLabel: phaseNames[phase] ?? (projectStatus === 'completed' ? '本轮制作完成'
      : remaining > 0 ? '正在准备或翻译文字'
        : runMode === 'translation' || !proofreadingEnabled ? '翻译已完成，可以生成成品' : '译文已齐，继续校对与成品检查'),
  };
}

function duration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < MINUTE) return '不到 1 分钟';
  if (ms < 60 * MINUTE) return `${Math.max(1, Math.round(ms / MINUTE))} 分钟`;
  const hours = Math.floor(ms / (60 * MINUTE)), minutes = Math.round((ms % (60 * MINUTE)) / MINUTE);
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

/** One log/CLI line: `已完成 12480/20800 (60.0%) · 约 42 分钟 · 置信度 medium`. */
export function progressLine(progress) {
  const value = progress ?? {};
  const total = value.total ?? 0, done = value.done ?? 0;
  const skipped = value.phases?.skipped ?? 0;
  // The denominator matches `percent`: skipped units are reported next to the line, not inside it.
  const denominator = Math.max(0, total - skipped);
  const head = `已有译文 ${done}/${denominator} (${Number(value.percent ?? 0).toFixed(1)}%)`;
  if (!denominator) return skipped ? `${head} · 没有需要处理的文字单元` : `${head} · 没有可处理的文字单元`;
  const parts = [head];
  if ((value.remaining ?? 0) > 0) {
    const span = duration(value.etaMs);
    if (!span) parts.push('剩余时间待估算');
    else parts.push(value.paused ? `暂停中，续跑后约 ${span}` : `约 ${span}`);
  } else parts.push(value.finished ? '本轮制作完成' : value.phaseLabel ?? '译文已齐，继续后续制作');
  if (typeof value.throughput === 'number' && value.throughput > 0) parts.push(`${value.throughput.toFixed(1)} 条/分钟`);
  // Confidence grades the ETA sample; printing it next to "待估算" would contradict itself.
  if (value.confidence && value.confidence !== 'none' && value.etaMs !== null) parts.push(`置信度 ${value.confidence}`);
  for (const blocker of value.blockers ?? []) parts.push(blocker);
  return parts.join(' · ');
}
