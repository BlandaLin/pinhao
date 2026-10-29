import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ProgressInfo, RuntimeInfo } from "../../../src/status";
import type {
  DesktopApi,
  ProjectDetail,
  Settings,
  Snapshot,
} from "../../../../../packages/contracts/index";

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait();
  }
  throw new Error("Onboarding fixture timed out");
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const connection = { baseUrl: "http://localhost:1/v1", model: "fixture" };
const settings: Settings = {
  connection,
  roles: {
    technical: { useShared: true, connection },
    translation: { useShared: true, connection },
    proofreading: { useShared: true, connection },
  },
  concurrency: 3,
  pauseOnLocalFailure: false,
  processImages: false,
  proofreading: true,
  targetLanguage: "简体中文",
  fontPath: "",
};
let workspace: Promise<Snapshot>;
let currentProject: ProjectDetail | undefined;
let releaseWorkspace: (() => void) | undefined;
let savedSettings: Settings | undefined;
let starts = 0;
let availableStarts = 0;
let adaptationRetries = 0;
let executionChanges: { projectId: string; granted: boolean }[] = [];
let testedRoles: string[] = [];
let workspaceChanged: (() => void) | undefined;
let snapshotReads = 0;
let detailReads = 0;
let selectedWorkspaceDir: string | null = null;
let reconnectCalls: string[] = [];
let reconnectFailure = "";
window.pinhao = {
  snapshot: () => { snapshotReads++; return workspace; },
  getProject: async () => { detailReads++; return currentProject!; },
  listText: async () => ({ units: [], total: 0 }),
  startProject: async () => { starts++; return currentProject!; },
  continueAvailableText: async () => {
    availableStarts++;
    currentProject = { ...currentProject!, adaptationPending: false, adaptationAvailable: true, adaptationDeferred: true, lastError: undefined, status: "running", stage: "翻译已验证文字" };
    return currentProject;
  },
  retryAdaptation: async () => {
    adaptationRetries++;
    currentProject = { ...currentProject!, adaptationPending: true, adaptationDeferred: false, status: "running", stage: "提取剩余文字" };
    return currentProject;
  },
  setWorkspaceExecution: async input => {
    executionChanges.push(input);
    currentProject = { ...currentProject!, workspaceExecution: { granted: input.granted, mode: "current-user" }, updatedAt: `execution-${executionChanges.length}` };
    workspace = Promise.resolve({ projects: [currentProject], settings, engines: [], fonts: [] });
    return currentProject;
  },
  saveSettings: async (value) => { savedSettings = value; return value; },
  testConnection: async (input) => { testedRoles.push(input.role || "default"); return { ok: true, message: "连接测试通过" }; },
  chooseDirectory: async () => selectedWorkspaceDir,
  reconnectProject: async ({ workspaceDir }) => {
    reconnectCalls.push(workspaceDir);
    if (reconnectFailure) throw new Error(reconnectFailure);
    currentProject = { ...project("paused"), workspaceDir };
    workspace = Promise.resolve({ projects: [currentProject], settings, engines: [], fonts: [] });
    return currentProject;
  },
  onChanged: callback => { workspaceChanged = callback; return () => { workspaceChanged = undefined; }; },
} as DesktopApi;
const { default: App } = await import("../../../src/App");
const container = document.createElement("div");
document.body.append(container);
let root: Root | undefined;
const welcomeKey = "pinhao.welcome.v1";

function project(status: ProjectDetail["status"]): ProjectDetail & { progress: ProgressInfo; runtime?: RuntimeInfo } {
  const proofread = status === "running" ? 4 : status === "completed" ? 10 : 0;
  const translated = 10 - proofread;
  return {
    id: "neutral-project",
    name: "中性测试游戏",
    gameDir: "fixture/game",
    workspaceDir: "fixture/workspace",
    engine: "mv",
    status,
    stage: status === "running" ? "校对场景 2 / 5" : "本轮制作完成",
    total: 10,
    done: 10,
    skipped: 0,
    translated,
    proofread,
    pending: 0,
    progress: { total: 10, counted: 10, done: 10, remaining: 0, percent: 100, throughput: null,
      etaMs: null, etaAt: null, confidence: "none", phases: { pending: 0, translated, proofread, skipped: 0 },
      blockers: [], paused: status === "paused", finished: status === "completed",
      phaseLabel: status === "running" ? "正在校对场景" : "译文已齐，继续后续制作", runtime: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    issues: [],
    tasks: [],
    builds: status === "completed" ? [{
      id: "neutral-build",
      path: "fixture/output",
      launchPath: "fixture/output/Game.exe",
      createdAt: "2026-01-01T00:00:00.000Z",
      changed: 10,
      checks: [],
    }] : [],
  };
}
async function mount(options: {
  deferred?: boolean;
  project?: ProjectDetail;
} = {}) {
  if (root) flushSync(() => root!.unmount());
  currentProject = options.project;
  savedSettings = undefined;
  starts = 0;
  availableStarts = 0;
  adaptationRetries = 0;
  executionChanges = [];
  testedRoles = [];
  selectedWorkspaceDir = null;
  reconnectCalls = [];
  reconnectFailure = "";
  snapshotReads = 0;
  detailReads = 0;
  const snapshot: Snapshot = {
    projects: currentProject ? [currentProject] : [],
    settings,
    engines: [],
    fonts: [],
  };
  workspace = options.deferred
    ? new Promise((resolve) => {
        releaseWorkspace = () => resolve(snapshot);
      })
    : Promise.resolve(snapshot);
  root = createRoot(container);
  flushSync(() => root!.render(<App />));
  await wait();
  if (!options.deferred) {
    await until(() => !document.querySelector(".loading-state"));
    if (currentProject) await until(() => document.querySelector(".overview-hero"));
  }
}
function button(text: string) {
  const result = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  assert(result, `Missing button: ${text}`);
  return result;
}
function guide() {
  return document.querySelector<HTMLDialogElement>("dialog[open]");
}
function accessibleName(element: Element) {
  return element.getAttribute("aria-label") ||
    element.getAttribute("aria-labelledby")?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
}

export async function runOnboardingChecks() {
  const cases = [
    ["existing project opening selects the project without starting paid work", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount();
      button("游戏项目").click();
      await until(() => document.querySelector(".page-heading h1")?.textContent === "游戏项目" || [...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "打开已有工程"));
      selectedWorkspaceDir = "fixture/existing-project";
      button("打开已有工程").click();
      await until(() => document.querySelector(".overview-hero"));
      assert(reconnectCalls.length === 1 && reconnectCalls[0] === selectedWorkspaceDir, "The selected existing project was not reconnected");
      assert(starts === 0 && availableStarts === 0 && testedRoles.length === 0, "Opening an existing project must not start model work");
      assert(document.body.textContent?.includes("工程已打开") && document.body.textContent?.includes("点击“继续制作”后调用模型"), "Reopening must explain explicit continuation without starting paid work");
    }],
    ["cancelling existing project selection has no effect and failed opening reports the reason", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount();
      button("游戏项目").click();
      await until(() => [...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "打开已有工程"));
      button("打开已有工程").click(); await wait(50);
      assert(reconnectCalls.length === 0, "Cancelling the folder picker must not reconnect anything");
      selectedWorkspaceDir = "fixture/moved-project";
      reconnectFailure = "工程位置已改变，请先放回原路径";
      button("打开已有工程").click();
      await until(() => document.body.textContent?.includes(reconnectFailure));
      assert(!document.querySelector(".overview-hero"), "A rejected moved project must not appear open");
    }],
    ["workspace script execution requires an explicit project grant and can be revoked while paused", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.workspaceExecution = { granted: false, mode: "current-user" };
      await mount({ project: detail });
      assert(executionChanges.length === 0, "Opening a project must not grant script execution");
      const section = [...document.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("技术脚本执行"));
      assert(section, "The project execution control is missing"); section.open = true;
      button("允许本项目运行技术脚本").click();
      await until(guide);
      assert(guide()?.textContent?.includes("当前 Windows 用户的文件与网络权限"), "The permission dialog must describe actual user-level access");
      assert(guide()?.textContent?.includes("API 密钥"), "The permission dialog must describe secret handling");
      button("继续使用内置工具").click(); await until(() => !guide());
      assert(executionChanges.length === 0, "Declining must leave the project ungranted");
      button("允许本项目运行技术脚本").click(); await until(guide);
      button("授权并启用").click();
      await until(() => executionChanges.length === 1 && !guide());
      assert(executionChanges[0].projectId === detail.id && executionChanges[0].granted, "The grant must apply only to the selected project");
      await until(() => [...document.querySelectorAll("button")].some(item => item.textContent === "撤销脚本执行授权"));
      button("撤销脚本执行授权").click(); await until(() => executionChanges.length === 2);
      assert(!executionChanges[1].granted, "The project grant must support explicit revocation");
    }],
    ["active projects keep revocation behind pause and show the current consistency text scope", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.workspaceExecution = { granted: true, mode: "current-user" };
      detail.reviewRound = { id: "review-1", stage: "consistency", total: 40, candidates: 3,
        progress: { total: 8, reviewed: 4, skipped: 1 } };
      await mount({ project: detail });
      assert(button("撤销脚本执行授权").disabled, "Active script execution must be paused before revocation");
      const status = document.querySelector(".overview-hero .status-progress");
      assert(status?.textContent?.includes("译名与疑点复核"), "Only targeted remaining review work should be named here");
      assert(status.textContent.includes("已审阅 4 / 8 条") && status.textContent.includes("50.0%"), "Consistency must use its own unique text scope, not forty round targets or three tasks");
      assert(status.textContent.includes("收尾后更新译文") && status.textContent.includes("本阶段跳过 1 条"), "Saved candidates and skipped text must be explicit");
    }],
    ["bursty task updates refresh the completed state with bounded workspace reads", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount({ project: project("running") });
      await wait(550);
      const beforeSnapshots = snapshotReads, beforeDetails = detailReads;
      currentProject = project("completed");
      workspace = Promise.resolve({ projects: [currentProject], settings, engines: [], fonts: [] });
      for (let index = 0; index < 100; index++) workspaceChanged?.();
      await until(() => document.querySelector(".overview-hero h2")?.textContent === "本轮制作完成");
      await wait(550);
      assert(snapshotReads - beforeSnapshots <= 2, "Progress bursts dispatched repeated workspace reads");
      assert(detailReads - beforeDetails <= 2, "Progress bursts dispatched repeated project-detail reads");
    }],
    ["initial workspace loading has a spinner before the tutorial", async () => {
      localStorage.removeItem(welcomeKey);
      await mount({ deferred: true });
      const loading = [...document.querySelectorAll('[role="status"]')].find(
        (element) => element.textContent?.includes("正在连接工作空间"),
      );
      assert(loading, "Workspace loading status is missing");
      assert(loading.querySelector(".spin"), "Loading status needs a spinner");
      assert(!guide(), "The tutorial opened before workspace loading finished");
      releaseWorkspace!();
      await until(guide);
    }],
    ["first launch opens a named tutorial with the complete workflow", async () => {
      localStorage.removeItem(welcomeKey);
      await mount();
      await until(guide);
      assert(accessibleName(guide()!) === "欢迎使用拼好汉化", "Tutorial needs an accessible dialog name");
      assert(document.querySelectorAll(".welcome-steps li").length === 4, "Tutorial must show all four workflow steps");
      assert(button("配置模型"), "Tutorial should link directly to configuration");
    }],
    ["closing the tutorial is remembered and its help entry reopens it", async () => {
      localStorage.removeItem(welcomeKey);
      await mount();
      await until(guide);
      button("先看看界面").click();
      await until(() => !guide());
      await mount();
      assert(!guide(), "A dismissed first-launch tutorial reopened after remount");
      button("使用教程").click();
      await until(guide);
      assert(accessibleName(guide()!) === "欢迎使用拼好汉化", "Help reopened the wrong dialog");
    }],
    ["tutorial configuration action opens settings and remembers onboarding", async () => {
      localStorage.removeItem(welcomeKey);
      await mount();
      await until(guide);
      button("配置模型").click();
      await until(() => document.querySelector("#settings-form"));
      assert(!guide(), "Tutorial remained open over settings");
      assert(document.querySelector('[aria-label="设置"]')?.getAttribute("aria-current") === "page", "Configuration action did not select settings");
      await mount();
      assert(!guide(), "Configuration action did not remember onboarding");
    }],
    ["running projects show their actual stage and progress while waiting", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.proofread = 0;
      detail.translated = 10;
      detail.reviewRound = { id: "review-scene", stage: "scene", total: 10, candidates: 1,
        progress: { total: 10, reviewed: 4, skipped: 0 } };
      await mount({ project: detail });
      const footer = document.querySelector(".workspace-status");
      assert(footer?.textContent?.includes("中性测试游戏 · 校对场景 2 / 5"), "Footer does not show the current project stage");
      assert(footer.querySelector(".spin"), "Running project needs a visible activity indicator");
      const progress = document.querySelector('.overview-hero [role="progressbar"]');
      assert(progress?.getAttribute("aria-valuenow") === "40" && progress.getAttribute("aria-valuemax") === "100", "Saved scene review must be visible in the hero even while formal proofread remains zero");
      assert(document.querySelectorAll('[role="progressbar"]').length === 1, "The overview must not repeat the same bar below the fold");
      assert(document.querySelector(".status-progress-line")?.textContent?.includes("已审阅 4 / 10 条"), "Review progress must count saved text, not initial translation");
      assert(document.querySelector(".status-progress-meta")?.textContent?.includes("场景校对"), "Full text coverage must retain the unfinished review phase");
      assert(document.querySelector(".status-progress-note")?.textContent?.includes("收尾后更新译文"), "Scene review must explain that formal translations update after final checks");
      assert(button("暂停制作"), "Running project should retain its pause action");
    }],
    ["review pause and resume retain saved progress while commit stays a separate stage", async () => {
      localStorage.setItem(welcomeKey, "seen");
      for (const status of ["paused", "running"] as const) {
        const detail = project(status);
        detail.reviewRound = { id: "review-resume", stage: "scene", progress: { total: 10, reviewed: 4, skipped: 0 } };
        await mount({ project: detail });
        assert(document.querySelector('.overview-hero [role="progressbar"]')?.getAttribute("aria-valuenow") === "40", "Pause or resume reset saved review progress");
        assert(document.querySelector(".status-progress-meta")?.textContent?.includes(status === "paused" ? "校对已暂停" : "场景校对"), "The current review state is missing");
      }
      for (const stage of ["commit", "committed"]) {
        const detail = project("running");
        detail.reviewRound = { id: "review-resume", stage, committedAt: stage === "committed" ? "2026-10-25T12:00:00Z" : undefined,
          progress: { total: 10, reviewed: 10, skipped: 0 } };
        await mount({ project: detail });
        const progress = document.querySelector(".overview-hero .status-progress");
        assert(progress?.textContent?.includes(stage === "commit" ? "保存校对结果" : "校对已完成"), "Review finalization must have a distinct readable stage");
        assert(!progress.querySelector('[role="progressbar"]') && !progress.textContent.includes("本轮制作完成"), "Review finalization must not masquerade as whole-production 100%");
      }
    }],
    ["bounded task summaries retain the complete task count", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.taskTotal = 120;
      detail.tasks = Array.from({ length: 8 }, (_, index) => ({
        id: `recent-task-${index}`, role: "translation", status: "completed",
        attempts: 1, unitIds: [`recent-unit-${index}`],
      }));
      await mount({ project: detail });
      assert(document.body.textContent?.includes("120 个制作任务"), "A bounded summary displayed only the recent task count");
      assert(document.querySelectorAll(".task-row").length === 8, "The overview must retain its recent task rows");
    }],
    ["running replies show checkpoint progress separately from committed text", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.done = detail.translated = 2;
      detail.proofread = 0;
      detail.pending = 8;
      detail.progress = { ...detail.progress, done: 2, remaining: 8, percent: 20,
        phases: { pending: 8, translated: 2, proofread: 0, skipped: 0 }, phaseLabel: "正在翻译" };
      detail.tasks = [{
        id: "receiving-task", role: "translation", status: "running", attempts: 1,
        unitIds: Array.from({ length: 8 }, (_, index) => `reply-unit-${index}`),
        progress: { receivedCharacters: 1200, textCharacters: 400, reasoningCharacters: 800, checkpointed: 3, requested: 8 },
      }];
      await mount({ project: detail });
      const row = document.querySelector(".task-row");
      assert(row?.textContent?.includes("已收到正文 400 字") && row.textContent.includes("推理 800 字"), "Running task should distinguish final and reasoning characters");
      assert(!row.textContent.includes(`已收到正文 ${(1200).toLocaleString()}`), "Reasoning must not inflate received final text");
      assert(row.textContent.includes("本批回复已保存 3/8 条"), "Running task should identify saved replies as batch checkpoints");
      const progress = document.querySelector('[role="progressbar"]');
      assert(progress?.getAttribute("aria-valuenow") === "20" && progress.getAttribute("aria-valuemax") === "100", "Only two of ten accepted translations count toward coverage, not three saved reply checkpoints");
      assert(document.querySelector(".status-progress-line")?.textContent?.includes("已有译文 2 / 10"), "The accepted count must remain distinct from the saved batch reply count");
      const phase = [...document.querySelectorAll(".panel h2")].find(item => item.textContent === "分阶段制作")?.closest("section");
      assert(phase?.textContent?.includes("已翻译 2") && phase.textContent.includes("已校对 0"), "Checkpoint replies must not change translation or proofreading totals");
    }],
    ["paused replies retain checkpoint progress alongside the task error", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.stage = "文字任务已暂停";
      detail.tasks = [{
        id: "paused-reply-task", role: "translation", status: "paused", attempts: 2,
        unitIds: ["paused-unit-1", "paused-unit-2", "paused-unit-3", "paused-unit-4"],
        error: "fixture model connection interrupted",
        progress: JSON.parse('{"receivedCharacters":900,"textCharacters":null,"reasoningCharacters":null,"checkpointed":1,"requested":4}'),
      }];
      await mount({ project: detail });
      const row = document.querySelector(".task-row");
      assert(row?.textContent?.includes("fixture model connection interrupted"), "Paused task error should remain visible");
      assert(row.textContent.includes(`已收到回复片段 ${(900).toLocaleString()} 字（历史记录未分项）`), "Historical counts should retain their limited meaning");
      assert(row.textContent.includes("本批回复已保存 1/4 条"), "Paused task should retain its saved batch checkpoint count");
      assert(row.querySelector(".tag")?.textContent?.trim() === "暂停", "Checkpoint progress must not change the paused task status");
    }],
    ["a completed build offers a direct route to the playable result", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount({ project: project("completed") });
      assert(!document.querySelector(".workspace-status .spin"), "A completed project still shows a running indicator");
      button("查看成品与试玩").click();
      await until(() => document.querySelector("h1")?.textContent === "成品与导出");
      assert(document.querySelector(".build-summary")?.textContent?.includes("fixture/output"), "The result action did not open the completed build");
    }],
    ["completion without a build keeps the production action available", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("completed");
      detail.builds = [];
      await mount({ project: detail });
      assert(![...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "查看成品与试玩"), "An unavailable build was presented as playable");
      assert(button("继续翻译与校对"), "Production action should remain available");
    }],
    ["technical adaptation shows resource gaps separately from completed text", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.adaptation = { status: "needs-review", attempts: 2 };
      detail.coverage = { unitCount: detail.total, completeness: "partial", summary: { extracted: 3, "display-text-candidate": 2, "script-resource": 4, "image-candidate": 1 }, needsAdaptation: true, triggers: ["suspected-omission"] };
      await mount({ project: detail });
      const coverage = document.querySelector('[aria-label="文字提取与文件检查"]');
      assert(coverage?.textContent?.includes("待检查文字的文件 2 个"), "Unresolved resource coverage should use resource units");
      assert(button("重试文字提取"), "A paused failed adaptation should identify its retry action");
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "查看成品与试玩"), "An adaptation gap should not offer a completed build");
    }],
    ["native component review counts remain separate from text and font hints", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.adaptationPending = detail.adaptationAvailable = detail.canContinueAvailableText = true;
      detail.adaptation = { status: "queued", totalJobs: 3, pendingJobs: 3 };
      detail.coverage = {
        unitCount: detail.total, completeness: "partial", needsAdaptation: true, triggers: ["native-schema-review"],
        summary: { extracted: 5, "display-text-candidate": 0, nativeReviewObjects: 23883, nativeReviewResources: 3, nativeReviewGroups: 6, presentationItems: 2 },
      };
      await mount({ project: detail });
      const coverage = document.querySelector('[aria-label="文字提取与文件检查"]')?.textContent ?? "";
      assert(coverage.includes("待检查文字的文件 0 个"), "Native objects must not inflate text-candidate file counts");
      assert(coverage.includes("待检查原生组件 23,883 个") && coverage.includes("涉及资源 3 个"), "Native review should identify objects and resource files separately");
      assert(coverage.includes("字体与显示提示 2 项"), "Presentation hints must remain separate from native object and resource counts");
      assert(button("继续提取文字") && !button("先处理已提取文字").disabled, "Component review must retain both adaptation and accepted-text continuation");
    }],
    ["release summary offers native review even when text-candidate files are zero", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.adaptationPending = detail.adaptationAvailable = true;
      detail.coverage = {
        unitCount: detail.total, completeness: "partial", needsAdaptation: true, triggers: ["native-schema-review"],
        summary: { "display-text-candidate": 0, nativeReviewObjects: 8, nativeReviewResources: 1 },
      };
      await mount({ project: detail });
      button("成品与导出").click();
      await until(() => document.querySelector("h1")?.textContent === "成品与导出");
      button("提取剩余文字").click();
      await until(() => adaptationRetries === 1);
      assert(starts === 0, "Native review should use scoped adaptation rather than restart translation");
    }],
    ["font hints and informational records stay out of unresolved issue counts", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.coverage = {
        unitCount: detail.total, completeness: "partial", needsAdaptation: false, triggers: [],
        summary: { extracted: 2, nativeReviewObjects: 0, presentationItems: 2 },
      };
      detail.issues = [{ id: "font-note", category: "technical-review", severity: "info", message: "两项字体提示随成品检查。", createdAt: detail.createdAt }];
      await mount({ project: detail });
      assert(document.querySelector('[aria-label="文字提取与文件检查"]')?.textContent?.includes("字体与显示提示 2 项"), "Presentation hints should remain visible");
      assert(!button("翻译待处理文字").disabled, "Font hints should retain text production");
      button("成品与导出").click();
      await until(() => document.querySelector("h1")?.textContent === "成品与导出");
      assert(document.body.textContent?.includes("0 项待处理"), "Informational records must not masquerade as unresolved faults");
      assert([...document.querySelectorAll("summary")].some(item => item.textContent?.includes("处理说明") && item.textContent?.includes("1 项")), "Information must remain available as processing notes");
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "提取剩余文字"), "Font-only information should not create a resource-adaptation action");
    }],
    ["release summary preserves warning counts alongside informational notes", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.issues = [
        { id: "note", category: "technical-review", severity: "info", message: "文件检查记录已保存。", createdAt: detail.createdAt },
        { id: "warning", category: "validation", severity: "warning", message: "一条译文的占位符需要检查。", createdAt: detail.createdAt },
        { id: "resolved", category: "validation", severity: "error", message: "已修复的历史记录。", createdAt: detail.createdAt, resolvedAt: detail.updatedAt },
      ];
      await mount({ project: detail });
      button("成品与导出").click();
      await until(() => document.querySelector("h1")?.textContent === "成品与导出");
      assert(document.body.textContent?.includes("1 项待处理"), "Warnings should remain actionable alongside informational records");
      assert(document.body.textContent?.includes("已解决记录"), "Resolved issue history should remain available");
    }],
    ["post-translation name checks show disagreements in the text phase rather than technical preparation", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.glossaryProgress = { completed: 12, total: 40, conflicts: 28 };
      detail.done = detail.translated = detail.proofread = 0;
      detail.pending = 10;
      detail.progress = { ...detail.progress, done: 0, remaining: 10, percent: 0,
        phases: { pending: 10, translated: 0, proofread: 0, skipped: 0 }, phaseLabel: "正在翻译" };
      await mount({ project: detail });
      assert(!document.querySelector('[aria-label="译名检查"]'), "Name checks must not become a billable preparation stage before any translation exists");
      detail.done = detail.translated = 10;
      detail.pending = 0;
      detail.progress = { ...detail.progress, done: 10, remaining: 0, percent: 100,
        phases: { pending: 0, translated: 10, proofread: 0, skipped: 0 } };
      await mount({ project: detail });
      const summary = document.querySelector('[aria-label="译名检查"]');
      assert(summary?.textContent?.includes("40 项，28 项待校对"), "Name checks must distinguish derived terminology from unresolved disagreements");
      assert(summary.closest("section")?.querySelector("h2")?.textContent === "分阶段制作", "Name checks belong beside text translation and proofreading");
      assert(!document.querySelector('[aria-label="文字提取与文件检查"]')?.contains(summary), "Name checks must not be presented as technical extraction progress");
    }],
    ["parallel technical progress separates processed resources from authoritative runtime concurrency", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("running");
      detail.adaptationPending = true;
      detail.runtime = { active: 2, limit: 3, queued: 1, running: 2 };
      detail.adaptation = { status: "running", workers: 2, completedJobs: 1, totalJobs: 3, jobs: [
        { id: "resource-a", resource: "scripts/menu.gd", status: "running", tool: "write_text_adapter", phase: "running" },
        { id: "resource-b", resource: "data/story.json", status: "running", tool: "model_step", phase: "requesting" },
      ] };
      await mount({ project: detail });
      const text = document.querySelector('[aria-label="文字提取与文件检查"]')?.textContent ?? "";
      assert(text.includes("已处理 1 / 3 项") && !text.includes("已完成 3"), "Processed resources must not count active work as verified results");
      assert(text.includes("正在检查游戏文件并处理文字提取问题"), "Technical work must retain its current stage");
      assert(document.querySelector(".status-progress")?.textContent?.includes("2 / 3 并发 · 队列 1"), "Concurrency comes from runtime active/limit/queued, not the number of rendered job rows");
    }],
    ["processed adaptation jobs retain verified, pending and real output evidence", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.lastError = "资源验证仍有缺口";
      detail.adaptation = {
        status: "needs-review", processedJobs: 20, totalJobs: 20, verifiedJobs: 15, pendingJobs: 5,
        addedUnits: 28, integratedUnits: 60, remainingCandidates: 99, retryable: true,
        stopReason: "五个资源仍需完成改文验证",
        jobs: [{ id: "pending-resource", resource: "data/neutral.json", status: "needs-review", reason: "改文回读校验待完成" }],
      };
      await mount({ project: detail });
      const progress = document.querySelector('[aria-label="文字提取与文件检查"]')?.textContent ?? "";
      assert(progress.includes("已处理 20 / 20 项") && progress.includes("通过 15 项") && progress.includes("待处理 5 项"), "Terminal processing must retain separate success and pending counts");
      assert(!progress.includes("已完成 20"), "Processed jobs must not be presented as successful jobs");
      const hero = document.querySelector(".overview-hero")?.textContent ?? "";
      assert(hero.includes("本次新增文字 28 条") && hero.includes("累计补充文字 60 条") && hero.includes("待甄别候选 99 项"), "First-screen output evidence should distinguish new and integrated text");
      assert(hero.includes("候选通过文字与回写检查后加入工作台"), "Unverified candidates must stay distinct from accepted workbench text");
      assert(hero.includes("五个资源仍需完成改文验证"), "The primary action should show the actual stop reason");
      assert(progress.includes("data/neutral.json") && progress.includes("改文回读校验待完成"), "Pending resources must retain their validation reason");
      assert(button("重试文字提取"), "A failed subset should have a scoped retry action");
    }],
    ["an adaptation round with no added or integrated text output is explicit", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.adaptation = {
        status: "needs-review", processedJobs: 20, totalJobs: 20, verifiedJobs: 0, pendingJobs: 20,
        addedUnits: 0, integratedUnits: 0, remainingCandidates: 958, retryable: true,
      };
      await mount({ project: detail });
      const text = document.querySelector('[aria-label="文字提取与文件检查"]')?.textContent ?? "";
      assert(text.includes("已处理 20 / 20 项") && text.includes("通过 0 项") && text.includes("待处理 20 项"), "An unsuccessful round must not imply completion");
      const outcome = document.querySelector(".technical-outcome")?.textContent ?? "";
      assert(outcome.includes("本次新增文字 0 条 · 累计补充文字 0 条 · 待甄别候选 958 项"), "Zero text output must remain visible");
      assert(outcome.includes("候选通过文字与回写检查后加入工作台"), "Candidate counts must not imply workbench delivery");
    }],
    ["blocked repeated adaptation routes to model settings instead of restarting", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.adaptation = {
        status: "needs-review", processedJobs: 20, totalJobs: 20, verifiedJobs: 0, pendingJobs: 20,
        blocked: true, retryable: false, stopReasonCode: "MODEL_CAPACITY_REQUIRED", stopReason: "模型上下文容量不足",
      };
      await mount({ project: detail });
      const hero = document.querySelector(".overview-hero")?.textContent ?? "";
      assert(hero.includes("模型上下文容量不足") && hero.includes("检查模型设置，保存后重试"), "A model-capacity blocker needs its reason and a matching settings action");
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "重试文字提取"), "A blocked round should not expose another identical retry");
      for (const label of ["翻译待处理文字", "校对当前译文", "重试问题文字"]) {
        assert(button(label).disabled, "Text phase actions should wait for resource adaptation");
      }
      button("检查模型设置").click();
      await until(() => document.querySelector("#settings-form"));
      assert(starts === 0, "Changing a blocked model must not launch adaptation");
    }],
    ["remaining unattempted adaptation has a distinct continuation action", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.adaptation = { status: "cancelled", continuationNeeded: true, retryable: true, processedJobs: 2, totalJobs: 20, verifiedJobs: 2, resolvedJobs: 1, pendingJobs: 17 };
      await mount({ project: detail });
      assert(button("继续提取文字"), "Unattempted resources should use continuation rather than failure retry");
      assert(document.querySelector(".technical-progress")?.textContent?.includes("已核对 1 项"), "Resolved previous resources should remain distinct from verified adapters");
    }],
    ["changed retry conditions separate current readiness from the previous stop cause", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.stage = "技术适配待处理";
      detail.adaptation = {
        status: "needs-review", blocked: false, retryable: true, retryContextChanged: true,
        reason: "部分文件的文字写入检查待完成", stopReason: "repair-limit",
      };
      await mount({ project: detail });
      const notice = document.querySelector(".technical-stop");
      assert(notice?.classList.contains("technical-ready") && !notice.classList.contains("error"), "A fresh retry opportunity uses the ready appearance");
      assert(notice.querySelector("strong")?.textContent === "可以继续提取文字", "The heading should describe the current action state");
      assert(notice.querySelector("details summary")?.textContent === "上次暂停原因", "Historical evidence has its own label");
      assert(notice.querySelector("details p")?.textContent === detail.adaptation.reason, "The actual previous cause remains intact");
      assert(!notice.textContent?.includes("技术模型设置已更新") && !notice.textContent?.includes("本轮适配停因"), "Readiness should not claim that the user changed a model or repeat opaque copy");
      assert(document.querySelector(".overview-hero h2")?.textContent === "文字提取待继续", "Stored internal stages should have readable labels");
      button("继续提取文字").click();
      await until(() => adaptationRetries === 1);
      assert(starts === 0, "Technical continuation must use the scoped extraction API rather than restart production");
    }],
    ["a user-paused extraction has a neutral status with a matching resume action", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = true;
      detail.adaptation = { status: "cancelled", stopReason: "cancelled", continuationNeeded: true, retryable: true };
      await mount({ project: detail });
      const notice = document.querySelector(".technical-stop");
      assert(notice?.classList.contains("technical-ready") && !notice.classList.contains("error"), "Intentional pause is not displayed as an error");
      assert(notice.textContent?.includes("进度已保存") && notice.textContent.includes("继续提取文字"), "The notice should explain saved progress and the next button");
      assert(button("继续提取文字"), "The next action should match the instruction");
    }],
    ["project deletion explains text history loss independently of cache removal", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount({ project: project("paused") });
      button("删除项目").click();
      await until(() => Boolean(guide()));
      const text = guide()?.textContent ?? "";
      assert(text.includes("项目记录、译文、备注和修订") && text.includes("保留原游戏、成品和存档") && text.includes("先停止任务"), "The initial deletion explanation should name both deleted and retained data");
      const option = guide()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert(option && !option.checked && text.includes("同时清理工作目录"), "Removing cached files remains a separate, initially unchecked choice");
      button("取消").click();
    }],
    ["release labels identify the ZIP and JoiPlay targets directly", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount({ project: project("completed") });
      button("成品与导出").click();
      await until(() => Boolean(document.querySelector(".build-summary")));
      assert(button("导出分享 ZIP") && button("导出 JoiPlay 游玩包"), "Each export should name its actual file or player target");
      assert(document.querySelector(".build-summary strong")?.textContent?.includes("条文字"), "The output count should describe game text rather than internal write-back jargon");
      assert(document.querySelector("main")?.textContent?.includes("已找到启动入口"), "Finding an executable is not proof that a game is playable");
      assert(!document.querySelector("main")?.textContent?.includes("可启动游戏"), "The badge must not claim runtime verification");
      assert(button("启动游戏").classList.contains("primary") && !button("导出分享 ZIP").classList.contains("primary"), "Trying the product should precede sharing it");
    }],
    ["an unbuilt project identifies its output as not yet generated", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount({ project: project("ready") });
      button("成品与导出").click();
      await until(() => document.querySelector("h1")?.textContent === "成品与导出");
      assert(document.querySelector("main")?.textContent?.includes("尚未生成"), "A missing product must not look like an existing game copy");
      assert(!document.querySelector(".build-summary"), "The page must not invent an output path");
    }],
    ["an output with no identified launcher directs users to generated files", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("completed");
      detail.builds[0].launchPath = undefined;
      await mount({ project: detail });
      assert(document.querySelector(".overview-hero")?.textContent?.includes("启动程序尚未识别"), "An output with no identified launcher should explain its current state");
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "查看成品与试玩"), "Source files should not be labelled as a playable game");
      button("查看输出文件").click();
      await until(() => Boolean(document.querySelector(".build-summary")));
      assert(document.querySelector("main")?.textContent?.includes("资源或源码副本"), "The output page should identify the artifact type");
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "启动游戏"), "Launching requires an actual launch path");
    }],
    ["the shared connection test explicitly identifies the settings shown above it", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount();
      button("设置").click();
      await until(() => Boolean(document.querySelector("#settings-form")));
      button("测试已保存连接").click();
      await until(() => testedRoles.length === 1);
      assert(testedRoles[0] === "shared", "The shared control must test the shared connection rather than the translation override");
    }],
    ["validated text can continue while a blocked resource retains its evidence", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = detail.adaptationAvailable = detail.canContinueAvailableText = true;
      detail.adaptation = {
        status: "needs-review", blocked: true, retryable: false,
        reason: "scripts/menu.gd 的改文验证待完成", remainingCandidates: 6,
      };
      await mount({ project: detail });
      const available = button("先处理已提取文字");
      assert(!available.disabled, "Verified text should offer an explicit continuation action");
      const blocker = button("需要补充条件");
      assert(available.classList.contains("primary") && !blocker.classList.contains("primary") && blocker.disabled, "Available text remains primary without inventing a model-settings route for an unknown blocker");
      assert(document.querySelector("main")?.textContent?.includes("可先处理已提取文字"), "Disabled phase actions should explain the available continuation path");
      available.click();
      await until(() => Boolean(document.querySelector(".technical-deferred")));
      assert(availableStarts === 1 && starts === 0, "Continuation must use the backend validation API rather than restart adaptation");
      assert(document.querySelector(".technical-deferred")?.textContent?.includes("其余资源保留原文"), "Partial production should explain the retained resources");
      assert(document.querySelector(".technical-progress")?.textContent?.includes("scripts/menu.gd 的改文验证待完成"), "The deferred resource reason should remain available");
      assert(!document.querySelector(".technical-stop"), "Deferred coverage should not remain a production-blocking error");
    }],
    ["empty or unvalidated projects retain the resource-adaptation gate", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.total = 0;
      detail.adaptationPending = detail.adaptationAvailable = detail.canContinueAvailableText = true;
      detail.adaptation = { status: "needs-review", retryable: true };
      await mount({ project: detail });
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "先处理已提取文字"), "Empty text cannot bypass native verification");
      assert(button("翻译待处理文字").disabled, "An empty project should retain its translation gate");
      detail.total = 10;
      detail.canContinueAvailableText = false;
      await mount({ project: detail });
      assert(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "先处理已提取文字"), "Native validation eligibility must come from the backend");
    }],
    ["deferred coverage permits text stages and offers a resource-only retry", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("paused");
      detail.adaptationPending = false;
      detail.adaptationDeferred = detail.adaptationAvailable = true;
      detail.adaptation = { status: "needs-review", processedJobs: 8, totalJobs: 8, verifiedJobs: 6, pendingJobs: 2, remainingCandidates: 7, reason: "两项资源等待下一轮验证" };
      await mount({ project: detail });
      for (const label of ["翻译待处理文字", "校对当前译文", "重试问题文字"]) {
        assert(!button(label).disabled, "Deferred coverage should allow text stages to continue");
      }
      const outcome = document.querySelector(".technical-outcome")?.textContent ?? "";
      assert(outcome.includes("待甄别候选 7 项") && outcome.includes("候选通过文字与回写检查后加入工作台"), "Deferred coverage must retain its unresolved candidate count without claiming delivery");
      assert(!document.querySelector(".technical-stop"), "Deferred resource work is not a stopped text phase");
      button("提取剩余文字").click();
      await until(() => adaptationRetries === 1 && Boolean(document.querySelector(".overview-hero h2")?.textContent?.includes("提取剩余文字")));
      assert(starts === 0 && availableStarts === 0, "Resource supplementation must use its scoped API");
    }],
    ["a partial completed build retains its playable result and coverage debt", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("completed");
      detail.adaptationDeferred = detail.adaptationAvailable = true;
      detail.adaptation = { status: "needs-review", remainingCandidates: 3, reason: "图片与脚本文字保留原文" };
      await mount({ project: detail });
      assert(button("查看成品与试玩") && button("提取剩余文字"), "Partial production should retain both its output and supplement action");
      const outcome = document.querySelector(".technical-outcome")?.textContent ?? "";
      assert(outcome.includes("待甄别候选 3 项") && outcome.includes("候选通过文字与回写检查后加入工作台"), "Completed text must not erase outstanding resource coverage or claim candidates are accepted");
      assert(document.querySelector(".technical-deferred")?.textContent?.includes("制作范围：已提取文字") && document.querySelector(".technical-deferred")?.textContent?.includes("其余资源保留原文"), "Partial output should identify its accepted text scope");
    }],
    ["shared task concurrency offers one through thirty-two and saves nine", async () => {
      localStorage.setItem(welcomeKey, "seen");
      await mount();
      button("设置").click();
      await until(() => document.querySelector("#settings-form"));
      const select = document.querySelector<HTMLSelectElement>(".advanced select");
      assert(select && select.options.length === 32 && select.options[0].value === "1" && select.options[31].value === "32", "Shared task concurrency must expose the full supported range");
      flushSync(() => { select.value = "9"; select.dispatchEvent(new Event("change", { bubbles: true })); });
      button("保存设置").click();
      await until(() => savedSettings?.concurrency === 9);
      assert(select.value === "9", "The selected concurrency should remain nine after saving");
      assert(document.querySelectorAll(".advanced select").length === 1, "Technical work should share the existing concurrency control");
    }],
    ["engine identity pairs a bundled family icon with its version label", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.engine = "MZ";
      await mount({ project: detail });
      const identity = document.querySelector('.overview-hero [data-engine="rpgmaker"]');
      const icon = identity?.querySelector("img");
      assert(icon?.getAttribute("src") === "./engines/rpgmaker.webp", "RPG Maker should use a bundled brand asset");
      assert(identity?.textContent?.includes("MZ"), "Engine version should remain readable");
      assert(icon?.getAttribute("alt") === "", "The adjacent engine label should provide the accessible name");
    }],
    ["Godot and custom engines keep distinct readable identity treatments", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.engine = "Godot";
      await mount({ project: detail });
      assert(document.querySelector('.overview-hero [data-engine="godot"] img')?.getAttribute("src") === "./engines/godot.svg", "Godot should use its own brand icon");
      detail.engine = "Custom neutral runtime";
      await mount({ project: detail });
      const custom = document.querySelector('.overview-hero [data-engine="other"]');
      assert(custom?.textContent?.includes("Custom neutral runtime"), "Custom runtimes should retain their detected name");
      assert(custom?.querySelector("svg") && !custom?.querySelector("img"), "Custom runtimes should use the generic engine symbol");
    }],
    ["an empty completed extraction shows its result instead of waiting", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("ready");
      detail.total = detail.done = detail.translated = detail.proofread = 0;
      await mount({ project: detail });
      button("文字工作台").click();
      await until(() => document.querySelector(".empty h2")?.textContent === "当前项目已提取 0 条文字");
      assert(!document.querySelector(".loading-state"), "A finished empty extraction was presented as loading");
    }],
    ["an active extraction keeps the waiting indicator in the text workbench", async () => {
      localStorage.setItem(welcomeKey, "seen");
      const detail = project("preparing");
      detail.total = detail.done = detail.translated = detail.proofread = 0;
      await mount({ project: detail });
      button("文字工作台").click();
      await until(() => document.querySelector(".loading-state")?.textContent?.includes("正在提取文字"));
      assert(document.querySelector(".loading-state .spin"), "Active extraction needs an activity indicator");
    }],
  ] as const;
  const results = [];
  for (const [name, run] of cases) {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  }
  root?.unmount();
  localStorage.removeItem(welcomeKey);
  return results;
}
Object.assign(window, { runOnboardingChecks });
