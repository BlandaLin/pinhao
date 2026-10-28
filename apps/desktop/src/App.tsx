import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import appMetadata from "../package.json";
import {
  BookOpenText,
  Check,
  ChevronRight,
  CircleAlert,
  FileArchive,
  FolderOpen,
  Gamepad2,
  HelpCircle,
  LayoutDashboard,
  LibraryBig,
  LoaderCircle,
  Moon,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Smartphone,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  Build,
  EngineCapability,
  Issue,
  ProjectDetail,
  Snapshot,
} from "../../../packages/contracts/index";
import { api, errorMessage, nativeDesktop } from "./api";
import {
  Button,
  Empty,
  Heading,
  LoadingState,
  Modal,
  PathField,
  Progress,
  Status,
} from "./components";
import Workbench from "./Workbench";
import {
  CompletionCard,
  NameCheckSummary,
  ResourceCoverageSummary,
  TechnicalPublicationStatus,
  ProgressPanel,
  completionFrom,
  readProgress,
  requestCompletionReport,
  type CompletionInfo,
} from "./status";
import SettingsPage from "./Settings";
import Assist from "./Assist";
import WelcomeGuide, { hasSeenWelcome, rememberWelcome } from "./WelcomeGuide";
import { joiplayArchivePath, releaseArchivePath } from "./release";
import { useTheme } from "./theme";
import EngineLabel from "./EngineLabel";
import { createRefreshQueue } from "./refresh-queue";
import { primaryProjectAction, requestProjectWork, technicalNeeds } from "./technical-action";

type Page =
  "overview" | "library" | "workbench" | "release" | "assist" | "settings";
const pages = [
  { id: "overview", label: "制作总览", icon: LayoutDashboard },
  { id: "library", label: "游戏项目", icon: LibraryBig },
  { id: "workbench", label: "文字工作台", icon: BookOpenText },
  { id: "release", label: "成品与导出", icon: Package },
  { id: "assist", label: "游玩辅助", icon: Gamepad2 },
  { id: "settings", label: "设置", icon: Settings2 },
] as const;
const taskStatuses: Record<string, string> = {
  queued: "待执行",
  pending: "待执行",
  running: "处理中",
  done: "完成",
  completed: "完成",
  succeeded: "完成",
  failed: "失败",
  paused: "暂停",
  cancelled: "已暂停",
  skipped: "待重试",
  stale: "待重新处理",
};
const adaptationStops: Record<string, string> = {
  "output-truncated": "模型的本次回复达到长度上限，已完成的结果和进度已保存。",
  length: "模型的本次回复达到长度上限，已完成的结果和进度已保存。",
  "no-progress": "连续尝试后，部分游戏文件仍未通过检查。",
  "repair-limit": "本轮已达到自动重试次数上限，已完成的结果和进度已保存。",
  "step-limit": "本轮已达到处理步数上限，剩余文字可继续提取。",
  "request-timeout": "本轮模型请求超时，当前进度已保存",
  timeout: "本轮模型请求超时，当前进度已保存",
  "pending-resources": "部分游戏文件仍需处理，已提取的文字已保存。",
  "model-finished": "模型已结束本次处理，剩余文字可继续提取。",
  cancelled: "文字提取已暂停，当前进度已保存。",
  verified: "文字已通过检查并加入工作台。",
  error: "部分游戏文件处理出错，可展开查看具体原因。",
};
function canCheckOmissions(project: ProjectDetail | null) {
  return Boolean(project?.engine === "Unity" && project.canContinueAvailableText &&
    project.extractedTotal !== undefined && !project.adaptationAvailable);
}
function engineFor(engines: EngineCapability[], name: string | undefined) {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/rpg maker|[\s_\/-]/g, "");
  return name
    ? engines.find(
        (engine) =>
          normalize(engine.id) === normalize(name) ||
          normalize(engine.name) === normalize(name),
      )
    : undefined;
}
const issueCategories: Record<string, string> = {
  adapter: "引擎适配",
  "technical-review": "文字提取检查记录",
  "image-text": "待检查的图片文字",
  translation: "翻译任务",
  proofreading: "校对任务",
  build: "成品构建",
  validation: "文字校验",
  conflict: "译文冲突",
  adaptation: "文字提取记录",
  "adaptation-recipe": "文字处理方案",
  "coverage-deferred": "剩余文字处理记录",
  coverage: "文字提取检查",
  "cache-cleanup": "缓存清理记录",
  "name-glossary": "人名与术语检查",
  "technical-plan": "游戏文件处理方案",
  "native-sample": "首批译文写入检查",
  "image-redraw": "图片文字修改记录",
  "merge-conflict": "工作包译文冲突",
  "text-question": "待确认的译文",
};
const stageLabels: Record<string, string> = {
  "技术适配就绪": "准备继续提取文字",
  "技术适配待处理": "文字提取待继续",
  "技术适配已暂停": "文字提取已暂停",
  "无改动回写验证": "检查文字能否正确写回游戏",
  "首批原生回写小样": "检查首批译文能否写入游戏",
  "首批原生回写待处理": "首批译文写入检查待继续",
  "构建待处理": "汉化版生成待继续",
  "校验与构建": "检查文字并生成汉化版",
  "技术接口恢复后继续": "连接恢复后继续提取文字",
  "技术方案已确认": "游戏文件处理方案已确认",
  "继续原生文字制作": "继续制作已提取的文字",
};
const checkStatuses: Record<string, string> = {
  passed: "通过",
  pass: "通过",
  ok: "通过",
  pending: "待检查",
  failed: "失败",
  warning: "待确认",
  skipped: "已保留",
};

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [page, setCurrentPage] = useState<Page>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [guideOpen, setGuideOpen] = useState(() => !hasSeenWelcome());
  const [importDir, setImportDir] = useState("");
  const [dropRevision, setDropRevision] = useState(0);
  const [draggingGame, setDraggingGame] = useState(false);
  const [resolvingDrop, setResolvingDrop] = useState(false);
  const dragDepth = useRef(0);
  const [deleting, setDeleting] = useState<ProjectDetail | null>(null);
  const [executionProject, setExecutionProject] = useState<ProjectDetail | null>(null);
  const [removeWorkspace, setRemoveWorkspace] = useState(false);
  const [pendingPage, setPendingPage] = useState<Page | null>(null);
  const currentId = useRef(projectId);
  currentId.current = projectId;
  const refreshQueue = useRef<ReturnType<typeof createRefreshQueue> | null>(null);
  const currentPage = useRef(page);
  currentPage.current = page;
  const snapshotKey = useRef("");
  const detailKey = useRef("");
  const detailSignature = useRef("");
  const editorDirty = useRef(false);

  function closeGuide() {
    rememberWelcome();
    setGuideOpen(false);
  }

  function setPage(next: Page) {
    if (next === page) return true;
    if (page === "workbench" && editorDirty.current) {
      setPendingPage(next);
      return false;
    }
    editorDirty.current = false;
    setCurrentPage(next);
    return true;
  }

  async function loadWorkspace(force: boolean) {
    try {
      const next = await api.snapshot();
      const key = JSON.stringify(next);
      if (key !== snapshotKey.current) { snapshotKey.current = key; setSnapshot(next); }
      const selected = next.projects.some((item) => item.id === currentId.current)
        ? currentId.current : next.projects[0]?.id;
      if (selected !== currentId.current) {
        currentId.current = selected || "";
        setProjectId(selected || "");
        setProject(null);
        detailKey.current = "";
        detailSignature.current = "";
      }
      const summaryKey = JSON.stringify(next.projects.find((item) => item.id === selected));
      const needsDetail = !["library", "settings"].includes(currentPage.current);
      if (selected && needsDetail && (force || detailKey.current !== summaryKey)) {
        const detail = await api.getProject({ projectId: selected, summaryOnly: true });
        if (!currentId.current) setProjectId(selected);
        if (!currentId.current || currentId.current === selected) {
          detailKey.current = summaryKey;
          const signature = JSON.stringify(detail);
          if (signature !== detailSignature.current) { detailSignature.current = signature; setProject(detail); }
        }
      } else if (!selected) setProject(null);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function refresh() {
    return refreshQueue.current?.request() ?? Promise.resolve();
  }

  useEffect(() => {
    const queue = createRefreshQueue(loadWorkspace);
    refreshQueue.current = queue;
    void queue.request();
    const timer = window.setInterval(() => queue.notify(), 2000);
    const unsubscribe = api.onChanged?.(() => queue.notify(true));
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
      queue.dispose();
      refreshQueue.current = null;
    };
  }, []);

  useEffect(() => {
    setProject(null);
    detailKey.current = "";
    detailSignature.current = "";
    void refresh();
  }, [projectId]);

  useEffect(() => { void refresh(); }, [page]);

  async function action<T>(
    name: string,
    operation: () => Promise<T>,
    message?: string,
  ): Promise<T | undefined> {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (failure) {
      setError(errorMessage(failure));
      return undefined;
    } finally {
      setBusy("");
    }
  }

  function selectProject(id: string) {
    if (setPage("overview")) {
      currentId.current = id;
      setProjectId(id);
    }
  }
  async function reconnectProject() {
    const result = await action("reconnect", async () => {
      const workspaceDir = await api.chooseDirectory({ title: "打开拼好工程文件夹（不是原游戏）" });
      return workspaceDir ? api.reconnectProject({ workspaceDir }) : undefined;
    });
    if (result) {
      selectProject(result.id);
      setNotice("已打开工程，已有译文和进度已保留。点击继续制作后才会调用模型。");
    }
  }
  function fileDrag(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }
  function dragEnter(event: DragEvent) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth.current++;
    setDraggingGame(true);
  }
  function dragLeave(event: DragEvent) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDraggingGame(false);
  }
  async function dropGame(event: DragEvent) {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDraggingGame(false);
    if (busy === "create" || resolvingDrop) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setError("每次拖入一个游戏文件夹或启动程序");
      return;
    }
    setResolvingDrop(true);
    try {
      if (!window.pinhao?.resolveDroppedGame) throw new Error("请在桌面版中拖入游戏，或在下方填写游戏目录");
      const selection = await window.pinhao.resolveDroppedGame(files[0]);
      setError("");
      setImportDir(selection.gameDir);
      setDropRevision((revision) => revision + 1);
      closeGuide();
      setCreating(true);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setResolvingDrop(false); }
  }
  const selected = snapshot?.projects.find((item) => item.id === projectId);
  const engine = engineFor(snapshot?.engines || [], project?.engine);
  const active =
    project?.status === "running" || project?.status === "preparing";
  const progress = readProgress(project);
  const reviewing = Boolean(progress?.review && !progress.finished);
  const adaptation = project?.adaptation;
  const primaryAction = project ? primaryProjectAction(project) : "start";
  const hostVerificationBlocked = project?.adaptationPending &&
    (adaptation?.stopReasonCode === "HOST_VERIFICATION_BLOCKED" || Boolean(project && technicalNeeds(project).length));
  const adaptationBlocked = project?.adaptationPending &&
    (adaptation?.blocked || adaptation?.retryable === false && !adaptation.continuationNeeded);
  const continueAvailable = project?.adaptationPending && project.canContinueAvailableText && project.total > 0;
  const retryReady = project?.adaptationPending && adaptation?.retryContextChanged;
  const adaptationPaused = project?.adaptationPending && adaptation?.status === "cancelled";
  const stopReason = adaptation?.reason || adaptationStops[adaptation?.stopReason ?? ""] || adaptation?.stopReason || adaptation?.error || project?.lastError ||
    (adaptationBlocked ? "当前技术处理缺少继续所需的条件，已有候选与证据已保存。" : "");
  const productionStopReason = project?.adaptationPending ? stopReason : project?.lastError;
  const pauseSummary = hostVerificationBlocked ? "当前程序尚不能完成这些资源的回写验证，候选和证据已保存。" : adaptationStops[adaptation?.stopReasonCode ?? adaptation?.stopReason ?? ""] ||
    "部分游戏文件仍需处理，当前进度已保存。";
  const adaptationAction = primaryAction === "settings" ? "检查模型设置" : primaryAction === "blocked" ? "需要补充条件" : adaptation?.continuationNeeded || retryReady ? "继续提取文字" : adaptation?.retryable || adaptation?.status === "needs-review" ? "重试文字提取" : "继续提取文字";

  return (
    <div className="app"
      onDragEnter={dragEnter}
      onDragLeave={dragLeave}
      onDragOver={(event) => {
        if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
      }}
      onDrop={(event) => void dropGame(event)}
    >
      {draggingGame && !creating && (
        <div className="game-drop-overlay" role="status">
          <Upload size={42} />
          <strong>松开以导入游戏</strong>
          <span>游戏文件夹、启动程序或快捷方式</span>
        </div>
      )}
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setPage("overview")}
          aria-label="拼好汉化首页"
        >
          <img src="./pinhao-logo.png" className="brand-mark" alt="拼好汉化" />
          <span className="brand-copy">
            <strong>拼好汉化</strong>
            <small>把故事，带到眼前</small>
          </span>
        </button>
        <button className="project-switch" onClick={() => setPage("library")}>
          <FolderOpen size={19} />
          <span>
            <strong>{selected?.name || "选择一个游戏"}</strong>
            <small>
              {selected ? <EngineLabel engine={selected.engine} label={engineFor(snapshot?.engines || [], selected.engine)?.name} /> : "从游戏目录开始"}
            </small>
          </span>
          <ChevronRight size={15} />
        </button>
        <nav aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "library" && Boolean(snapshot?.projects.length) && (
                <small>{snapshot?.projects.length}</small>
              )}
            </button>
          ))}
        </nav>
        <button className="nav-item tutorial-link" aria-label="使用教程" title="使用教程"
          onClick={() => setGuideOpen(true)}>
          <HelpCircle size={19} /><span>使用教程</span>
        </button>
        <div className="sidebar-bottom">
          <button type="button" className="theme-toggle" onClick={toggleTheme}
            aria-label={theme === "dark" ? "当前深夜模式，切换到日间模式" : "当前日间模式，切换到深夜模式"}
            title={theme === "dark" ? "切换到日间模式" : "切换到深夜模式"}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === "dark" ? "日间模式" : "深夜模式"}</span>
          </button>
          <span className="seal-line">免费分享 · 技术开放</span>
          <small>拼好汉化 · {appMetadata.version}</small>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <div>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{pages.find((item) => item.id === page)?.label}</strong>
          </div>
          <button
            className="icon-button"
            title="刷新项目"
            aria-label="刷新项目"
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <main>
          {error && (
            <div role="alert" className="banner error">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="banner success">
              <Check size={18} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="关闭完成提示"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!snapshot ? (
            <LoadingState title="正在连接工作空间" detail="正在读取项目与设置，准备你的工作空间。" />
          ) : page === "library" ? (
            <>
              <Heading
                title="游戏项目"
                description="拖入游戏文件夹或启动程序，建立独立的文字工作台与制作记录。"
              >
                <Button disabled={Boolean(busy)} onClick={() => void reconnectProject()}>
                  <FolderOpen size={17} />
                  打开已有工程
                </Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={17} />
                  导入游戏
                </Button>
              </Heading>
              {snapshot.projects.length ? (
                <div className="project-grid">
                  {snapshot.projects.map((item) => (
                    <button
                      key={item.id}
                      className={`project-card ${item.id === projectId ? "selected" : ""}`}
                      onClick={() => selectProject(item.id)}
                    >
                      <div className="project-card-top">
                        <div className="game-tile">
                          <Gamepad2 size={27} />
                        </div>
                        <Status value={item.status} />
                      </div>
                      <h2>{item.name}</h2>
                      <span className="muted">
                        <EngineLabel engine={item.engine} label={engineFor(snapshot.engines, item.engine)?.name} />
                      </span>
                      <p className="path-text" title={item.gameDir}>
                        {item.gameDir}
                      </p>
                      <Progress
                        total={item.total}
                        done={item.done}
                        skipped={item.skipped}
                      />
                      <div className="project-card-footer">
                        {item.stage}
                        <ChevronRight size={15} />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  title="开始你的第一个汉化项目"
                  action={
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      <Plus size={17} />
                      导入游戏目录
                    </Button>
                  }
                >
                  选择游戏，整理文字，再交付可独立游玩的汉化版。
                </Empty>
              )}
            </>
          ) : page === "settings" ? (
            <SettingsPage
              settings={snapshot.settings}
              fonts={snapshot.fonts || []}
              busy={busy}
              onError={(failure) => setError(errorMessage(failure))}
              onSave={(settings) =>
                action(
                  "settings",
                  () => api.saveSettings(settings),
                  "设置已保存",
                )
              }
              onTest={(role) =>
                action(`test-${role || "shared"}`, () =>
                  api.testConnection({ role: role || "shared" }),
                )
              }
            />
          ) : !project && projectId ? (
            <LoadingState title="正在读取项目" detail="正在整理文字进度与制作记录。" />
          ) : !project ? (
            <Empty
              title="选择游戏，开始制作"
              action={
                !projectId && (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus size={17} />
                    导入游戏
                  </Button>
                )
              }
            >
              导入游戏目录后，在这里管理翻译、校对与成品。
            </Empty>
          ) : page === "workbench" ? (
            <Workbench
              project={project}
              onError={(failure) => setError(errorMessage(failure))}
              onNotice={setNotice}
              onRefresh={refresh}
              onDirtyChange={(dirty) => {
                editorDirty.current = dirty;
              }}
            />
          ) : page === "release" ? (
            <Release
              project={project}
              error={error}
              busy={busy}
              action={action}
              onError={(failure) => setError(errorMessage(failure))}
            />
          ) : page === "assist" ? (
            <Assist
              project={project}
              engine={engine}
              onError={(failure) => setError(errorMessage(failure))}
            />
          ) : (
            <>
              <Heading
                title={project.name}
                description="查看文字提取、翻译、校对和成品制作的进度。"
              >
                <Status value={project.status} />
                <Button
                  variant="danger"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setRemoveWorkspace(false);
                    setDeleting(project);
                  }}
                >
                  <Trash2 size={16} />
                  删除项目
                </Button>
              </Heading>
              <section className="overview-hero">
                <div className="hero-content">
                  <span className="tag gold">
                    <EngineLabel engine={project.engine} label={engine?.name} />
                  </span>
                  <h2>{active && <LoaderCircle size={23} className="spin" aria-hidden="true" />}{stageLabels[project.stage] || project.stage}</h2>
                  {reviewing && <ProgressPanel progress={progress} compact />}
                  <p>
                    {active
                      ? "任务正在后台执行，进度持续保存。可以浏览文字工作台，或暂停后继续。"
                      : project.status === "paused"
                        ? project.adaptationPending
                          ? "已提取的文字和处理进度已保存，可以继续提取剩余文字。"
                          : "有效成果已保存，从当前进度继续制作。"
                        : project.status === "completed" && project.builds.length > 0
                          ? project.builds.at(-1)?.launchPath
                            ? "本次制作已完成。点击“查看成品与试玩”，检查游戏效果。"
                            : "输出文件已保存，启动入口待确认。点击“查看输出文件”查看结果。"
                        : "翻译与校对游戏文字，再生成可独立运行的游戏。"}
                  </p>
                  {project.adaptationDeferred && (
                    <div className="banner technical-deferred" role="status">
                      <BookOpenText size={18} />
                      <span>使用已提取的文字继续制作，其余内容保留原文。</span>
                    </div>
                  )}
                  {!active && (productionStopReason || retryReady) && (
                    <div className={`banner technical-stop ${retryReady || adaptationPaused ? "technical-ready" : "error"}`} role="status">
                      {retryReady ? <Play size={18} /> : adaptationPaused ? <Pause size={18} /> : <CircleAlert size={18} />}
                      <span>
                        <strong>{retryReady ? "可以继续提取文字" : project.adaptationPending ? "文字提取已暂停" : "制作已暂停"}</strong>
                        {retryReady ? <>
                          <span>上次的处理进度已保存。点击“继续提取文字”，处理剩余游戏文件。</span>
                          {productionStopReason && <details><summary>上次暂停原因</summary><p>{errorMessage(productionStopReason)}</p></details>}
                        </> : <>
                          <span>{project.adaptationPending ? pauseSummary : errorMessage(productionStopReason)}</span>
                          {project.adaptationPending && productionStopReason && productionStopReason !== pauseSummary && <details><summary>查看暂停原因</summary><p>{errorMessage(productionStopReason)}</p></details>}
                          {project.adaptationPending && <span>{hostVerificationBlocked
                            ? "请查看下方待补条件。补齐程序的验证能力后可接续已有候选，不必重新调查；更换模型不能替代格式验证。"
                            : primaryAction === "settings" ? "点击“检查模型设置”，核对连接与模型容量，保存后再试。"
                            : primaryAction === "blocked" ? "具体条件和已保存结果见处理记录；条件未补齐前不会反复发送模型请求。"
                            : `点击“${adaptationAction}”，从保存的进度继续。`}</span>}
                        </>}
                        {continueAvailable && <span>也可以点击“用已提取文字继续制作”，先翻译已有文字，其余内容保留原文。</span>}
                      </span>
                    </div>
                  )}
                  <TechnicalBlockers project={project} />
                  {!active && adaptation && <AdaptationOutcome adaptation={adaptation} coverage={project.coverage} />}
                  <div className="button-row">
                    {active ? (
                      <Button
                        variant="primary"
                        busy={busy === "pause"}
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void action(
                            "pause",
                            () => project.status === "preparing"
                              ? api.cancelProject({ projectId: project.id })
                              : api.pauseProject({ projectId: project.id }),
                            "进度已保存，任务已暂停",
                          )
                        }
                      >
                        <Pause size={17} />
                        {project.status === "preparing" ? "取消导入" : "暂停制作"}
                      </Button>
                    ) : (
                      <Button
                        variant={continueAvailable || project.status === "completed" && project.builds.length > 0 ? "secondary" : "primary"}
                        busy={busy === "start"}
                        disabled={Boolean(busy) || primaryAction === "blocked"}
                        onClick={() => primaryAction === "settings"
                          ? setPage("settings")
                          : void action("start", () => requestProjectWork(api, project))}
                      >
                        <Play size={17} />
                        {project.adaptationPending
                          ? adaptationAction
                          : project.status === "paused" ||
                        project.status === "failed"
                          ? "继续制作"
                          : project.status === "completed"
                            ? "继续翻译与校对"
                            : "开始翻译与校对"}
                      </Button>
                    )}
                    {!active && continueAvailable && (
                      <Button
                        variant="primary"
                        busy={busy === "continue-available"}
                        disabled={Boolean(busy)}
                        onClick={() => void action("continue-available", () => api.continueAvailableText({ projectId: project.id }))}
                      >
                        <Play size={17} />用已提取文字继续制作
                      </Button>
                    )}
                    {!active && (project.adaptationDeferred && project.adaptationAvailable || canCheckOmissions(project)) && (
                      <Button
                        busy={busy === "retry-adaptation"}
                        disabled={Boolean(busy)}
                        onClick={() => void action("retry-adaptation", () => api.retryAdaptation({ projectId: project.id }))}
                      >
                        <RefreshCw size={17} />{canCheckOmissions(project) ? "检查遗漏文字" : "提取剩余文字"}
                      </Button>
                    )}
                    {project.status === "completed" && project.builds.length > 0 && (
                      <Button variant="primary" onClick={() => setPage("release")}>
                        <Gamepad2 size={17} />{project.builds.at(-1)?.launchPath ? "查看成品与试玩" : "查看输出文件"}
                      </Button>
                    )}
                    <Button onClick={() => setPage("workbench")}>
                      <BookOpenText size={17} />
                      打开文字工作台
                    </Button>
                  </div>
                </div>
                <div className="paper-stack" aria-hidden="true">
                  <div className="paper rear" />
                  <div className="paper">
                    <span>物语</span>
                    <i />
                    <i />
                    <i />
                    <b>译</b>
                  </div>
                </div>
              </section>
              {(project.coverage || project.adaptation || project.workspaceExecution || project.nativeDependencyFailure) && (
                <section className="panel" aria-label="文字提取与文件检查">
                  <div className="panel-heading">
                    <h2>文字提取与文件检查</h2>
                    <span className="muted">查看已提取的文字与仍需检查的游戏文件</span>
                  </div>
                  <ResourceCoverageSummary coverage={project.coverage} />
                  <TechnicalPublicationStatus project={project} />
                  {project.nativeDependencyFailure && (
                    <div role="status" className="technical-progress">
                      <p><strong>原生工具暂时不可用</strong></p>
                      <p>{project.nativeDependencyFailure.message}</p>
                      <p className="muted">请修复程序的工具文件，或重新完整解压便携包，再继续制作。已有成果与诊断会保留；更换模型不能修复缺失的工具。</p>
                    </div>
                  )}
                  {project.adaptation && (
                    <div role="status" className="technical-progress">
                      <p>
                      {project.adaptationDeferred ? "已提取文字继续制作，其余内容保留原文" : project.adaptation.status === "verified" ? "文字已通过检查并加入工作台" : project.adaptation.status === "copying" ? "正在准备游戏文件副本" : project.adaptation.status === "running" ? "正在检查游戏文件并处理文字提取问题" : project.adaptation.status === "cancelled" ? "文字提取已暂停" : "剩余文字待提取"}
                      {project.adaptation.reused && " · 使用已保存的处理方案"}
                      {project.adaptation.totalJobs !== undefined && ` · 已处理 ${project.adaptation.processedJobs ?? project.adaptation.completedJobs ?? 0} / ${project.adaptation.totalJobs} 项`}
                      {project.adaptation.verifiedJobs !== undefined && ` · 通过 ${project.adaptation.verifiedJobs} 项`}
                      {Boolean(project.adaptation.resolvedJobs) && ` · 已核对 ${project.adaptation.resolvedJobs} 项`}
                      {project.adaptation.pendingJobs !== undefined && ` · 待处理 ${project.adaptation.pendingJobs} 项`}
                      </p>
                      {project.adaptationDeferred && stopReason && <p className="muted">剩余文字处理记录：{stopReason}</p>}
                      {active && <AdaptationOutcome adaptation={project.adaptation} coverage={project.coverage} />}
                      {Boolean(project.adaptation.jobs?.some(job => job.status === "needs-review" || job.status === "failed" || job.status === "blocked" || job.status === "cancelled")) && (
                        <details className="technical-jobs">
                          <summary>待处理的文件与原因</summary>
                          <ul>
                            {project.adaptation.jobs?.filter(job => job.status === "needs-review" || job.status === "failed" || job.status === "blocked" || job.status === "cancelled").map(job => (
                              <li key={job.id}>
                                <strong>{job.resource || job.files?.join("、") || "游戏文件处理任务"}</strong>
                                <span>{errorMessage(job.reason || adaptationStops[job.stopReason ?? ""] || "游戏文件检查待完成")}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                  <details className="technical-jobs">
                    <summary>技术脚本执行 · {project.workspaceExecution?.granted ? "本项目已授权" : "使用内置工具"}</summary>
                    <p className="muted">技术 Agent 可编写并运行脚本来处理新格式，默认在游戏工作副本中施工。脚本使用当前 Windows 用户权限，可以访问该用户的文件及网络。API 密钥由主程序保管，产品不向脚本传入密钥。</p>
                    <div className="button-row">
                      {project.workspaceExecution?.granted ? <Button disabled={Boolean(busy) || active}
                        title={active ? "暂停当前任务后可以撤销脚本执行授权" : "撤销后继续使用内置工具与轻量适配器"}
                        busy={busy === "workspace-execution"}
                        onClick={() => void action("workspace-execution", () => api.setWorkspaceExecution({ projectId: project.id, granted: false }), "本项目的脚本执行授权已撤销")}
                      >撤销脚本执行授权</Button> : <Button disabled={Boolean(busy)} onClick={() => setExecutionProject(project)}>允许本项目运行技术脚本</Button>}
                    </div>
                  </details>
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <h2>分阶段制作</h2>
                  <span className="muted">
                    待翻译 {(project.pending || 0).toLocaleString()} ·
                    已翻译 {(project.translated || 0).toLocaleString()} ·
                    {reviewing && progress?.review?.total !== null
                      ? `本阶段已审阅 ${(progress?.review?.reviewed || 0).toLocaleString()} 条`
                      : `已校对 ${(project.proofread || 0).toLocaleString()}`}
                  </span>
                </div>
                <NameCheckSummary project={project} />
                {Boolean(project.needsEvidence) && <p className="muted">
                  有 {(project.needsEvidence || 0).toLocaleString()} 条文字待核对，当前内容已保留。可在文字工作台查看疑点，或选择“定向重审疑点”，不必重新校对全部译文。
                </p>}
                {project.adaptationPending && !project.publication?.materialReady && <p className="muted">
                  {continueAvailable
                    ? "已有文字可以先制作：点击上方“用已提取文字继续制作”。剩余资源保留原文，可稍后再提取。"
                    : project.total === 0
                      ? "还没有可翻译的文字，请先完成上方的文字提取。"
                      : "已有文字仍需通过写回检查，请先继续上方的文字提取。"}
                </p>}
                <div className="button-row spaced">
                  {([
                    ["translation", "翻译待处理文字", "翻译等待处理的文字，然后生成汉化版"],
                    ["proofreading", "校对当前译文", "检查并修订已有译文，然后生成汉化版"],
                    ["repair", "重试问题文字", "重新处理翻译或校对失败的文字，以及人名和术语不一致的文字"],
                    ["review-issues", "定向重审疑点", "只重审尚未解决的疑点及必要关联文字，不重新校对全部译文"],
                  ] as const).map(([mode, label, title]) => (
                    <Button key={mode} title={project.adaptationPending ? "可以先继续提取文字，或点击“用已提取文字继续制作”" : title}
                      disabled={Boolean(busy) || active || project.total === 0 || project.adaptationPending}
                      busy={busy === mode}
                      onClick={() => void action(mode, () => api.startProject({ projectId: project.id, mode }))}
                    >
                      {mode === "repair" ? <RefreshCw size={16} /> : <Play size={16} />}
                      {label}
                    </Button>
                  ))}
                </div>
                {project.reviewRound?.stage === "translation" && <p className="muted">
                  本轮翻译进行中，完成后开始校对。
                </p>}
              </section>
              <section className="summary-grid">
                <div className="stat">
                  <span>文字条目</span>
                  <strong>{project.total.toLocaleString()}</strong>
                  <small>已提取的游戏文字，附所在场景与位置</small>
                </div>
                <div className="stat">
                  <span>已处理</span>
                  <strong>{project.done.toLocaleString()}</strong>
                  <small>翻译成果持续保存</small>
                </div>
                <div className="stat">
                  <span>待重试文字</span>
                  <strong>{project.skipped.toLocaleString()}</strong>
                  <small>当前文字已保留，可重新翻译或校对</small>
                </div>
                <div className="stat">
                  <span>生成结果</span>
                  <strong>{project.builds.length}</strong>
                  <small>生成的文件与检查结果保存在成品页</small>
                </div>
              </section>
              <div className="overview-columns">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>制作进度</h2>
                    <span className="muted">
                      {project.taskTotal ?? project.tasks.length} 个制作任务
                    </span>
                  </div>
                  {!reviewing && <ProgressPanel progress={progress} />}
                  <div className="task-list">
                    {project.tasks.length ? (
                      project.tasks
                        .slice(-8)
                        .reverse()
                        .map((task) => (
                          <div className="task-row" key={task.id}>
                            <span className={`task-dot ${task.status}`} />
                            <div>
                              <strong>
                                {task.role === "translation"
                                  ? "翻译"
                                  : task.role === "proofreading"
                                    ? "校对润色"
                                    : "文字提取与文件处理"}
                              </strong>
                              <small>
                                {task.error ? errorMessage(task.error) :
                                  `${task.role === "technical" ? "游戏文件处理" : `${task.unitIds.length} 条文字`} · 已尝试 ${task.attempts} 次`}
                              </small>
                              {task.progress && (
                                <small>
                                  {typeof task.progress.textCharacters === "number"
                                    ? `已收到正文 ${task.progress.textCharacters.toLocaleString()} 字${task.progress.reasoningCharacters ? ` · 推理 ${task.progress.reasoningCharacters.toLocaleString()} 字` : ""}`
                                    : `已收到回复片段 ${task.progress.receivedCharacters.toLocaleString()} 字（历史记录未分项）`}
                                  {` · 本批回复已保存 ${task.progress.checkpointed.toLocaleString()}/${task.progress.requested.toLocaleString()} 条`}
                                </small>
                              )}
                            </div>
                            <span className="tag">
                              {taskStatuses[task.status] || "查看处理记录"}
                            </span>
                          </div>
                        ))
                    ) : (
                      <p className="muted spaced">
                        开始制作后，任务与处理记录会显示在这里。
                      </p>
                    )}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>项目文件</h2>
                    <FolderOpen size={18} />
                  </div>
                  <dl className="project-paths">
                    <dt>游戏目录</dt>
                    <dd>{project.gameDir}</dd>
                    <dt>工作目录</dt>
                    <dd>{project.workspaceDir}</dd>
                    <dt>最近更新</dt>
                    <dd>
                      {new Date(project.updatedAt).toLocaleString("zh-CN")}
                    </dd>
                  </dl>
                  <Button
                    onClick={() =>
                      void action("open-work", () =>
                        api.openPath({ path: project.workspaceDir }),
                      )
                    }
                  >
                    打开工作目录
                  </Button>
                  {project.builds.length > 0 && (
                    <Button onClick={() => setPage("release")}>查看成品</Button>
                  )}
                </section>
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span role="status" className="workspace-status">
            {active ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <i className={snapshot ? "connected" : ""} />}
            <span className="workspace-status-text">
            {active
              ? `${project.name} · ${stageLabels[project.stage] || project.stage}`
              : resolvingDrop ? "正在识别拖入的游戏"
              : snapshot
              ? nativeDesktop
                ? "项目保存在本机"
                : "浏览器预览"
              : "正在连接"}
            </span>
          </span>
          <span>拼好汉化 · 免费分享，技术开放</span>
        </footer>
      </div>
      {snapshot && guideOpen && !creating && (
        <WelcomeGuide onClose={closeGuide} onConfigure={() => {
          closeGuide();
          setPage("settings");
        }} />
      )}
      {creating && (
        <CreateProject
          initialGameDir={importDir}
          dropRevision={dropRevision}
          dragging={draggingGame}
          busy={busy === "create"}
          error={error}
          onClose={() => { setCreating(false); setImportDir(""); setDraggingGame(false); dragDepth.current = 0; }}
          onError={(failure) => setError(errorMessage(failure))}
          onCreate={async (input) => {
            const created = await action("create", () =>
              api.beginProject(input),
            );
            if (created) {
              currentId.current = created.id;
              setProjectId(created.id);
              setProject(created);
              setPage("overview");
              setCreating(false);
              setImportDir("");
            }
          }}
        />
      )}
      {deleting && (
        <Modal title="删除项目" error={error} busy={busy === "delete"} onClose={() => setDeleting(null)}>
          <p className="dialog-intro">
            删除《{deleting.name}》的项目记录、当前译文、备注和修订历史。正在执行的任务会先停止，原版游戏、已生成成品和存档保留。
          </p>
          <label className="toggle-line">
            <input type="checkbox" checked={removeWorkspace} onChange={(event) => setRemoveWorkspace(event.target.checked)} />
            <div><strong>同时清理工作目录</strong><small>清理提取文件和临时缓存，保留成品和检测到的存档</small></div>
          </label>
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(null)} disabled={Boolean(busy)}>取消</Button>
            <Button variant="danger" busy={busy === "delete"}
              onClick={async () => {
                const result = await action("delete", () => api.deleteProject({ projectId: deleting.id, removeWorkspace }), "项目记录已删除，原版游戏和已生成成品已保留");
                if (result) {
                  setDeleting(null);
                  setPage("library");
                }
              }}
            >确认删除</Button>
          </div>
        </Modal>
      )}
      {executionProject && (
        <Modal title="允许技术 Agent 运行脚本" error={error} busy={busy === "workspace-execution"} onClose={() => setExecutionProject(null)}>
          <p className="dialog-intro">为《{executionProject.name}》启用受管本地执行。技术 Agent 可以编写和运行脚本，调查资源、测试新格式并生成适配配方。</p>
          <p>脚本以当前 Windows 用户权限运行，可以访问该用户的文件及网络。默认工作位置是游戏工作副本；主程序不向脚本传入 API 密钥。授权仅适用于本项目，可在制作总览撤销。</p>
          <div className="dialog-actions">
            <Button disabled={Boolean(busy)} onClick={() => setExecutionProject(null)}>继续使用内置工具</Button>
            <Button variant="primary" busy={busy === "workspace-execution"} onClick={async () => {
              const granted = await action("workspace-execution", () => api.setWorkspaceExecution({ projectId: executionProject.id, granted: true }), "本项目已启用技术脚本执行");
              if (granted) setExecutionProject(null);
            }}>授权并启用</Button>
          </div>
        </Modal>
      )}
      {pendingPage && (
        <Modal title="处理译文修改" onClose={() => setPendingPage(null)}>
          <p className="dialog-intro">
            当前译文有修改。请选择继续编辑，或放弃本次修改后离开。
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPendingPage(null)}>继续编辑</Button>
            <Button
              variant="danger"
              onClick={() => {
                editorDirty.current = false;
                setCurrentPage(pendingPage);
                setPendingPage(null);
              }}
            >
              放弃修改并离开
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function TechnicalBlockers({ project }: { project: ProjectDetail }) {
  const requirements = technicalNeeds(project);
  if (!requirements.length) return null;
  return <details className="technical-jobs technical-requirements">
    <summary>查看待补条件（{requirements.length} 项）</summary>
    <ul>{requirements.map(({ jobId, resource, candidateId, validationId, need }) => <li key={`${jobId ?? "project"}:${need.requirementRef}`}>
      <strong>{resource || "游戏资源验证"}</strong>
      <p>{need.kind === "FORMAT_SOURCE_STALE" ? "来源或验证条件已变化，需要按当前资源重新验证。"
        : need.kind.startsWith("FORMAT_") ? "尚缺文字定位、资源结构或安全回写的验证能力。" : "此项验证尚有条件未满足。"}</p>
      <small>候选：{candidateId ?? "已保留"} · 验证：{validationId ?? "已保留"}</small>
      <details><summary>技术详情</summary><p>{need.kind} · {need.requirementRef}</p>
        {need.nextActions?.map((action, index) => <p key={index}>{action}</p>)}</details>
    </li>)}</ul>
  </details>;
}

export function AdaptationOutcome({ adaptation, coverage }: { adaptation: NonNullable<ProjectDetail["adaptation"]>; coverage?: ProjectDetail["coverage"] }) {
  const facts = [
    adaptation.addedUnits !== undefined ? `本次新增文字 ${adaptation.addedUnits.toLocaleString()} 条` : "",
    adaptation.integratedUnits !== undefined ? `累计补充文字 ${adaptation.integratedUnits.toLocaleString()} 条` : "",
    adaptation.remainingCandidates !== undefined ? `待甄别候选 ${adaptation.remainingCandidates.toLocaleString()} 项${coverage?.truncated ? "（扫描尚未完整）" : ""}` : "",
  ].filter(Boolean);
  return facts.length > 0 ? <div className="technical-outcome"><p>{facts.join(" · ")}</p>
    {Boolean(adaptation.remainingCandidates) && <small>候选尚未通过文字与回写检查，不代表已加入文字工作台。</small>}</div> : null;
}

function CreateProject({
  initialGameDir,
  dropRevision,
  dragging,
  busy,
  onClose,
  onCreate,
  onError,
  error,
}: {
  initialGameDir: string;
  dropRevision: number;
  dragging: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onCreate: (input: {
    gameDir: string;
    name?: string;
    outputDir?: string;
  }) => Promise<void>;
  onError: (failure: unknown) => void;
}) {
  const [gameDir, setGameDir] = useState(initialGameDir);
  const [name, setName] = useState("");
  const [outputDir, setOutputDir] = useState("");
  useEffect(() => { if (initialGameDir) setGameDir(initialGameDir); }, [initialGameDir, dropRevision]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (gameDir.trim())
      void onCreate({
        gameDir: gameDir.trim(),
        name: name.trim() || undefined,
        outputDir: outputDir.trim() || undefined,
      });
  }
  return (
    <Modal title="导入游戏" onClose={onClose} busy={busy} error={error}>
      <form onSubmit={submit}>
        <p className="dialog-intro">
          选择含有游戏启动程序的目录，在游戏旁建立“游戏名-拼好工程”，原版游戏保持不变。
        </p>
        {nativeDesktop && (
          <div className={`game-drop-target ${dragging ? "active" : ""}`}>
            <Upload size={25} />
            <strong>{dragging ? "松开以填入游戏目录" : "把游戏拖到这里"}</strong>
            <span>支持游戏文件夹、启动程序和快捷方式</span>
          </div>
        )}
        <PathField
          label="游戏目录"
          value={gameDir}
          onChange={setGameDir}
          placeholder="例如 D:\Games\游戏名称"
          onError={onError}
        />
        <label className="field">
          <span>
            项目名称 <small>可选</small>
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="使用游戏目录名"
          />
        </label>
        <PathField
          label="成品保存文件夹（可选）"
          value={outputDir}
          onChange={setOutputDir}
          placeholder="默认保存在游戏旁的“游戏名-汉化版”"
          onError={onError}
        />
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!gameDir.trim()}
          >
            导入并提取文字
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type Action = <T>(
  name: string,
  operation: () => Promise<T>,
  message?: string,
) => Promise<T | undefined>;
function Release({
  project,
  busy,
  action,
  onError,
  error,
}: {
  project: ProjectDetail;
  busy: string;
  action: Action;
  error: string;
  onError: (failure: unknown) => void;
}) {
  const [outputDir, setOutputDir] = useState("");
  const [archive, setArchive] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [lastExport, setLastExport] = useState<{
    projectId: string;
    path: string;
    target?: "joiplay";
    warnings?: string[];
  } | null>(null);
  const [completion, setCompletion] = useState<{
    projectId: string;
    value: CompletionInfo;
  } | null>(null);
  const [completionLoad, setCompletionLoad] = useState({ loading: false, error: "" });
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  useEffect(() => {
    currentProjectId.current = project.id;
    return () => { currentProjectId.current = ""; };
  }, [project.id]);
  const latest = project.builds.at(-1);
  useEffect(() => {
    let current = true;
    setCompletion(null);
    setCompletionLoad({ loading: Boolean(latest?.id), error: "" });
    if (latest?.id) void requestCompletionReport({ projectId: project.id }).then(result => {
      if (!current) return;
      if (result.report) setCompletion({ projectId: project.id, value: result.report });
      setCompletionLoad({ loading: false, error: "" });
    }).catch(failure => {
      if (current) setCompletionLoad({ loading: false, error: errorMessage(failure) });
    });
    return () => { current = false; };
  }, [project.id, latest?.id]);
  const outstanding = project.issues.filter((issue) => !issue.resolvedAt && issue.severity !== "info");
  const information = project.issues.filter((issue) => !issue.resolvedAt && issue.severity === "info");
  const resolved = project.issues.filter((issue) => issue.resolvedAt);
  async function share(event: FormEvent) {
    event.preventDefault();
    if (!filePath.trim()) return;
    const result = await action(
      "release",
      () =>
        api.exportRelease({
          projectId: project.id,
          filePath: filePath.trim(),
          buildId: latest?.id,
        }),
      "分享包已生成",
    );
    if (result) {
      setLastExport({ projectId: project.id, path: result.path });
      setArchive(false);
    }
  }
  async function runBuild() {
    const result = await action(
      "build",
      () =>
        api.buildProject({
          projectId: project.id,
          outputParent: outputDir.trim() || undefined,
        }),
      "游戏文件已生成，请查看成品检查",
    );
    const report = completionFrom(result);
    if (report) setCompletion({ projectId: project.id, value: report });
  }
  async function clean() {
    const result = await action(
      "cleanup",
      () => api.cleanupProject({ projectId: project.id }),
      "清理操作已完成",
    );
    if (result) setCleanup(false);
  }
  async function exportMobile() {
    if (!latest || busy) return;
    const projectId = project.id;
    const path = await action("choose-mobile-release", () => api.chooseSaveFile({
      title: "导出 JoiPlay 游玩包",
      defaultPath: joiplayArchivePath(project.name, latest.path),
      kind: "rga",
    }));
    if (!path || currentProjectId.current !== projectId) return;
    const result = await action("mobile-release", () => api.exportRelease({
      projectId,
      buildId: latest.id,
      filePath: path,
      target: "joiplay",
    }), "JoiPlay 游玩包已生成，使用步骤与兼容性检查结果已放入包内。");
    if (result && currentProjectId.current === projectId)
      setLastExport({ projectId, path: result.path, target: "joiplay", warnings: result.warnings });
  }
  return (
    <>
      <Heading
        title="成品与导出"
        description="生成独立游戏，整理公开分享所需的文件。"
      >
        <Button
          variant="primary"
          busy={busy === "build"}
          disabled={
            Boolean(busy) ||
            project.total === 0 ||
            project.status === "preparing" ||
            project.status === "running"
          }
          onClick={() => void runBuild()}
        >
          <Package size={17} />
          生成汉化版
        </Button>
      </Heading>
      <section className="panel">
        <div className="panel-heading">
          <h2>成品目录</h2>
          <div className="button-row">
            <span className="tag gold">{!latest ? "尚未生成" : latest.launchPath ? "已找到启动入口" : "启动入口待确认"}</span>
            <Button
              disabled={
                Boolean(busy) || project.status === "preparing" || project.status === "running"
              }
              onClick={() => setCleanup(true)}
            >
              <Trash2 size={16} />
              清理旧成品与缓存
            </Button>
          </div>
        </div>
        <PathField
          label="本次成品保存位置（可选）"
          value={outputDir}
          onChange={setOutputDir}
          placeholder="在此位置新建“游戏名-汉化版”文件夹；默认在工程旁边"
          onError={onError}
        />
        {latest ? (
          <>
            <div className="build-summary">
              <div>
                <strong>已更新 {latest.changed.toLocaleString()} 条文字</strong>
                <p className="path-text">{latest.path}</p>
                <small>
                  {new Date(latest.createdAt).toLocaleString("zh-CN")}
                </small>
              </div>
              <div className="button-row">
                <Button
                  onClick={() =>
                    void action("open-build", () =>
                      api.openPath({ path: latest.path }),
                    )
                  }
                >
                  <FolderOpen size={16} />
                  打开目录
                </Button>
                {latest.launchPath && (
                  <Button
                    variant="primary"
                    onClick={() =>
                      void action("launch", () =>
                        api.launchGame({
                          projectId: project.id,
                          buildId: latest.id,
                        }),
                      )
                    }
                  >
                    <Play size={16} />
                    启动游戏
                  </Button>
                )}
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setFilePath(releaseArchivePath(project.name, latest.path));
                    setArchive(true);
                  }}
                >
                  <FileArchive size={16} />
                  导出分享 ZIP
                </Button>
                {["MV", "MZ"].includes(project.engine.toUpperCase()) && (
                  <Button
                    busy={busy === "mobile-release" || busy === "choose-mobile-release"}
                    disabled={Boolean(busy)}
                    onClick={() => void exportMobile()}
                  >
                    <Smartphone size={16} />
                    导出 JoiPlay 游玩包
                  </Button>
                )}
              </div>
            </div>
            <Checks build={latest} />
            {!latest.launchPath && <p className="muted">本次保存的是游戏资源或源码副本，启动入口待确认。点击“打开目录”查看输出文件。</p>}
            {lastExport?.projectId === project.id && (
              <div className="build-summary">
                <div>
                  <strong>{lastExport.target === "joiplay" ? "JoiPlay 游玩包已生成" : "分享 ZIP 已生成"}</strong>
                  <p className="path-text">{lastExport.path}</p>
                  {lastExport.target === "joiplay" && <p className="muted">在手机上用 JoiPlay 导入这个 RGA 文件。包内附有使用步骤与兼容性检查结果。</p>}
                  {lastExport.warnings?.map((warning, index) => <p className="muted" key={index}>{warning}</p>)}
                </div>
                {nativeDesktop && (
                  <Button onClick={() =>
                    void action("locate-release", () => api.revealPath({ path: lastExport.path }))
                  }>
                    <FolderOpen size={16} />
                    在文件夹中显示
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="muted spaced">
            文字准备好后，点击“生成汉化版”创建第一个独立成品。
          </p>
        )}
      </section>
      {completion?.projectId === project.id && (
        <CompletionCard projectId={project.id} completion={completion.value} needsAdaptation={project.coverage?.needsAdaptation || project.coverage?.stale} />
      )}
      {completionLoad.loading && <p className="muted" role="status">正在读取当前文字检查清单…</p>}
      {completionLoad.error && <p className="muted" role="alert">文字检查清单读取失败：{completionLoad.error}。重新打开此页可再次读取。</p>}
      <section className="panel">
        <div className="panel-heading">
          <h2>处理摘要</h2>
          <div className="button-row">
            <span className="tag">{outstanding.length} 项待处理</span>
            {(project.adaptationAvailable && project.coverage?.needsAdaptation || canCheckOmissions(project)) && (
              <Button
                busy={busy === "retry-adaptation"}
                disabled={Boolean(busy) || project.status === "preparing" || project.status === "running"}
                onClick={() => void action("retry-adaptation", () => api.retryAdaptation({ projectId: project.id }))}
              >
                <RefreshCw size={16} />{canCheckOmissions(project) ? "检查遗漏文字" : "提取剩余文字"}
              </Button>
            )}
          </div>
        </div>
        {outstanding.length ? (
          <IssueList issues={outstanding} />
        ) : (
          <p className="muted spaced">当前待处理事项：0 项。</p>
        )}
        {information.length > 0 && (
          <details className="checks">
            <summary>处理说明 <span>{information.length} 项</span></summary>
            <IssueList issues={information} />
          </details>
        )}
        {resolved.length > 0 && (
          <details className="checks">
            <summary>
              已解决记录 <span>{resolved.length} 项</span>
            </summary>
            <IssueList issues={resolved} />
          </details>
        )}
      </section>
      {project.builds.length > 1 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>历史成品</h2>
          </div>
          {project.builds
            .slice(0, -1)
            .reverse()
            .map((build) => (
              <div className="history-row" key={build.id}>
                <div>
                  <strong>
                    {new Date(build.createdAt).toLocaleString("zh-CN")}
                  </strong>
                  <p className="path-text">{build.path}</p>
                </div>
                <Button
                  onClick={() =>
                    void action("open-history", () =>
                      api.openPath({ path: build.path }),
                    )
                  }
                >
                  打开
                </Button>
              </div>
            ))}
        </section>
      )}
      {archive && (
        <Modal
          title="导出分享 ZIP"
          error={error}
          onClose={() => setArchive(false)}
          busy={busy === "release"}
        >
          <form onSubmit={(event) => void share(event)}>
            <p className="dialog-intro">
              将游戏成品、使用说明和所需许可证打包成 ZIP，方便发送给其他玩家。
            </p>
            <PathField
              label="分享 ZIP 保存位置"
              kind="save"
              value={filePath}
              onChange={setFilePath}
              onError={onError}
            />
            <div className="dialog-actions">
              <Button
                onClick={() => setArchive(false)}
                disabled={Boolean(busy)}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={busy === "release"}
                disabled={!filePath.trim()}
              >
                导出分享 ZIP
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {cleanup && (
        <Modal
          title="清理旧成品与缓存"
          error={error}
          onClose={() => setCleanup(false)}
          busy={busy === "cleanup"}
        >
          <p className="dialog-intro">
            清理可删除的旧成品和临时缓存。最新成品、译文工作台和检测到的存档继续保留。
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setCleanup(false)} disabled={Boolean(busy)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void clean()} busy={busy === "cleanup"}>
              确认清理
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Checks({ build }: { build: Build }) {
  return (
    <details className="checks" open>
      <summary>
        成品检查 <span>{build.checks.length} 项记录</span>
      </summary>
      {build.checks.map((check, index) => (
        <div className="check-row" key={`${check.name}-${index}`}>
          <span className={`check-state ${check.status}`}>
            {check.status === "passed" ||
            check.status === "pass" ||
            check.status === "ok" ? (
              <Check size={16} />
            ) : (
              <CircleAlert size={16} />
            )}
          </span>
          <div>
            <strong>{check.name}</strong>
            {check.detail && <p>{check.detail}</p>}
          </div>
          <small>{checkStatuses[check.status] || "查看检查说明"}</small>
        </div>
      ))}
    </details>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <div className="issue-list">
      {issues.map((issue) => (
        <div
          key={issue.id}
          className={`issue ${issue.resolvedAt ? "resolved" : issue.severity}`}
        >
          {issue.resolvedAt ? <Check size={17} /> : <CircleAlert size={17} />}
          <div>
            <strong>{issueCategories[issue.category] || "其他处理记录"}</strong>
            <p>{errorMessage(issue.message)}</p>
            {issue.unitId && <code>{issue.unitId}</code>}
            {issue.resolvedAt && (
              <small className="muted">
                已解决 · {new Date(issue.resolvedAt).toLocaleString("zh-CN")}
              </small>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
