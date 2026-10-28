import { useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ProjectDetail } from "../../../packages/contracts/index";
import { api, errorMessage } from "./api";
import { Button, Modal } from "./components";

/**
 * 进度与成品完整度的数据契约由工作台服务提供。这里按契约读取，
 * 并对缺失或类型不符的字段做降级处理：服务未返回时组件不渲染，
 * 单个字段异常时不抛错，避免刷新节奏被打断。
 */
export type ProgressConfidence = "none" | "low" | "medium" | "high";
/** 服务给出的运行态：并发上限、在飞数量与排队深度，界面不再自己数。 */
export type RuntimeInfo = {
  active: number;
  limit: number;
  queued: number;
  running: number;
};

export function TechnicalPublicationStatus({ project }: { project: Pick<ProjectDetail, "publication" | "lanes" | "status" | "adaptationPending"> }) {
  const state = project.publication;
  if (!state) return null;
  const number = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value!.toLocaleString() : null;
  const facts = [
    number(state.accepted) !== null ? `已保存技术成果 ${number(state.accepted)} 批` : "",
    number(state.integrated) !== null ? `已接入工作台 ${number(state.integrated)} 批` : "",
    number(state.pendingIntegration) !== null ? `等待接入 ${number(state.pendingIntegration)} 批` : "",
    state.stale ? `需重新验证 ${number(state.stale)} 批` : "",
  ].filter(Boolean);
  const labels: Record<string, string> = { running: "进行中", queued: "排队中", yielded: "已交还执行机会", ready: "已就绪", idle: "待命", paused: "已暂停", blocked: "待处理问题", completed: "已完成", failed: "待处理问题" };
  const lanes = [["资源检查", project.lanes?.adaptation], ["文字制作", project.lanes?.text], ["成品制作", project.lanes?.build]] as const;
  const activity = lanes.filter(([, lane]) => lane && labels[lane.status]).map(([name, lane]) => `${name}：${labels[lane!.status]}`);
  return <div className="technical-progress" role="status" aria-label="技术成果接入" data-generation={state.generation}>
    {facts.length > 0 && <p>{facts.join(" · ")}</p>}
    {activity.length > 0 && <p>{activity.join(" · ")}</p>}
    {facts.length > 0 && <p className="muted">批次数表示技术成果接入情况，不是新增文字数，也不表示游戏文字已全部提取。</p>}
    {state.materialReady && project.adaptationPending && project.status === "running" && <p className="muted">已接入的文字可以继续制作，剩余游戏文件仍在检查。</p>}
    {Boolean(state.pendingIntegration) && <p className="muted">尚未接入的成果不会提前用于翻译或生成成品。</p>}
    {state.lastError && <p className="muted">接入尚未完成：{errorMessage(state.lastError)}</p>}
  </div>;
}
export type ProgressInfo = {
  total: number;
  counted: number;
  done: number;
  remaining: number;
  percent: number;
  throughput: number | null;
  etaMs: number | null;
  etaAt: string | null;
  confidence: ProgressConfidence;
  phases: {
    pending: number;
    translated: number;
    proofread: number;
    skipped: number;
  };
  blockers: string[];
  paused: boolean;
  finished: boolean;
  phaseLabel: string;
  runtime: RuntimeInfo | null;
  review?: { stage: string; total: number | null; reviewed: number; skipped: number };
};

const reviewLabels: Record<string, string> = {
  scene: "场景校对",
  consistency: "译名与疑点复核",
  resolve: "修改分歧核对",
  commit: "保存校对结果",
  committed: "校对已完成",
};

export type CompletionVerdict =
  | "complete"
  | "mostly-complete"
  | "partial"
  | "unfinished";
export type CompletionSample = { id: string; source: string; where: string };
export type CompletionBlocker = {
  kind: string;
  count: number;
  samples: CompletionSample[];
};
export type CompletionSection = {
  kind: string;
  total: number;
  untranslated: number;
  names: string[];
};
export type CompletionInfo = {
  summary: {
    total: number;
    translated: number;
    untranslated: number;
    skipped: number;
    completeness: number;
    verdict: CompletionVerdict;
  };
  blockers: CompletionBlocker[];
  sections: CompletionSection[];
  glossaryUsage: { entries: number; missing: { source: string; translation: string; category: string }[] };
  latestBuild: { id: string; runtimeVerified: boolean; outputModified: boolean } | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

export function NameCheckSummary({ project }: {
  project: Pick<ProjectDetail, "translated" | "proofread" | "glossaryProgress">;
}) {
  const progress = project.glossaryProgress;
  if (!progress?.total || project.translated + project.proofread === 0) return null;
  return <p role="status" aria-label="译名检查">
    译名检查：{progress.total.toLocaleString()} 项，{progress.conflicts.toLocaleString()} 项待校对
  </p>;
}

export function ResourceCoverageSummary({ coverage }: { coverage: ProjectDetail["coverage"] }) {
  if (!coverage) return null;
  if (coverage.stale) return <p className="muted" role="status">
    {coverage.addedUnitsSinceScan ? `已接入 ${coverage.addedUnitsSinceScan.toLocaleString()} 条文字` : "已保存新的适配成果"}；剩余文件待重新核对。
    已保存的文字可继续翻译和生成汉化版。
  </p>;
  return <>
    <p className="muted">
      已提取文字的文件 {coverage.summary.extracted ?? 0} 个 ·
      待检查文字的文件 {coverage.summary["display-text-candidate"] ?? 0} 个 ·
      脚本文件 {coverage.summary["script-resource"] ?? 0} 个 ·
      待检查图片 {coverage.summary["image-candidate"] ?? 0} 张
    </p>
    {Boolean(coverage.summary.nativeReviewObjects) && <p className="muted">
      待检查原生组件 {coverage.summary.nativeReviewObjects!.toLocaleString()} 个 ·
      涉及资源 {coverage.summary.nativeReviewResources ?? 0} 个。
      组件按对象计数，确认的显示文字按条目加入工作台。
    </p>}
    {Boolean(coverage.summary.presentationItems) && <p className="muted">
      字体与显示提示 {coverage.summary.presentationItems} 项，随成品检查字形与排版。
    </p>}
  </>;
}

export function readProgress(
  project: ProjectDetail | null | undefined,
): ProgressInfo | null {
  const source = record(record(project)?.progress);
  if (!source) return null;
  const total = count(source.total);
  if (total <= 0) return null;
  const done = count(source.done);
  const rawPercent = optionalCount(source.percent);
  const phases = record(source.phases);
  const confidence = source.confidence;
  const round = record(record(project)?.reviewRound);
  const reviewStage = text(round?.stage);
  const review = record(round?.progress);
  const isReview = Object.hasOwn(reviewLabels, reviewStage) &&
    (reviewStage !== "committed" || Boolean(round?.committedAt));
  return {
    total,
    counted: optionalCount(source.counted) ?? total,
    done,
    remaining: count(source.remaining),
    percent:
      rawPercent === null
        ? Math.round((done / total) * 1000) / 10
        : clamp(rawPercent, 0, 100),
    throughput: optionalCount(source.throughput),
    etaMs: optionalCount(source.etaMs),
    etaAt: typeof source.etaAt === "string" ? source.etaAt : null,
    confidence:
      confidence === "low" || confidence === "medium" || confidence === "high"
        ? confidence
        : "none",
    phases: {
      pending: count(phases?.pending),
      translated: count(phases?.translated),
      proofread: count(phases?.proofread),
      skipped: count(phases?.skipped),
    },
    blockers: strings(source.blockers),
    paused: source.paused === true,
    finished: source.finished === true,
    phaseLabel: text(source.phaseLabel),
    runtime: readRuntime(project),
    ...(isReview && { review: {
      stage: reviewStage,
      total: optionalCount(review?.total),
      reviewed: count(review?.reviewed),
      skipped: count(review?.skipped),
    } }),
  };
}

/** runtime 直接来自 detail()：active/limit/queued/running 都是服务算好的数字。 */
export function readRuntime(
  project: ProjectDetail | null | undefined,
): RuntimeInfo | null {
  const source = record(record(project)?.runtime);
  if (!source) return null;
  return {
    active: count(source.active),
    limit: count(source.limit),
    queued: count(source.queued),
    running: count(source.running),
  };
}

function normalizeCompletion(value: unknown): CompletionInfo | null {
  const source = record(value);
  const summary = record(source?.summary);
  if (!source || !summary) return null;
  const verdict = summary.verdict;
  const glossary = record(source.glossaryUsage);
  return {
    summary: {
      total: count(summary.total),
      translated: count(summary.translated),
      untranslated: count(summary.untranslated),
      skipped: count(summary.skipped),
      completeness: clamp(count(summary.completeness), 0, 100),
      verdict:
        verdict === "complete" ||
        verdict === "mostly-complete" ||
        verdict === "partial"
          ? verdict
          : "unfinished",
    },
    blockers: list(source.blockers).flatMap((item): CompletionBlocker[] => {
      const blocker = record(item);
      const kind = text(blocker?.kind);
      if (!blocker || !kind) return [];
      return [
        {
          kind,
          count: count(blocker.count),
          samples: list(blocker.samples).flatMap(
            (sample): CompletionSample[] => {
              const entry = record(sample);
              if (!entry) return [];
              return [
                {
                  id: text(entry.id),
                  source: text(entry.source),
                  where: text(entry.where),
                },
              ];
            },
          ),
        },
      ];
    }),
    sections: list(source.sections).flatMap((item): CompletionSection[] => {
      const section = record(item);
      const kind = text(section?.kind);
      if (!section || !kind) return [];
      return [
        {
          kind,
          total: count(section.total),
          untranslated: count(section.untranslated),
          names: strings(section.names),
        },
      ];
    }),
    glossaryUsage: {
      entries: count(glossary?.entries),
      missing: list(glossary?.missing).flatMap(item => {
        const entry = record(item);
        return entry ? [{ source: text(entry.source), translation: text(entry.translation), category: text(entry.category) }] : [];
      }),
    },
    latestBuild: record(source.latestBuild) ? { id: text(record(source.latestBuild)?.id),
      runtimeVerified: record(source.latestBuild)?.runtimeVerified === true, outputModified: record(source.latestBuild)?.outputModified === true } : null,
  };
}

/** 从成品生成结果中取出完整度清单；旧版服务没有该字段时返回 null。 */
export function completionFrom(value: unknown): CompletionInfo | null {
  const source = record(value);
  return source ? normalizeCompletion(source.completion) : null;
}

/** 拉取完整度清单的纯文本版本，用于“查看清单”。 */
export async function requestCompletionReport(input: {
  projectId: string;
}): Promise<{ report: CompletionInfo | null; text: string }> {
  const result = record(await api.completionReport(input));
  return { report: normalizeCompletion(result?.report), text: text(result?.text) };
}

const confidenceNames: Record<ProgressConfidence, string> = {
  none: "估算中",
  low: "低",
  medium: "中",
  high: "高",
};

function formatEta(etaMs: number): string {
  const minutes = Math.max(1, Math.round(etaMs / 60000));
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`;
}

function formatClock(etaAt: string | null): string {
  if (!etaAt) return "";
  const time = new Date(etaAt);
  return Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * 进度条。数据来自 detail()，随现有刷新节奏更新，不额外计时。
 * 文字工作台用 compact 收紧密度，信息项与总览页一致。
 */
export function ProgressPanel({
  progress,
  compact = false,
  onViewSceneReview,
}: {
  progress: ProgressInfo | null;
  compact?: boolean;
  onViewSceneReview?: () => void;
}) {
  if (!progress) return null;
  const covered = progress.remaining <= 0;
  const finished = progress.finished;
  const review = finished ? undefined : progress.review;
  const measurableReview = review && ["scene", "consistency", "resolve"].includes(review.stage);
  const percent = review
    ? measurableReview && review.total !== null && review.total > 0
      ? clamp(review.reviewed / review.total * 100, 0, 100) : null
    : progress.percent;
  const clock = formatClock(progress.etaAt);
  const eta = review
    ? progress.paused ? "校对已暂停，已保存的审阅结果保留" : review.stage === "scene" ? "场景校对中" : reviewLabels[review.stage]
    : finished
    ? "本轮制作完成"
    : covered
      ? progress.paused ? "当前制作已暂停，译文持续保留" : progress.phaseLabel || "译文已齐，继续后续制作"
    : progress.paused
      ? progress.etaMs === null
        ? "初翻已暂停，继续后重新估算剩余时间"
        : `初翻已暂停，继续后预计剩余${formatEta(progress.etaMs)}`
      : progress.confidence === "none" || progress.etaMs === null
        ? "初翻剩余时间正在估算…"
        : `初翻预计剩余${formatEta(progress.etaMs)}`;
  const pace =
    progress.throughput === null
      ? ""
      : `${Math.round(progress.throughput).toLocaleString()} 条/分钟`;
  const meta = [
    eta,
    covered || review ? "" : pace,
    covered || review || progress.confidence === "none"
      ? ""
      : `置信度 ${confidenceNames[progress.confidence]}`,
  ].filter(Boolean);
  const runtime = progress.runtime;
  const concurrency =
    runtime && runtime.limit > 0 && runtime.active > 0
      ? `${runtime.active} / ${runtime.limit} 并发 · 队列 ${runtime.queued}`
      : "";

  return (
    <div className={`status-progress ${compact ? "compact" : ""}`} role="status">
      <div className="status-progress-line">
        <strong>
          {review ? measurableReview && review.total !== null
            ? `已审阅 ${review.reviewed.toLocaleString()} / ${review.total.toLocaleString()} 条`
            : reviewLabels[review.stage]
            : `已有译文 ${progress.done.toLocaleString()} / ${progress.counted.toLocaleString()}`}
        </strong>
        {percent !== null && <span>{percent.toFixed(1)}%</span>}
      </div>
      {percent !== null && <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={review ? `${reviewLabels[review.stage]}进度` : "已有译文覆盖进度"}
      >
        <span style={{ width: `${percent}%` }} />
      </div>}
      {measurableReview && review.total === null && <p className="status-progress-meta">正在读取校对进度</p>}
      <p className="status-progress-meta">
        {meta.join(" · ")}
        {clock && !review && !covered && !progress.paused && (
          <span>（预计 {clock} 前后）</span>
        )}
      </p>
      {!review && !covered && progress.phaseLabel && <p className="status-progress-meta">{progress.phaseLabel}</p>}
      {concurrency && <p className="status-progress-meta">{concurrency}</p>}
      <p className="status-progress-note">{review
        ? `${covered ? "初翻已完成；" : ""}${review.stage === "committed" ? "校对结果已保存，接下来生成成品。" : "审阅结果持续保存，收尾检查完成后统一更新当前译文。"}`
        : "以上进度只统计已提取文字；校对、成品生成与游戏内显示另行检查。"}</p>
      {review && review.stage !== "committed" && onViewSceneReview && <Button
        variant="ghost" onClick={onViewSceneReview}
      >查看场景审阅结果</Button>}
      {review && review.skipped > 0 && <p className="status-progress-note">
        本阶段跳过 {review.skipped.toLocaleString()} 条，保留当前译文
      </p>}
      {!review && progress.phases.skipped > 0 && (
        <p className="status-progress-note">
          其中 {progress.phases.skipped.toLocaleString()} 条已跳过，成品中保留原文
        </p>
      )}
      {progress.blockers.length > 0 && (
        <ul className="status-progress-blockers">
          {progress.blockers.map((blocker, index) => (
            <li key={`${index}-${blocker}`}>
              <CircleAlert size={14} aria-hidden="true" />
              <span>{blocker}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const verdictNames: Record<CompletionVerdict, string> = {
  complete: "完成",
  "mostly-complete": "大部分完成",
  partial: "部分完成",
  unfinished: "尚未完成",
};

const blockerNames: Record<string, string> = {
  untranslated: "未翻译",
  empty: "译文为空",
  skipped: "已跳过",
  "image-untouched": "图片文字未处理",
  identical: "疑似漏译",
  "blank-source": "原文为空",
  "open-issue": "待处理记录",
};

const sectionNames: Record<string, string> = {
  dialogue: "对话",
  message: "对话",
  choice: "选项",
  name: "名称",
  description: "说明",
  script: "脚本显示文字",
  database: "游戏资料",
  text: "文字",
  picture_text: "图片文字",
  system_text: "系统文字",
  system_term: "系统用语",
  character_name: "角色名称",
  database_profile: "人物简介",
  map_display_name: "地图名称",
};

/** 未译类阻塞项：成品里会直接显示原文，和“其他”分开统计。 */
const untranslatedKinds = new Set(["untranslated", "empty"]);

/**
 * 成品完整度卡片。blockers 分两组显示：两组口径本来不闭合，
 * 分开呈现比强行凑成一个总数更诚实。
 */
export function CompletionCard({
  projectId,
  completion,
  needsAdaptation = false,
}: {
  projectId: string;
  completion: CompletionInfo;
  needsAdaptation?: boolean;
}) {
  const [report, setReport] = useState<{
    loading: boolean;
    error: string;
    text: string;
  } | null>(null);
  const summary = completion.summary;
  const untranslated = completion.blockers.filter((blocker) =>
    untranslatedKinds.has(blocker.kind),
  );
  const others = completion.blockers.filter(
    (blocker) => !untranslatedKinds.has(blocker.kind),
  );

  async function open() {
    setReport({ loading: true, error: "", text: "" });
    try {
      const result = await requestCompletionReport({ projectId });
      setReport({
        loading: false,
        error: "",
        text: result.text || "清单没有更多内容。",
      });
    } catch (failure) {
      setReport({ loading: false, error: errorMessage(failure), text: "" });
    }
  }

  const trigger = (
    <Button
      variant="ghost"
      busy={report?.loading}
      disabled={report?.loading}
      onClick={() => void open()}
    >
      查看清单
    </Button>
  );

  function row(blocker: CompletionBlocker) {
    return (
      <li key={blocker.kind}>
        <span>{blockerNames[blocker.kind] || blocker.kind}</span>
        <small>{blocker.count.toLocaleString()} 条</small>
        {trigger}
      </li>
    );
  }

  return (
    <section
      className={`completion-card ${summary.verdict}`}
      aria-label="已提取文字翻译覆盖"
    >
      <header className="completion-head">
        <div>
          <h2>已提取文字翻译覆盖 {summary.completeness.toFixed(1)}%</h2>
          <span className="tag">{verdictNames[summary.verdict]}</span>
        </div>
        <span className="muted">共 {summary.total.toLocaleString()} 条</span>
      </header>
      <p className="completion-figures">
        已译 {summary.translated.toLocaleString()} · 未译{" "}
        {summary.untranslated.toLocaleString()} · 已跳过{" "}
        {summary.skipped.toLocaleString()}
      </p>
      <p className="muted">只统计已提取的文字，不代表全游戏文字已找齐，也不代表已通过游玩检查。</p>
      {completion.blockers.length === 0 ? (
        <p className="completion-clear">
          <Check size={15} aria-hidden="true" />
          已提取的文字条目检查完成
        </p>
      ) : (
        <>
          <p className="completion-prompt">需要注意：</p>
          <ul className="completion-blockers">
            <li className="group">
              <span>未译（成品里会显示原文）</span>
            </li>
            {untranslated.length > 0 ? (
              untranslated.map(row)
            ) : (
              <li className="quiet">这一类暂时没有条目</li>
            )}
            {others.length > 0 && (
              <>
                <li className="group">
                  <span>其他记录（统计口径与上面不同，请分开看待）</span>
                </li>
                {others.map(row)}
              </>
            )}
          </ul>
        </>
      )}
      {needsAdaptation && <p className="muted">部分游戏资源仍需检查，当前清单只统计已提取的文字。</p>}
      {completion.latestBuild?.outputModified ? (
        <p className="muted">成品文件已有修改，请重新生成后再导出分享包。</p>
      ) : !completion.latestBuild?.runtimeVerified ? (
        <p className="muted">接下来启动成品，核对对话、字体、分支与存档，再决定分享。</p>
      ) : <p className="muted">本次成品已记录游玩验证，可结合检查清单确认分享内容。</p>}
      {completion.sections.length > 0 && (
        <details className="checks">
          <summary>
            未译文字的分布 <span>{completion.sections.length} 项</span>
          </summary>
          <ul className="completion-sections">
            {completion.sections.slice(0, 12).map((section) => (
              <li key={section.kind}>
                <strong>{sectionNames[section.kind] || section.kind}</strong>
                <small>
                  未译 {section.untranslated.toLocaleString()} /{" "}
                  {section.total.toLocaleString()} 条
                </small>
                {section.names.length > 0 && (
                  <p className="muted">
                    {section.names.slice(0, 4).join("、")}
                    {section.names.length > 4 ? " 等" : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {completion.sections.length > 12 && (
            <p className="muted">
              另有 {completion.sections.length - 12} 类未展开，查看清单可获取全部内容。
            </p>
          )}
        </details>
      )}
      {completion.glossaryUsage.missing.length > 0 && (
        <details className="checks">
          <summary>
            人名与术语 <span>{completion.glossaryUsage.entries} 项</span>
          </summary>
          <p className="muted">
            有 {completion.glossaryUsage.missing.length} 项没有出现在当前译文中：
            {completion.glossaryUsage.missing.slice(0, 20).map(entry => entry.translation || entry.source).join("、")}
            {completion.glossaryUsage.missing.length > 20 ? " 等" : ""}
          </p>
        </details>
      )}
      {report && (
        <Modal
          title="已提取文字检查清单"
          error={report.error || undefined}
          busy={report.loading}
          onClose={() => setReport(null)}
        >
          {report.loading ? (
            <p className="muted spaced">正在整理清单…</p>
          ) : report.text ? (
            <pre className="report-text">{report.text}</pre>
          ) : null}
          <div className="dialog-actions">
            <Button onClick={() => setReport(null)} disabled={report.loading}>
              关闭
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
