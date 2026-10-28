import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Coins,
  FileText,
  Folder,
  FolderOpen,
  Gamepad2,
  GitBranch,
  Heart,
  Info,
  Languages,
  LayoutDashboard,
  LibraryBig,
  Link2Off,
  LockKeyhole,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Type,
  Upload,
  X,
} from "lucide-react";

type Page =
  "library" | "overview" | "workbench" | "release" | "play" | "settings";
type TaskState = "idle" | "running" | "paused" | "waiting" | "done";
type ModelRole = "technical" | "translation" | "proofreading";
type ModelConnection = { provider: string; url: string; model: string };
type RoleModel = {
  connection: "shared" | "custom";
  model: string;
  url: string;
};
type ModelSettings = {
  shared: ModelConnection;
  roles: Record<ModelRole, RoleModel>;
  concurrency: number;
};

const initialModelSettings: ModelSettings = {
  shared: { provider: "自定义兼容接口", url: "", model: "" },
  roles: {
    technical: { connection: "shared", model: "", url: "" },
    translation: { connection: "shared", model: "", url: "" },
    proofreading: { connection: "shared", model: "", url: "" },
  },
  concurrency: 3,
};
type Project = {
  name: string;
  path: string;
  output: string;
  mode: string;
  engine: string;
  font: string;
};

const titles: Record<Page, string> = {
  library: "游戏项目",
  overview: "制作总览",
  workbench: "文字工作台",
  release: "验收与输出",
  play: "游玩辅助",
  settings: "设置",
};
const engines = ["MV", "MZ", "VX Ace", "VX", "XP", "2000 / 2003", "WOLF"];
const demoProject: Project = {
  name: "示例游戏项目",
  path: "D:\\Games\\示例游戏",
  output: "D:\\Games\\示例游戏_简体中文版",
  mode: "初次汉化",
  engine: "RPG Maker MZ",
  font: "按游戏风格推荐",
};

function Button({
  children,
  onClick,
  variant = "secondary",
  className = "",
  disabled = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`button ${variant} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  children,
  onClick,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Heading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </header>
  );
}

function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    el?.querySelector<HTMLInputElement>(
      "input[placeholder]:not([disabled])",
    )?.focus();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="modal-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content">
        <header className="modal-heading">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [project, setProject] = useState<Project | null>(null);
  const [wizard, setWizard] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState("");
  const [task, setTask] = useState<TaskState>("idle");
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportKind, setExportKind] = useState("独立游戏");
  const [modelSettings, setModelSettings] = useState(initialModelSettings);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setWizard(true);
      }
      if (e.key === ",") {
        e.preventDefault();
        setPage("settings");
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const notify = (message: string) => setToast(message);
  function loadDemo() {
    setProject(demoProject);
    setTask("idle");
    setPage("overview");
    notify("示例工作区已打开。");
  }
  const nav: { page: Page; icon: ReactNode; group?: string }[] = [
    { page: "library", icon: <LibraryBig />, group: "工作空间" },
    { page: "overview", icon: <LayoutDashboard /> },
    { page: "workbench", icon: <BookOpenText />, group: "汉化制作" },
    { page: "release", icon: <Package /> },
    { page: "play", icon: <Gamepad2 />, group: "游玩" },
  ];

  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <button
          className="brand"
          aria-label="拼好汉化，返回首页"
          title="返回首页"
          onClick={() => setPage("overview")}
        >
          <img className="brand-mark" src="/pinhao-logo.png" alt="" />
          <span className="brand-copy">
            <strong>拼好汉化</strong>
            <small>游戏汉化工作台</small>
          </span>
        </button>
        <button
          className="project-switch"
          onClick={() => setPage("library")}
          title="切换游戏项目"
        >
          <span className="project-switch-icon">
            <Folder size={17} />
          </span>
          <span>
            <strong>{project?.name || "选择游戏项目"}</strong>
            <small>{project?.engine || "创建你的第一个项目"}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <div key={item.page}>
              {item.group && <p className="nav-label">{item.group}</p>}
              <button
                title={titles[item.page]}
                aria-current={page === item.page ? "page" : undefined}
                className={`nav-item ${page === item.page ? "selected" : ""}`}
                onClick={() => setPage(item.page)}
              >
                {item.icon}
                <span>{titles[item.page]}</span>
                {page === item.page && <span className="nav-current" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-note">
            <span className="tiny-label">首发开发目标</span>
            <strong>
              RPG Maker <span>+ WOLF</span>
            </strong>
            <small>从引擎适配到独立成品</small>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "selected" : ""}`}
            onClick={() => setPage("settings")}
            title="设置"
          >
            <Settings2 />
            <span>设置</span>
          </button>
          <button
            className="sidebar-collapse"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          >
            <ArrowLeft size={15} />
            <span>收起侧栏</span>
          </button>
        </div>
      </aside>
      <div className="application">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{titles[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-badge">
              <span />
              界面预览
            </span>
            <span className="top-divider" />
            <IconButton label="使用提示" onClick={() => setHelp(true)}>
              <CircleHelp size={18} />
            </IconButton>
          </div>
        </header>
        <main
          className={`main ${page === "workbench" ? "workbench-main" : ""}`}
          id="main-content"
        >
          {page === "overview" && (
            <Overview
              project={project}
              task={task}
              setTask={setTask}
              newProject={() => setWizard(true)}
              navigate={setPage}
              loadDemo={loadDemo}
            />
          )}
          {page === "library" && (
            <Library
              project={project}
              newProject={() => setWizard(true)}
              openProject={() => setPage("overview")}
              loadDemo={loadDemo}
            />
          )}
          {page === "workbench" && (
            <Workbench
              project={project}
              draft={draft}
              setDraft={setDraft}
              notify={notify}
              newProject={() => setWizard(true)}
            />
          )}
          {page === "release" && (
            <Release
              project={project}
              notify={notify}
              exportPreview={(kind) => {
                setExportKind(kind);
                setExportOpen(true);
              }}
            />
          )}
          {page === "play" && (
            <PlayTools project={project} notify={notify} navigate={setPage} />
          )}
          {page === "settings" && (
            <Settings
              notify={notify}
              models={modelSettings}
              setModels={setModelSettings}
            />
          )}
        </main>
        <footer className="statusbar">
          <span>
            <span className="status-dot" />
            项目工作空间
          </span>
          <span>
            <ShieldCheck size={13} />
            拼好汉化工作台<span className="version">UI 0.2</span>
          </span>
        </footer>
      </div>
      {toast && (
        <div role="status" className="toast">
          <Info size={18} />
          <span>{toast}</span>
          <IconButton label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {wizard && (
        <NewProject
          onClose={() => setWizard(false)}
          onCreate={(p) => {
            setProject(p);
            setTask("idle");
            setPage("overview");
            setWizard(false);
            notify("项目已加入当前工作区。");
          }}
        />
      )}
      {help && (
        <Modal
          title="使用指南"
          description="添加游戏、安排文字接力、查看成品输出。"
          onClose={() => setHelp(false)}
        >
          <div className="help-body">
            <p>
              左侧切换制作页面，点击“添加游戏”建立项目，在文字工作台体验编辑与上下文查看。
            </p>
            <div className="help-shortcut">
              <span>新建项目</span>
              <kbd>Ctrl + N</kbd>
            </div>
            <div className="help-shortcut">
              <span>打开设置</span>
              <kbd>Ctrl + ,</kbd>
            </div>
            <div className="help-shortcut">
              <span>关闭弹窗</span>
              <kbd>Esc</kbd>
            </div>
            <p className="muted">当前草稿随页面会话保留，刷新即可重新开始。</p>
          </div>
          <div className="modal-footer">
            <Button variant="primary" onClick={() => setHelp(false)}>
              开始体验
            </Button>
          </div>
        </Modal>
      )}
      {exportOpen && (
        <Modal
          title={`${exportKind}输出确认`}
          description="核对输出位置与分享选项。"
          onClose={() => setExportOpen(false)}
        >
          <div className="export-summary">
            <Package size={28} />
            <div>
              <strong>{project?.name || "游戏项目"} · 简体中文版</strong>
              <p>
                {exportKind === "独立游戏"
                  ? "完整游戏目录，独立启动游玩"
                  : exportKind === "增量补丁"
                    ? "改动文件包，适用于对应版本的原游戏"
                    : "保留上下文与当前译文，交给文字 AI 或人工继续处理"}
              </p>
            </div>
          </div>
          <dl className="summary-list">
            <div>
              <dt>输出目录</dt>
              <dd>{project?.output || "选择目录"}</dd>
            </div>
            <div>
              <dt>验收情况</dt>
              <dd>待验收</dd>
            </div>
          </dl>
          <div className="check-options">
            <label>
              <input type="checkbox" defaultChecked />
              排除个人存档与工具日志
            </label>
            <label>
              <input type="checkbox" defaultChecked />
              保留字体与第三方许可证
            </label>
            <label>
              <input type="checkbox" defaultChecked />
              附带免费分享说明
            </label>
          </div>
          <div className="modal-footer">
            <Button onClick={() => setExportOpen(false)}>返回</Button>
            <Button
              variant="primary"
              onClick={() => {
                setExportOpen(false);
                notify("输出方案预览完成。");
              }}
            >
              完成预览
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Overview({
  project,
  task,
  setTask,
  newProject,
  navigate,
  loadDemo,
}: {
  project: Project | null;
  task: TaskState;
  setTask: (s: TaskState) => void;
  newProject: () => void;
  navigate: (p: Page) => void;
  loadDemo: () => void;
}) {
  const steps = [
    "识别与适配",
    "建立工作台",
    "翻译与校对",
    "构建汉化版",
    "验收与输出",
  ];
  const stateCopy: Record<TaskState, [string, string]> = {
    idle: ["等待开始", "选择游戏目录，在独立位置建立汉化项目。"],
    running: ["正在制作", "当前阶段、文字进度与阶段成果集中呈现。"],
    paused: ["任务已暂停", "从当前检查点继续制作。"],
    waiting: ["等待确认", "查看适配方案与待决定的问题，确认下一步。"],
    done: ["制作完成", "查看输出结构、使用说明与交付选项。"],
  };
  return (
    <div className="page overview-page">
      <Heading
        title="制作总览"
        description="让故事保留上下文，让汉化成为独立成品。"
      >
        <label className="state-preview">
          <span>预览状态</span>
          <select
            aria-label="预览任务状态"
            value={task}
            onChange={(e) => setTask(e.target.value as TaskState)}
          >
            <option value="idle">等待开始</option>
            <option value="running">制作中</option>
            <option value="paused">已暂停</option>
            <option value="waiting">等待确认</option>
            <option value="done">已完成</option>
          </select>
        </label>
      </Heading>
      <section className="project-banner">
        <div className="project-art" aria-hidden="true">
          <div className="art-grid" />
          <div className="art-sheet rear">
            <span />
            <span />
            <span />
          </div>
          <div className="art-sheet front">
            <Languages size={40} strokeWidth={1.1} />
            <span className="sheet-rule" />
            <div className="sheet-chars">
              文 <b>文</b>
            </div>
          </div>
          <span className="art-corner top" />
          <span className="art-corner bottom" />
          <div className="art-caption">原版 → 汉化版</div>
        </div>
        <div className="project-banner-copy">
          <div className="project-kicker">
            <span className="small-square" />
            {project ? "当前游戏项目" : "准备好开始了吗"}
          </div>
          <h2>{project?.name || "从一款游戏开始。"}</h2>
          <p>
            {project
              ? project.path
              : "选择游戏目录，工作台会负责后续的整理与制作。"}
          </p>
          <div className="project-tags">
            <span>
              <BookOpenText size={14} />
              完整上下文
            </span>
            <span>
              <Link2Off size={14} />
              独立内嵌成品
            </span>
            <span>
              <ShieldCheck size={14} />
              原版独立保留
            </span>
          </div>
          <div className="banner-actions">
            <Button variant="primary" onClick={newProject}>
              <Plus size={16} />
              {project ? "添加其他游戏" : "添加游戏"}
            </Button>
            <Button
              variant="ghost"
              onClick={project ? () => navigate("workbench") : loadDemo}
            >
              {project ? "进入文字工作台" : "先看示例工作区"}
              <ArrowUpRight size={15} />
            </Button>
          </div>
        </div>
        <span className="banner-watermark" aria-hidden="true">
          文
        </span>
      </section>
      <section className="workflow" aria-label="制作流程">
        <div className="section-heading">
          <h2>一条完整的制作流程</h2>
          <span>从原版目录到可玩成品</span>
        </div>
        <div className="workflow-steps">
          {steps.map((s, i) => (
            <button
              className={`workflow-step ${task === "running" && i === 2 ? "active" : ""}`}
              key={s}
              onClick={() => navigate(i < 3 ? "workbench" : "release")}
            >
              <span className="step-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>{s}</span>
              {i < 4 && <ChevronRight size={15} className="step-arrow" />}
            </button>
          ))}
        </div>
      </section>
      {task !== "idle" && (
        <section className={`task-notice ${task}`}>
          <div className="task-notice-icon">
            {task === "paused" ? (
              <Pause />
            ) : task === "done" ? (
              <Package />
            ) : (
              <Info />
            )}
          </div>
          <div>
            <strong>{stateCopy[task][0]}</strong>
            <p>{stateCopy[task][1]}</p>
          </div>
          <Button
            onClick={() =>
              task === "running"
                ? setTask("paused")
                : task === "done"
                  ? navigate("release")
                  : setTask("running")
            }
          >
            {task === "running" ? (
              <>
                <Pause size={14} />
                暂停
              </>
            ) : task === "done" ? (
              <>
                查看输出界面
                <ArrowRight size={14} />
              </>
            ) : (
              <>
                <Play size={14} />
                继续制作
              </>
            )}
          </Button>
        </section>
      )}
      <div className="overview-columns">
        <section className="panel next-panel">
          <div className="section-heading">
            <h2>开始制作之前</h2>
            <span className="quiet-badge">项目准备</span>
          </div>
          <button className="setup-row" onClick={newProject}>
            <span className={`setup-icon ${project ? "ready" : ""}`}>
              {project ? <Check /> : <FolderOpen />}
            </span>
            <span>
              <strong>选择游戏与输出目录</strong>
              <small>
                {project
                  ? "目录已填写，点击调整"
                  : "保留原版，在单独目录中制作"}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button className="setup-row" onClick={() => navigate("settings")}>
            <span className="setup-icon">
              <Settings2 />
            </span>
            <span>
              <strong>连接你自己的模型</strong>
              <small>技术适配、翻译、校对润色分别选用模型</small>
            </span>
            <span className="row-hint">去配置</span>
            <ChevronRight size={16} />
          </button>
          <button className="setup-row" onClick={() => navigate("release")}>
            <span className="setup-icon">
              <Type />
            </span>
            <span>
              <strong>确定中文显示风格</strong>
              <small>字体、换行与窗口布局一起考虑</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </section>
        <section className="output-paper">
          <div className="paper-header">
            <span className="paper-icon">
              <Package size={21} />
            </span>
            <span>独立成品</span>
            <ArrowUpRight size={17} />
          </div>
          <h2>做好之后，直接玩。</h2>
          <p>
            中文直接内嵌，
            <br />
            随游戏独立运行。
          </p>
          <div className="mini-file-tree">
            <div>
              <Folder size={15} />
              <strong>游戏_简体中文版</strong>
            </div>
            <div>
              <span className="tree-line" />
              <Monitor size={14} />
              <span>游戏启动程序</span>
            </div>
            <div>
              <span className="tree-line" />
              <Folder size={14} />
              <span>游戏资源与内嵌译文</span>
            </div>
          </div>
          <button className="text-button" onClick={() => navigate("release")}>
            查看输出界面
            <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <div className="coverage-strip">
        <span>首发开发目标</span>
        {engines.map((e) => (
          <span className="engine-chip" key={e}>
            {e}
          </span>
        ))}
        <span className="coverage-note">其他引擎后续展开</span>
      </div>
    </div>
  );
}

function Library({
  project,
  newProject,
  openProject,
  loadDemo,
}: {
  project: Project | null;
  newProject: () => void;
  openProject: () => void;
  loadDemo: () => void;
}) {
  const [filter, setFilter] = useState("全部项目");
  const [query, setQuery] = useState("");
  const visible =
    project && project.name.includes(query) && filter !== "已有成品";
  return (
    <div className="page">
      <Heading
        title="游戏项目"
        description="每一款游戏，都有自己的译文、制作记录与成品。"
      >
        <Button variant="primary" onClick={newProject}>
          <Plus size={16} />
          添加游戏
        </Button>
      </Heading>
      <div className="library-toolbar">
        <div className="underline-tabs">
          {["全部项目", "制作中", "已有成品"].map((f) => (
            <button
              className={filter === f ? "active" : ""}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索游戏项目"
            placeholder="搜索项目"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {visible ? (
        <button className="game-row" onClick={openProject}>
          <span className="game-cover">
            <Languages size={34} strokeWidth={1.3} />
            <small>界面示例</small>
          </span>
          <span className="game-row-info">
            <strong>{project.name}</strong>
            <span>
              {project.engine}
              <i />
              简体中文
            </span>
            <small>{project.path}</small>
          </span>
          <span className="quiet-badge">等待开始</span>
          <span className="open-project">
            打开项目
            <ArrowUpRight size={16} />
          </span>
        </button>
      ) : (
        <section className="library-empty">
          <div className="empty-folder" aria-hidden="true">
            <FolderOpen size={65} strokeWidth={1} />
            <span>
              <Plus size={20} />
            </span>
          </div>
          <h2>
            {project ? "调整筛选，查找项目" : "你的下一份汉化，从这里开始"}
          </h2>
          <p>
            {project
              ? "换一个筛选条件，或添加新的游戏。"
              : "添加游戏目录，在独立副本中制作。"}
          </p>
          <Button variant="primary" onClick={newProject}>
            <Plus size={16} />
            添加游戏
          </Button>
          {!project && (
            <button className="text-button" onClick={loadDemo}>
              载入界面示例
              <ArrowRight size={14} />
            </button>
          )}
        </section>
      )}
      <div className="library-footnote">
        <ShieldCheck size={16} />
        <p>
          项目与原版分开保存。后续补译、校对和重新打包，都可以在原项目中继续。
        </p>
      </div>
    </div>
  );
}

function Workbench({
  project,
  draft,
  setDraft,
  notify,
  newProject,
}: {
  project: Project | null;
  draft: string;
  setDraft: (s: string) => void;
  notify: (s: string) => void;
  newProject: () => void;
}) {
  const [category, setCategory] = useState("剧情对话");
  const [contextTab, setContextTab] = useState("上下文");
  const [context, setContext] = useState(true);
  const [compare, setCompare] = useState(true);
  const [search, setSearch] = useState("");
  return (
    <div className="workbench-page">
      <Heading
        title="文字工作台"
        description="按场景组织完整文字，让翻译、校对与润色接得上。"
      >
        <Button
          onClick={() => notify("文字包导入：选择回包、核对版本、合并文字。")}
        >
          <Upload size={15} />
          导入文字包
        </Button>
        <Button
          variant="primary"
          onClick={() => notify("翻译接力：初翻、校对、润色，按当前译文继续。")}
        >
          <Languages size={16} />
          组织翻译
        </Button>
      </Heading>
      <div className="workbench-toolbar">
        <div className="segmented">
          <button
            className={compare ? "active" : ""}
            onClick={() => setCompare(true)}
          >
            原译对照
          </button>
          <button
            className={!compare ? "active" : ""}
            onClick={() => setCompare(false)}
          >
            译文视图
          </button>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索文字"
            placeholder="搜索文字、人物或记录"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <span className="record-count">0 条记录</span>
        <IconButton
          label={context ? "收起上下文面板" : "展开上下文面板"}
          onClick={() => setContext(!context)}
        >
          {context ? (
            <PanelRightClose size={18} />
          ) : (
            <PanelRightOpen size={18} />
          )}
        </IconButton>
      </div>
      <div className={`editor-layout ${context ? "" : "no-context"}`}>
        <aside className="scene-panel">
          <div className="scene-heading">
            <span>项目文字</span>
            <IconButton
              label="场景筛选说明"
              onClick={() => notify("这里将按场景、人物和处理状态筛选。")}
            >
              <SlidersHorizontal size={15} />
            </IconButton>
          </div>
          <div className="scene-root">
            <ChevronDown size={14} />
            <FolderOpen size={16} />
            <span>{project?.name || "游戏文字"}</span>
          </div>
          {["剧情对话", "菜单与选项", "名称与说明", "动态与补漏"].map(
            (s, i) => (
              <button
                key={s}
                className={`scene-item ${category === s ? "selected" : ""}`}
                onClick={() => setCategory(s)}
              >
                {i === 0 ? (
                  <MessageSquareText size={16} />
                ) : i === 3 ? (
                  <GitBranch size={16} />
                ) : (
                  <FileText size={16} />
                )}
                <span>{s}</span>
                <small>—</small>
              </button>
            ),
          )}
          <div className="scene-bottom">
            <LockKeyhole size={15} />
            <span>
              定位与控制标记
              <br />
              由程序保护
            </span>
          </div>
        </aside>
        <section className="text-editor">
          <div className="editor-heading">
            <span>{category}</span>
            <span className="quiet-badge">空白工作区</span>
          </div>
          <div className="unit-metadata">
            <span>
              说话人 <b>待导入</b>
            </span>
            <span>
              场景 <b>待导入</b>
            </span>
            <span className="metadata-protected">
              <ShieldCheck size={13} />
              完整语义单元
            </span>
          </div>
          <div className={`editor-panes ${compare ? "" : "translation-only"}`}>
            {compare && (
              <div className="source-pane">
                <div className="pane-label">
                  <span>原文</span>
                  <span>只读</span>
                </div>
                <div className="source-placeholder">
                  <span className="placeholder-quote">“</span>
                  <div className="static-line long" />
                  <div className="static-line" />
                  <div className="static-line short" />
                  <p>
                    {search ? "导入文字后开始搜索" : "完整段落会保留在这里"}
                    <br />
                    <small>添加游戏，建立文字工作台</small>
                  </p>
                </div>
              </div>
            )}
            <div className="translation-pane">
              <div className="pane-label">
                <label htmlFor="draft-text">当前译文</label>
                <span>文字草稿</span>
              </div>
              <textarea
                id="draft-text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  "在这里体验译文编辑。\n\n完整段落、人物与前后文一起呈现。"
                }
              />
              <div className="editor-note">
                <Info size={13} />
                <span>会话草稿</span>
              </div>
            </div>
          </div>
          <div className="editor-footer">
            <span>
              {draft.length} 字<span className="editor-foot-separator">|</span>
              当前草稿
            </span>
            <Button onClick={() => notify("当前草稿已保留。")}>
              <Check size={14} />
              保留当前输入
            </Button>
          </div>
        </section>
        {context && (
          <aside className="context-panel">
            <div className="context-tabs">
              {["上下文", "术语", "备注"].map((t) => (
                <button
                  className={contextTab === t ? "active" : ""}
                  key={t}
                  onClick={() => setContextTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {contextTab === "上下文" ? (
              <>
                <div className="context-intro">
                  <GitBranch size={19} />
                  <h3>完整上下文，连贯翻译</h3>
                  <p>
                    前后文、人物与场景，
                    <br />
                    会随每个单元一起流转。
                  </p>
                </div>
                <div className="context-timeline">
                  {["前文", "当前段落", "后文"].map((t, i) => (
                    <div key={t} className={i === 1 ? "current" : ""}>
                      <span className="timeline-dot" />
                      <strong>{t}</strong>
                      <span className="static-line" />
                      <span className="static-line short" />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="context-empty">
                <BookOpenText size={27} strokeWidth={1.4} />
                <h3>
                  {contextTab === "术语"
                    ? "术语与人名保持一致"
                    : "疑点留在对应位置"}
                </h3>
                <p>
                  {contextTab === "术语"
                    ? "导入项目后，在这里维护角色名、专名与统一译法。"
                    : "文字校对与技术问题都能留下记录，方便后续接力。"}
                </p>
                <Button
                  onClick={() => notify(`${contextTab}随文字单元一起流转。`)}
                >
                  <Plus size={14} />
                  添加{contextTab}
                </Button>
              </div>
            )}
          </aside>
        )}
      </div>
      {!project && (
        <div className="workbench-bottom-hint">
          <span>建立游戏项目，接续文字工作。</span>
          <button className="text-button" onClick={newProject}>
            添加游戏
            <ArrowRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Release({
  project,
  notify,
  exportPreview,
}: {
  project: Project | null;
  notify: (s: string) => void;
  exportPreview: (kind: string) => void;
}) {
  const [tab, setTab] = useState("独立输出");
  const [format, setFormat] = useState("独立游戏");
  const [font, setFont] = useState(project?.font || "按游戏风格推荐");
  const [size, setSize] = useState(24);
  const [qaFilter, setQaFilter] = useState("全部项目");
  const checks = [
    "启动与标题菜单",
    "对话与选择分支",
    "中文缺字与排版",
    "保存与读取存档",
    "回想与动态文字",
    "旧存档默认名字",
    "图片文字",
    "分享包隐私清理",
  ];
  return (
    <div className="page release-page">
      <Heading title="验收与输出" description="生成可直接游玩的独立汉化版。">
        <Button variant="primary" onClick={() => exportPreview(format)}>
          <Package size={16} />
          预览输出确认
        </Button>
      </Heading>
      <div className="underline-tabs page-tabs">
        {["独立输出", "显示与字体", "验收清单"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "独立输出" && (
        <div className="release-grid">
          <section className="panel output-options">
            <div className="section-heading">
              <h2>选择输出方式</h2>
              <span className="quiet-badge">输出方案</span>
            </div>
            {[
              {
                name: "独立游戏",
                text: "完整游戏目录，退出本软件后仍可运行",
                icon: <Monitor />,
              },
              {
                name: "增量补丁",
                text: "改动文件包，适用于对应版本的原游戏",
                icon: <GitBranch />,
              },
              {
                name: "文字工作包",
                text: "交给其他 AI 或人工继续翻译与校对",
                icon: <BookOpenText />,
              },
            ].map((f) => (
              <label
                key={f.name}
                className={`format-option ${format === f.name ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="format"
                  value={f.name}
                  checked={format === f.name}
                  onChange={() => setFormat(f.name)}
                />
                <span className="format-icon">{f.icon}</span>
                <span>
                  <strong>
                    {f.name}
                    {f.name === "独立游戏" && <small>推荐</small>}
                  </strong>
                  <p>{f.text}</p>
                </span>
                <span className="radio-indicator">
                  {format === f.name && <span />}
                </span>
              </label>
            ))}
            <div className="output-location">
              <label htmlFor="output-path">输出目录</label>
              <div>
                <FolderOpen size={16} />
                <input
                  id="output-path"
                  readOnly
                  value={project?.output || ""}
                  placeholder="添加游戏后设置"
                />
                <IconButton
                  label="选择输出位置"
                  onClick={() => notify("在项目向导中填写输出目录。")}
                >
                  <MoreHorizontal size={18} />
                </IconButton>
              </div>
              <p>在独立目录生成汉化版。</p>
            </div>
            <div className="release-action">
              <Button variant="primary" onClick={() => exportPreview(format)}>
                <Package size={16} />
                预览{format}输出
                <ArrowRight size={15} />
              </Button>
              <span>核对目录与分享选项</span>
            </div>
          </section>
          <section className="deliverable-preview">
            <div className="preview-sheet">
              <div className="preview-sheet-top">
                <FolderOpen size={23} />
                <span>输出结构示意</span>
              </div>
              <h2>{format === "独立游戏" ? "游戏_简体中文版" : format}</h2>
              <div className="deliverable-tree">
                {(format === "独立游戏"
                  ? [
                      ["游戏启动程序", Monitor],
                      ["游戏数据与内嵌译文", Folder],
                      ["资源与中文字体", Type],
                      ["使用说明与许可证", FileText],
                    ]
                  : format === "增量补丁"
                    ? [
                        ["改动文件", Folder],
                        ["版本校验信息", ShieldCheck],
                        ["安装说明", FileText],
                      ]
                    : [
                        ["完整语义单元", BookOpenText],
                        ["场景与人物上下文", GitBranch],
                        ["术语与当前译文", Languages],
                        ["接力任务说明", FileText],
                      ]
                ).map(([label, Icon], i) => {
                  const ItemIcon = Icon as typeof Monitor;
                  return (
                    <div key={String(label)}>
                      <span className="tree-joint" />
                      <ItemIcon size={17} />
                      <span>{String(label)}</span>
                      {i === 0 && (
                        <span className="file-annotation">
                          {format === "独立游戏" ? "双击启动" : "示意"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="preview-sheet-bottom">
                <Link2Off size={20} />
                <div>
                  <strong>
                    {format === "独立游戏"
                      ? "独立启动，直接游玩"
                      : "成果可以继续流转"}
                  </strong>
                  <p>
                    {format === "独立游戏"
                      ? "中文直接内嵌游戏"
                      : "保留版本、定位与必要的接力信息"}
                  </p>
                </div>
              </div>
            </div>
            <p className="preview-caption">输出目录结构</p>
          </section>
        </div>
      )}
      {tab === "显示与字体" && (
        <div className="font-layout">
          <section className="panel font-settings">
            <h2>中文显示</h2>
            <label className="form-field">
              字体
              <select value={font} onChange={(e) => setFont(e.target.value)}>
                <option>按游戏风格推荐</option>
                <option>霞鹜文楷</option>
                <option>霞鹜新晰黑</option>
                <option>保留游戏字体</option>
              </select>
            </label>
            <label className="form-field">
              预览字号 <span className="range-value">{size} px</span>
              <input
                type="range"
                min="18"
                max="32"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
            </label>
            <p className="field-help">比较字形、字号、行距与换行效果。</p>
            <Button onClick={() => notify("字体预览已更新。")}>
              <Check size={14} />
              保留预览选择
            </Button>
          </section>
          <section className="font-preview">
            <div className="font-preview-label">
              <Monitor size={15} />
              <span>对话窗口示意</span>
              <span className="quiet-badge">排版预览</span>
            </div>
            <div
              className={`dialog-preview ${font === "霞鹜文楷" ? "wenkai" : ""}`}
            >
              <span className="name-preview">姓名框</span>
              <p style={{ fontSize: size }}>
                这里预览中文字形、行距与换行效果。
                <br />
                完整台词按游戏场景呈现。
              </p>
              <span className="dialog-advance">▽</span>
            </div>
            <div className="font-check-labels">
              <span>
                <Type size={15} />
                字形覆盖待检测
              </span>
              <span>
                <Monitor size={15} />
                实际窗口待检查
              </span>
            </div>
          </section>
        </div>
      )}
      {tab === "验收清单" && (
        <section className="panel qa-panel">
          <div className="section-heading">
            <div>
              <h2>技术与游玩检查</h2>
              <p className="muted">检查启动、中文显示、存档与分享文件。</p>
            </div>
            <select
              aria-label="筛选验收项目"
              value={qaFilter}
              onChange={(e) => setQaFilter(e.target.value)}
            >
              <option>全部项目</option>
              <option>待检查</option>
              <option>需要处理</option>
            </select>
          </div>
          {qaFilter === "需要处理" ? (
            <div className="simple-empty">
              <ClipboardCheck size={30} />
              <p>完成验收后，在这里处理待办项目。</p>
            </div>
          ) : (
            checks.map((c, i) => (
              <div className="qa-row" key={c}>
                <span className="qa-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{c}</span>
                <span className="quiet-badge">待检查</span>
                <button
                  className="text-button"
                  onClick={() =>
                    notify(`“${c}”：记录检查结果、截图与处理过程。`)
                  }
                >
                  查看
                  <ChevronRight size={14} />
                </button>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}

function PlayTools({
  project,
  notify,
  navigate,
}: {
  project: Project | null;
  notify: (s: string) => void;
  navigate: (p: Page) => void;
}) {
  return (
    <div className="page">
      <Heading
        title="游玩辅助"
        description="按游戏提供辅助能力，与汉化制作分开管理。"
      >
        <span className="quiet-badge">选择游戏</span>
      </Heading>
      <section className="play-banner">
        <span className="play-illustration">
          <Gamepad2 size={65} strokeWidth={1.1} />
        </span>
        <div>
          <h2>先有一款游戏，再开始游玩。</h2>
          <p>集中管理金钱、物品与角色状态。</p>
          <Button onClick={() => navigate("overview")}>
            <FolderOpen size={16} />
            {project ? "返回当前项目" : "选择游戏项目"}
            <ArrowRight size={14} />
          </Button>
        </div>
      </section>
      <div className="section-heading">
        <h2>游玩工具</h2>
        <span>按游戏配置</span>
      </div>
      <div className="assist-list">
        {[
          {
            title: "金钱与物品",
            text: "查看并调整已知的游戏数据",
            icon: <Coins />,
          },
          {
            title: "角色状态",
            text: "角色、生命与其他适配能力",
            icon: <Heart />,
          },
          {
            title: "开关与变量",
            text: "显示名称、作用范围与修改提示",
            icon: <SlidersHorizontal />,
          },
        ].map((t) => (
          <button
            key={t.title}
            className="assist-row"
            onClick={() => notify(`${t.title}：选择游戏后查看适配选项。`)}
          >
            <span className="assist-icon">{t.icon}</span>
            <span>
              <strong>{t.title}</strong>
              <small>{t.text}</small>
            </span>
            <span className="quiet-badge">选择游戏</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      <div className="info-strip">
        <Info size={17} />
        <p>每项辅助展示作用范围、调整内容与存档影响。</p>
      </div>
    </div>
  );
}

function Settings({
  notify,
  models,
  setModels,
}: {
  notify: (s: string) => void;
  models: ModelSettings;
  setModels: (models: ModelSettings) => void;
}) {
  const [tab, setTab] = useState("模型连接");
  const roles: { id: ModelRole; title: string; description: string }[] = [
    {
      id: "technical",
      title: "技术适配",
      description: "负责引擎识别、拆包回写、异常修复与构建验收。",
    },
    {
      id: "translation",
      title: "翻译",
      description: "结合完整段落、人物与术语，完成初翻。",
    },
    {
      id: "proofreading",
      title: "校对润色",
      description: "核对语义、人称与术语，完善表达与补漏。",
    },
  ];
  function updateShared(update: Partial<ModelConnection>) {
    setModels({ ...models, shared: { ...models.shared, ...update } });
  }
  function updateRole(role: ModelRole, update: Partial<RoleModel>) {
    setModels({
      ...models,
      roles: { ...models.roles, [role]: { ...models.roles[role], ...update } },
    });
  }
  return (
    <div className="page settings-page">
      <Heading
        title="设置"
        description="配置一次，让工作台负责后续的制作流程。"
      />
      <div className="settings-layout">
        <div className="settings-nav">
          {["模型连接", "默认制作", "存储与工具", "关于工作台"].map((t) => (
            <button
              className={tab === t ? "active" : ""}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <section className="panel settings-content">
          {tab === "模型连接" ? (
            <>
              <div className="section-heading">
                <div>
                  <h2>默认模型连接</h2>
                  <p className="muted">
                    填写供应商接口，为各项任务设置默认模型。
                  </p>
                </div>
                <span className="quiet-badge">自备 API</span>
              </div>
              <div className="settings-form connection-fields">
                <label className="form-field">
                  接口类型
                  <select
                    value={models.shared.provider}
                    onChange={(e) => updateShared({ provider: e.target.value })}
                  >
                    <option>自定义兼容接口</option>
                    <option>供应商专用接口</option>
                  </select>
                </label>
                <label className="form-field">
                  接口地址
                  <input
                    type="url"
                    value={models.shared.url}
                    onChange={(e) => updateShared({ url: e.target.value })}
                    placeholder="https://你的供应商地址/v1"
                  />
                </label>
                <label className="form-field">
                  API 密钥
                  <input type="password" disabled placeholder="API Key" />
                </label>
                <label className="form-field">
                  模型名称
                  <input
                    value={models.shared.model}
                    onChange={(e) => updateShared({ model: e.target.value })}
                    placeholder="填写供应商提供的模型 ID"
                  />
                </label>
              </div>
              <details className="advanced-settings">
                <summary>
                  高级设置
                  <ChevronDown size={14} />
                </summary>
                <label className="form-field">
                  同时处理任务数
                  <select
                    aria-label="同时处理任务数"
                    value={models.concurrency}
                    onChange={(e) =>
                      setModels({
                        ...models,
                        concurrency: Number(e.target.value),
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                      <option key={count} value={count}>
                        {count} 个任务{count === 3 ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-help">
                  技术、翻译、校对和 OCR 共用任务队列，可按接口承载能力调整。
                </p>
              </details>
              <div className="model-roles">
                <div className="section-heading">
                  <div>
                    <h2>模型分工</h2>
                    <p className="muted">
                      按任务搭配模型，兼顾技术能力与文字质量。
                    </p>
                  </div>
                </div>
                {roles.map((role, index) => {
                  const config = models.roles[role.id];
                  return (
                    <section
                      className="model-role-card"
                      key={role.id}
                      aria-label={`${role.title}模型配置`}
                    >
                      <header className="model-role-heading">
                        <span className="role-number">0{index + 1}</span>
                        <div>
                          <h3>{role.title}</h3>
                          <p>{role.description}</p>
                        </div>
                        <span className="quiet-badge">
                          {config.connection === "shared"
                            ? "默认接口"
                            : "专用接口"}
                        </span>
                      </header>
                      <div className="model-role-fields">
                        <label className="form-field">
                          {role.title}接口
                          <select
                            value={config.connection}
                            onChange={(e) =>
                              updateRole(role.id, {
                                connection: e.target
                                  .value as RoleModel["connection"],
                              })
                            }
                          >
                            <option value="shared">沿用默认接口</option>
                            <option value="custom">设置专用接口</option>
                          </select>
                        </label>
                        <label className="form-field">
                          {role.title}模型
                          <input
                            value={config.model}
                            onChange={(e) =>
                              updateRole(role.id, { model: e.target.value })
                            }
                            placeholder={models.shared.model || "沿用默认模型"}
                          />
                        </label>
                      </div>
                      {config.connection === "custom" && (
                        <div className="role-connection-fields">
                          <label className="form-field">
                            {role.title}接口地址
                            <input
                              type="url"
                              value={config.url}
                              onChange={(e) =>
                                updateRole(role.id, { url: e.target.value })
                              }
                              placeholder="https://你的供应商地址/v1"
                            />
                          </label>
                          <label className="form-field">
                            {role.title} API 密钥
                            <input
                              type="password"
                              disabled
                              placeholder="API Key"
                            />
                          </label>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
              <div className="settings-footer">
                <Button
                  variant="primary"
                  onClick={() => notify("模型分工已保留在本次预览中。")}
                >
                  保留模型分工
                  <ArrowRight size={15} />
                </Button>
                <span>技术与文字任务分别选用对应模型</span>
              </div>
            </>
          ) : tab === "默认制作" ? (
            <>
              <h2>默认制作方式</h2>
              <div className="settings-form">
                <label className="form-field">
                  目标语言
                  <select>
                    <option>简体中文</option>
                  </select>
                </label>
                <label className="form-field">
                  默认字体
                  <select>
                    <option>按游戏风格推荐</option>
                    <option>霞鹜文楷</option>
                    <option>霞鹜新晰黑</option>
                  </select>
                </label>
                <label className="checkbox-line">
                  <input type="checkbox" defaultChecked />
                  优先继承已有译文
                </label>
                <label className="checkbox-line">
                  <input type="checkbox" defaultChecked />
                  输出独立汉化版
                </label>
              </div>
              <p className="field-help">
                翻译与校对使用产品内置任务规则，按游戏上下文组织文字。
              </p>
              <Button
                onClick={() => notify("制作偏好预览完成。")}
                variant="primary"
              >
                保留当前选择
              </Button>
            </>
          ) : tab === "存储与工具" ? (
            <>
              <h2>工程与工具分开保存</h2>
              <p className="muted">
                工程独立保存，工具按需下载，缓存统一管理。
              </p>
              <div className="storage-rows">
                {[
                  "项目工作目录",
                  "独立成品目录",
                  "下载的引擎工具",
                  "可重建的中间缓存",
                ].map((t) => (
                  <div key={t}>
                    <Folder size={18} />
                    <span>{t}</span>
                    <span className="muted">选择目录</span>
                    <IconButton
                      label={`设置${t}`}
                      onClick={() => notify("项目、成品、工具和缓存分别管理。")}
                    >
                      <MoreHorizontal size={17} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="about-workbench">
              <span className="about-mark">
                <Languages size={36} strokeWidth={1.3} />
              </span>
              <h2>拼好汉化工作台</h2>
              <p>
                让故事保留上下文，
                <br />
                让汉化成为独立成品。
              </p>
              <span className="quiet-badge">UI 0.2</span>
              <div className="about-scope">
                首发开发目标：RPG Maker 各系列与 WOLF。
                <br />
                识别与适配 → 文字接力 → 内嵌构建 → 验收输出
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NewProject({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (p: Project) => void;
}) {
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState("初次汉化");
  const [output, setOutput] = useState("");
  const [font, setFont] = useState("按游戏风格推荐");
  const [error, setError] = useState("");
  const labels = ["选择游戏", "制作方式", "确认输出"];
  function next() {
    if (step === 0 && (!path.trim() || !name.trim())) {
      setError("请填写项目名称和目录，或使用示例目录。");
      return;
    }
    setError("");
    if (step === 2)
      onCreate({
        name: name.trim(),
        path: path.trim(),
        mode,
        output: output.trim() || `${path.trim()}_简体中文版`,
        engine: "待识别",
        font,
      });
    else setStep(step + 1);
  }
  return (
    <Modal
      title="添加游戏项目"
      description="从原版目录开始，在独立位置完成制作。"
      onClose={onClose}
      wide
    >
      <div className="wizard-steps">
        {labels.map((t, i) => (
          <div
            className={i === step ? "current" : i < step ? "past" : ""}
            key={t}
          >
            <span>{i < step ? <Check size={13} /> : i + 1}</span>
            {t}
            {i < 2 && <ChevronRight size={14} />}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <div className="wizard-body">
          {step === 0 ? (
            <>
              <div className="wizard-directory">
                <FolderOpen size={37} strokeWidth={1.4} />
                <h3>游戏所在的文件夹</h3>
                <p>识别引擎，继承已有译文。</p>
                <Button
                  onClick={() => {
                    setPath(demoProject.path);
                    setName(demoProject.name);
                    setOutput(demoProject.output);
                    setError("");
                  }}
                >
                  使用示例目录
                  <FolderOpen size={15} />
                </Button>
                <small>填写目录，建立项目</small>
              </div>
              <label className="form-field">
                游戏目录
                <input
                  autoFocus
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="例如 D:\Games\游戏目录"
                  aria-invalid={!!error && !path.trim()}
                  aria-describedby={error ? "wizard-error" : undefined}
                />
              </label>
              <label className="form-field">
                项目名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="给这份汉化项目起个名字"
                  aria-invalid={!!error && !name.trim()}
                  aria-describedby={error ? "wizard-error" : undefined}
                />
              </label>
              <div className="wizard-hint">
                <ShieldCheck size={15} />
                原版、制作副本与个人存档分别保留。
              </div>
            </>
          ) : step === 1 ? (
            <>
              <h3 className="wizard-section-title">这次想怎样制作？</h3>
              {[
                {
                  name: "初次汉化",
                  text: "建立完整文字工作台，再组织翻译与校对。",
                },
                {
                  name: "继承已有译文",
                  text: "沿用现有成果，重点补漏、校对和润色。",
                },
                {
                  name: "交给外部文字 AI",
                  text: "先整理文字工作包，之后收回成果继续制作。",
                },
              ].map((m) => (
                <label
                  key={m.name}
                  className={`mode-option ${mode === m.name ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={m.name}
                    checked={mode === m.name}
                    onChange={() => setMode(m.name)}
                  />
                  <span>
                    <strong>{m.name}</strong>
                    <small>{m.text}</small>
                  </span>
                  <span className="radio-indicator">
                    {mode === m.name && <span />}
                  </span>
                </label>
              ))}
              <label className="form-field">
                目标语言
                <select>
                  <option>简体中文</option>
                </select>
              </label>
              <div className="wizard-hint">
                <Info size={15} />
                先建立项目，随时配置模型。
              </div>
            </>
          ) : (
            <>
              <div className="wizard-output-heading">
                <Package size={27} />
                <div>
                  <h3>独立汉化版</h3>
                  <p>制作完成后，独立启动游玩。</p>
                </div>
              </div>
              <label className="form-field">
                输出目录
                <input
                  value={output}
                  onChange={(e) => setOutput(e.target.value)}
                  placeholder={`${path}_简体中文版`}
                />
                <small>与原版分开保存。</small>
              </label>
              <label className="form-field">
                中文字体
                <select value={font} onChange={(e) => setFont(e.target.value)}>
                  <option>按游戏风格推荐</option>
                  <option>霞鹜文楷</option>
                  <option>霞鹜新晰黑</option>
                </select>
              </label>
              <div className="wizard-summary">
                <span>项目</span>
                <strong>{name}</strong>
                <span>制作方式</span>
                <strong>{mode}</strong>
                <span>制作阶段</span>
                <strong>项目准备</strong>
              </div>
            </>
          )}
          {error && (
            <p id="wizard-error" role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <span className="wizard-step-label">第 {step + 1} 步，共 3 步</span>
          {step === 0 ? (
            <Button onClick={onClose}>取消</Button>
          ) : (
            <Button onClick={() => setStep(step - 1)}>
              <ArrowLeft size={14} />
              上一步
            </Button>
          )}
          <Button type="submit" variant="primary">
            {step === 2 ? "创建项目" : "下一步"}
            {step === 2 ? <Check size={15} /> : <ArrowRight size={15} />}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
