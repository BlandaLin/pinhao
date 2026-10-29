import { tr, uiMessage, uiLanguage, uiLocale } from "../shared/ui-language.js";
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
    number(state.accepted) !== null ? tr`已保存技术成果 ${number(state.accepted)} 批` : "",
    number(state.integrated) !== null ? tr`已接入工作台 ${number(state.integrated)} 批` : "",
    number(state.pendingIntegration) !== null ? tr`等待接入 ${number(state.pendingIntegration)} 批` : "",
    state.stale ? tr`需重新验证 ${number(state.stale)} 批` : "",
  ].filter(Boolean);
  const labels: Record<string, string> = { running: tr("进行中"), queued: tr("排队中"), yielded: tr("等待后续处理"), ready: tr("已就绪"), idle: tr("待命"), paused: tr("已暂停"), blocked: tr("待处理问题"), completed: tr("已完成"), failed: tr("待处理问题") };
  const lanes = [[tr("资源检查"), project.lanes?.adaptation], [tr("文字制作"), project.lanes?.text], [tr("成品制作"), project.lanes?.build]] as const;
  const activity = lanes.filter(([, lane]) => lane && labels[lane.status]).map(([name, lane]) => `${name}：${labels[lane!.status]}`);
  return <div className="technical-progress" role="status" aria-label={tr("技术成果接入")} data-generation={state.generation}>
    {facts.length > 0 && <p>{facts.join(" · ")}</p>}
    {activity.length > 0 && <p>{activity.join(" · ")}</p>}
    {state.materialReady && project.adaptationPending && project.status === "running" && <p className="muted">{tr("已接入文字可继续制作，剩余文件检查中。")}</p>}
    {state.lastError && <p className="muted">{tr("接入尚未完成：")}{errorMessage(state.lastError)}</p>}
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
  scene: tr("场景校对"),
  consistency: tr("译名与疑点复核"),
  resolve: tr("修改分歧核对"),
  commit: tr("保存校对结果"),
  committed: tr("校对已完成"),
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
  return <p role="status" aria-label={tr("译名检查")}>{tr("译名检查：")}{progress.total.toLocaleString()}{tr(" 项，")}{progress.conflicts.toLocaleString()}{tr(" 项待校对")}</p>;
}

export function ResourceCoverageSummary({ coverage }: { coverage: ProjectDetail["coverage"] }) {
  if (!coverage) return null;
  if (coverage.stale) return <p className="muted" role="status">
    {coverage.addedUnitsSinceScan ? tr`已接入 ${coverage.addedUnitsSinceScan.toLocaleString()} 条文字` : tr("已保存新的适配成果")}{tr("；剩余文件待复查。")}</p>;
  return <>
    <p className="muted">{tr("已提取文字的文件 ")}{coverage.summary.extracted ?? 0}{tr(" 个 · 待检查文字的文件 ")}{coverage.summary["display-text-candidate"] ?? 0}{tr(" 个 · 脚本文件 ")}{coverage.summary["script-resource"] ?? 0}{tr(" 个 · 待检查图片 ")}{coverage.summary["image-candidate"] ?? 0}{tr(" 张")}</p>
    {Boolean(coverage.summary.nativeReviewObjects) && <p className="muted">{tr("待检查原生组件 ")}{coverage.summary.nativeReviewObjects!.toLocaleString()}{tr(" 个 · 涉及资源 ")}{coverage.summary.nativeReviewResources ?? 0}{tr(" 个")}</p>}
    {Boolean(coverage.summary.presentationItems) && <p className="muted">{tr("字体与显示提示 ")}{coverage.summary.presentationItems}{tr(" 项")}</p>}
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
    blockers: strings(source.blockers).map(uiMessage),
    paused: source.paused === true,
    finished: source.finished === true,
    phaseLabel: uiMessage(text(source.phaseLabel)),
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
  const report = normalizeCompletion(result?.report);
  return { report, text: uiLanguage === "en" && report ? englishCompletionReport(report) : text(result?.text) };
}

function englishCompletionReport(report: CompletionInfo): string {
  const { summary } = report;
  const lines = ["Extracted-text checklist", "",
    `Translated: ${summary.translated}; untranslated: ${summary.untranslated}; skipped: ${summary.skipped}`,
    `Coverage of extracted text: ${summary.completeness.toFixed(1)}%`];
  for (const blocker of report.blockers) {
    lines.push("", `${blockerNames[blocker.kind] || blocker.kind}: ${blocker.count}`);
    for (const sample of blocker.samples) {
      const where = sample.where.split(" · ").map(uiMessage).join(" · ");
      lines.push(`  ${where || sample.id}`, `  ${sample.source}`);
    }
  }
  if (report.sections.length) {
    lines.push("", "Text categories");
    for (const section of report.sections) lines.push(`${sectionNames[section.kind] || section.kind}: ${section.untranslated} / ${section.total} untranslated`);
  }
  if (report.glossaryUsage.missing.length) {
    lines.push("", "Name choices not found in current translations");
    for (const entry of report.glossaryUsage.missing) lines.push(`${entry.source} → ${entry.translation}`);
  }
  return lines.join("\n");
}

function formatEta(etaMs: number): string {
  const minutes = Math.max(1, Math.round(etaMs / 60000));
  if (minutes < 60) return tr`约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? tr`约 ${hours} 小时 ${rest} 分钟` : tr`约 ${hours} 小时`;
}

function formatClock(etaAt: string | null): string {
  if (!etaAt) return "";
  const time = new Date(etaAt);
  return Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleTimeString(uiLocale, { hour: "2-digit", minute: "2-digit" });
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
  const runtime = progress.runtime;
  const idle = !finished && !progress.paused && !review && runtime &&
    runtime.active === 0 && runtime.running === 0 && runtime.queued === 0;
  const measurableReview = review && ["scene", "consistency", "resolve"].includes(review.stage);
  const percent = review
    ? measurableReview && review.total !== null && review.total > 0
      ? clamp(review.reviewed / review.total * 100, 0, 100) : null
    : progress.percent;
  const clock = formatClock(progress.etaAt);
  const eta = review
    ? progress.paused ? tr("校对已暂停") : review.stage === "scene" ? tr("场景校对中") : reviewLabels[review.stage]
    : finished
    ? tr("本轮制作完成")
    : covered
      ? progress.paused ? tr("制作已暂停") : progress.phaseLabel || tr("译文已齐，继续后续制作")
    : progress.paused
      ? progress.etaMs === null
        ? tr("初翻已暂停")
        : tr`初翻已暂停，继续后预计剩余${formatEta(progress.etaMs)}`
      : progress.confidence === "none" || progress.etaMs === null
        ? tr("初翻剩余时间正在估算…")
        : tr`初翻预计剩余${formatEta(progress.etaMs)}`;
  const pace =
    progress.throughput === null
      ? ""
      : tr`${Math.round(progress.throughput).toLocaleString()} 条/分钟`;
  const meta = idle ? [] : [
    eta,
    covered || review ? "" : pace,
  ].filter(Boolean);
  const concurrency =
    runtime && runtime.limit > 0 && runtime.active > 0
      ? tr`${runtime.active} / ${runtime.limit} 并发 · 队列 ${runtime.queued}`
      : "";

  return (
    <div className={`status-progress ${compact ? "compact" : ""}`} role="status">
      <div className="status-progress-line">
        <strong>
          {review ? measurableReview && review.total !== null
            ? tr`已审阅 ${review.reviewed.toLocaleString()} / ${review.total.toLocaleString()} 条`
            : reviewLabels[review.stage]
            : tr`已有译文 ${progress.done.toLocaleString()} / ${progress.counted.toLocaleString()}`}
        </strong>
        {percent !== null && <span>{percent.toFixed(1)}%</span>}
      </div>
      {percent !== null && <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={review ? tr`${reviewLabels[review.stage]}进度` : tr("已有译文覆盖进度")}
      >
        <span style={{ width: `${percent}%` }} />
      </div>}
      {measurableReview && review.total === null && <p className="status-progress-meta">{tr("正在读取校对进度")}</p>}
      {meta.length > 0 && <p className="status-progress-meta">
        {meta.join(" · ")}
        {clock && !review && !covered && !progress.paused && (
          <span>{tr("（预计 ")}{clock}{tr(" 前后）")}</span>
        )}
      </p>}
      {!idle && !review && !covered && progress.phaseLabel && <p className="status-progress-meta">{progress.phaseLabel}</p>}
      {concurrency && <p className="status-progress-meta">{concurrency}</p>}
      <p className="status-progress-note">{review
        ? review.stage === "committed" ? tr("校对结果已保存。") : tr("审阅结果自动保存，收尾后更新译文。")
        : tr("统计范围：已提取文字。")}</p>
      {review && review.stage !== "committed" && onViewSceneReview && <Button
        variant="ghost" onClick={onViewSceneReview}
      >{tr("查看场景审阅结果")}</Button>}
      {review && review.skipped > 0 && <p className="status-progress-note">{tr("本阶段跳过 ")}{review.skipped.toLocaleString()}{tr(" 条，保留当前译文")}</p>}
      {!review && progress.phases.skipped > 0 && (
        <p className="status-progress-note">{tr("其中 ")}{progress.phases.skipped.toLocaleString()}{tr(" 条已跳过，成品中保留原文")}</p>
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
  complete: tr("完成"),
  "mostly-complete": tr("大部分完成"),
  partial: tr("部分完成"),
  unfinished: tr("尚未完成"),
};

const blockerNames: Record<string, string> = {
  untranslated: tr("未翻译"),
  empty: tr("译文为空"),
  skipped: tr("已跳过"),
  "image-untouched": tr("图片文字未处理"),
  identical: tr("疑似漏译"),
  "blank-source": tr("原文为空"),
  "open-issue": tr("待处理记录"),
};

const sectionNames: Record<string, string> = {
  dialogue: tr("对话"),
  message: tr("对话"),
  choice: tr("选项"),
  name: tr("名称"),
  description: tr("说明"),
  script: tr("脚本显示文字"),
  database: tr("游戏资料"),
  text: tr("文字"),
  picture_text: tr("图片文字"),
  system_text: tr("系统文字"),
  system_term: tr("系统用语"),
  character_name: tr("角色名称"),
  database_profile: tr("人物简介"),
  map_display_name: tr("地图名称"),
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
        text: result.text || tr("无额外记录。"),
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
    >{tr("查看清单")}</Button>
  );

  function row(blocker: CompletionBlocker) {
    return (
      <li key={blocker.kind}>
        <span>{blockerNames[blocker.kind] || blocker.kind}</span>
        <small>{blocker.count.toLocaleString()}{tr(" 条")}</small>
        {trigger}
      </li>
    );
  }

  return (
    <section
      className={`completion-card ${summary.verdict}`}
      aria-label={tr("已提取文字翻译覆盖")}
    >
      <header className="completion-head">
        <div>
          <h2>{tr("已提取文字翻译覆盖 ")}{summary.completeness.toFixed(1)}%</h2>
          <span className="tag">{verdictNames[summary.verdict]}</span>
        </div>
        <span className="muted">{tr("共 ")}{summary.total.toLocaleString()}{tr(" 条")}</span>
      </header>
      <p className="completion-figures">{tr("已译 ")}{summary.translated.toLocaleString()}{tr(" · 未译")}{" "}
        {summary.untranslated.toLocaleString()}{tr(" · 已跳过")}{" "}
        {summary.skipped.toLocaleString()}
      </p>
      <p className="muted">{tr("统计范围：已提取文字。")}</p>
      {completion.blockers.length === 0 ? (
        <p className="completion-clear">
          <Check size={15} aria-hidden="true" />{tr("已提取的文字条目检查完成")}</p>
      ) : (
        <>
          <p className="completion-prompt">{tr("需要注意：")}</p>
          <ul className="completion-blockers">
            <li className="group">
              <span>{tr("未译（成品里会显示原文）")}</span>
            </li>
            {untranslated.length > 0 ? (
              untranslated.map(row)
            ) : (
              <li className="quiet">{tr("无记录")}</li>
            )}
            {others.length > 0 && (
              <>
                <li className="group">
                  <span>{tr("其他待处理记录")}</span>
                </li>
                {others.map(row)}
              </>
            )}
          </ul>
        </>
      )}
      {needsAdaptation && <p className="muted">{tr("仍有游戏资源待检查。")}</p>}
      {completion.latestBuild?.outputModified ? (
        <p className="muted">{tr("成品文件已有修改，请重新生成后再导出分享包。")}</p>
      ) : !completion.latestBuild?.runtimeVerified ? (
        <p className="muted">{tr("分享前请打开成品，检查对白、字体、分支和存档。")}</p>
      ) : <p className="muted">{tr("已保存本次游玩检查记录。")}</p>}
      {completion.sections.length > 0 && (
        <details className="checks">
          <summary>{tr("未译文字的分布 ")}<span>{completion.sections.length}{tr(" 项")}</span>
          </summary>
          <ul className="completion-sections">
            {completion.sections.slice(0, 12).map((section) => (
              <li key={section.kind}>
                <strong>{sectionNames[section.kind] || section.kind}</strong>
                <small>{tr("未译 ")}{section.untranslated.toLocaleString()} /{" "}
                  {section.total.toLocaleString()}{tr(" 条")}</small>
                {section.names.length > 0 && (
                  <p className="muted">
                    {section.names.slice(0, 4).join("、")}
                    {section.names.length > 4 ? tr(" 等") : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {completion.sections.length > 12 && (
            <p className="muted">{tr("另有 ")}{completion.sections.length - 12}{tr(" 类，详见完整清单。")}</p>
          )}
        </details>
      )}
      {completion.glossaryUsage.missing.length > 0 && (
        <details className="checks">
          <summary>{tr("人名与术语 ")}<span>{completion.glossaryUsage.entries}{tr(" 项")}</span>
          </summary>
          <p className="muted">{tr("有 ")}{completion.glossaryUsage.missing.length}{tr(" 项没有出现在当前译文中：")}{completion.glossaryUsage.missing.slice(0, 20).map(entry => entry.translation || entry.source).join("、")}
            {completion.glossaryUsage.missing.length > 20 ? tr(" 等") : ""}
          </p>
        </details>
      )}
      {report && (
        <Modal
          title={tr("已提取文字检查清单")}
          error={report.error || undefined}
          busy={report.loading}
          onClose={() => setReport(null)}
        >
          {report.loading ? (
            <p className="muted spaced">{tr("正在整理清单…")}</p>
          ) : report.text ? (
            <pre className="report-text">{report.text}</pre>
          ) : null}
          <div className="dialog-actions">
            <Button onClick={() => setReport(null)} disabled={report.loading}>{tr("关闭")}</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
