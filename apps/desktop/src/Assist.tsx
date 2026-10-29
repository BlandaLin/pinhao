import { tr, trc, uiMessage, uiLocale } from "../shared/ui-language.js";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Coins,
  Heart,
  PackageOpen,
  Play,
  Search,
  SlidersHorizontal,
  Wifi,
  FileArchive,
} from "lucide-react";
import type {
  AssistState,
  AssistSaveBackups,
  DesktopApi,
  EngineCapability,
  ProjectDetail,
} from "../../../packages/contracts/index";
import { api, errorMessage, nativeDesktop } from "./api";
import {
  assistPage,
  assistRows,
  parseAssistValue,
  supportedAssistActions,
  type AssistTab,
} from "./assist-view";
import { Button, Empty, Heading, Modal } from "./components";
import AssistExploration from "./AssistExploration";
import AssistGallery from "./AssistGallery";
import AssistSaveBackupDialog from "./AssistSaveBackups";
import EngineLabel from "./EngineLabel";

type Command = Parameters<DesktopApi["assistCommand"]>[0];
type EditTarget = {
  id?: number;
  name: string;
  label: string;
  value: string | number | boolean;
  action: Command["action"];
  type?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  params?: Command["params"];
  hint?: string;
  fixedType?: boolean;
  expectedSaveSha256?: string;
};
const dataTabs = [
  { id: "items", title: tr("物品与装备"), Icon: PackageOpen },
  { id: "switches", title: tr("事件开关"), Icon: SlidersHorizontal },
  { id: "variables", title: tr("游戏变量"), Icon: SlidersHorizontal },
] as const;

export default function Assist({
  project,
  engine,
  onError,
}: {
  project: ProjectDetail;
  engine?: EngineCapability;
  onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<AssistState>({ connected: false });
  const [selectedMode, setSelectedMode] = useState<"live" | "save">("live");
  const [goldDraft, setGoldDraft] = useState<string | null>(null);
  const [goldSaveVersion, setGoldSaveVersion] = useState<string | undefined>();
  const [goldSessionVersion, setGoldSessionVersion] = useState<string | undefined>();
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<AssistTab>("items");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [backups, setBackups] = useState<AssistSaveBackups | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(project.assistEnabled !== false);
  const [section, setSection] = useState<"data" | "exploration" | "gallery">(
    "data",
  );
  const currentProjectId = useRef(project.id);
  currentProjectId.current = project.id;
  const supported = project.assistance?.supported ?? Boolean(engine?.assist);
  const canManage = supported || state.connected;
  const modes: ("live" | "save")[] = project.assistance?.modes?.length
    ? project.assistance.modes : engine?.assistModes || ["live"];
  const mode = modes.includes(selectedMode) ? selectedMode : modes[0] || "live";
  const saveMode = mode === "save";
  const actions = supportedAssistActions(state);
  const namedData =
    state.namedVariables !== undefined || actions.has("setNamedVariable");
  const rpgSections = !saveMode && ["mv", "mz", "xp", "vx", "vxa", "vxace"].includes(
    (engine?.id || state.engine || project.engine)
      .toLowerCase()
      .replace(/rpg maker|[\s_\/-]/g, ""),
  );
  const visibleTabs = dataTabs.filter(({ id }) =>
    id === "items"
      ? state.items !== undefined || actions.has("setItem")
      : id === "switches"
        ? state.switches !== undefined || actions.has("setSwitch")
        : namedData ||
          state.variables !== undefined ||
          actions.has("setVariable"),
  );
  const activeTab = visibleTabs.some(({ id }) => id === tab)
    ? tab
    : visibleTabs[0]?.id || "variables";
  const rows = assistPage(assistRows(state, activeTab), search, page);
  const connected = state.connected && state.ready !== false && (saveMode || liveEnabled);
  const mpLabel =
    state.engine?.toLowerCase() === "xp" || engine?.id.toLowerCase() === "xp"
      ? "SP"
      : "MP";
  const actorEditing = ["setLevel", "setExp", "setHp", "setMp"].some((action) =>
    actions.has(action as Command["action"]),
  );

  useEffect(() => { setLiveEnabled(project.assistEnabled !== false); }, [project.id, project.assistEnabled]);

  useEffect(() => {
    setGoldDraft(null);
    setGoldSaveVersion(undefined);
    setGoldSessionVersion(undefined);
    setEditing(null);
  }, [state.gameSessionId]);

  useEffect(() => {
    setState({ connected: false });
    setGoldDraft(null);
    setGoldSaveVersion(undefined);
    setEditing(null);
    setConnectionError("");
    setNotice("");
    setBackups(null);
    setBusy("");
    setPage(0);
    if (!nativeDesktop || !canManage) return;
    let active = true;
    let reading = false;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const next = await api.assistSnapshot({ projectId: project.id, mode });
        if (active) {
          setState(next);
          setConnectionError("");
        }
      } catch (error) {
        if (active) {
          setState((current) => ({ ...current, connected: false }));
          setConnectionError(errorMessage(error));
        }
      } finally {
        reading = false;
      }
    }
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project.id, canManage, mode]);

  async function command(input: Omit<Command, "projectId">) {
    const projectId = project.id;
    setBusy(input.action);
    setNotice("");
    try {
      const next = await api.assistCommand({ ...input, projectId, mode,
        ...(!saveMode ? { params: { gameSessionId: state.gameSessionId, ...input.params } } : {}),
        ...(saveMode ? { expectedSaveSha256: input.expectedSaveSha256 ?? state.saveFile?.sha256 } : {}) });
      if (currentProjectId.current !== projectId) return false;
      setState(next);
      setNotice(
        [
          "setThrough",
          "setMoveSpeed",
          "setEncounter",
          "jump",
          "transfer",
          "restoreMovement",
        ].includes(input.action)
          ? input.action === "restoreMovement"
            ? tr("移动设置恢复完成，游戏后续改动的设置会保留。")
            : tr("移动与探索的修改已生效。")
          : input.action === "setNamedVariable"
            ? tr("已修改当前运行值；是否随存档保留由游戏决定，请重新读档核对。")
            : tr("修改已立即应用。请在游戏内存档，保留这些改动。"),
      );
      if (
        input.action === "setNamedVariable" &&
        input.params?.scope === "persistent"
      )
        setNotice(tr("所有存档共用的变量已修改并保存。"));
      if (saveMode) setNotice(next.changed === false
        ? tr("数值没有变化，未写入存档，也未创建新备份。")
        : tr("修改已写入所选存档，修改前的存档已备份。在游戏中读取这份存档后生效。"));
      return true;
    } catch (error) {
      if (currentProjectId.current === projectId) onError(error);
      return false;
    } finally {
      if (currentProjectId.current === projectId) setBusy("");
    }
  }
  async function launch() {
    const projectId = project.id;
    setBusy("launch");
    try {
      await api.launchGame({ projectId });
    } catch (error) {
      if (currentProjectId.current === projectId) onError(error);
    } finally {
      if (currentProjectId.current === projectId) setBusy("");
    }
  }
  async function openSave() {
    const projectId = project.id;
    setBusy("open-save");
    try {
      const next = await api.openAssistSave({ projectId });
      if (next && currentProjectId.current === projectId) {
        setState(next);
        setGoldDraft(null);
        setGoldSaveVersion(undefined);
        setEditing(null);
        setNotice(tr("存档已打开。选择下方数据进行修改。"));
        setConnectionError("");
      }
    } catch (error) { onError(error); }
    finally { if (currentProjectId.current === projectId) setBusy(""); }
  }
  async function showBackups() {
    const projectId = project.id;
    setBusy("list-backups");
    try {
      const data = await api.listAssistSaveBackups({ projectId });
      if (currentProjectId.current !== projectId) return;
      setBackups(data);
    } catch (error) { if (currentProjectId.current === projectId) onError(error); }
    finally { if (currentProjectId.current === projectId) setBusy(""); }
  }
  async function restoreSave(backupId: string) {
    if (!backups) return;
    const backup = backups.backups.find(item => item.id === backupId);
    if (!backup || backup.status !== "available") return;
    const projectId = project.id;
    setBusy("restore-save");
    try {
      const next = await api.restoreAssistSave({ projectId, backupId,
        ...(backup.targetAbsent ? { expectedAbsent: true } : { expectedSaveSha256: backup.currentSha256 }) });
      if (currentProjectId.current !== projectId) return;
      setState(next); setGoldDraft(null); setGoldSaveVersion(undefined); setEditing(null); setBackups(null);
      setNotice(next.backupCreated ? tr("备份已恢复，恢复前文件的原始内容也已另存备份。在游戏中读取这份存档后生效。") : tr("备份已恢复。在游戏中读取这份存档后生效。"));
    } catch (error) { if (currentProjectId.current === projectId) onError(error); }
    finally { if (currentProjectId.current === projectId) setBusy(""); }
  }
  async function configureLive() {
    const projectId = project.id, enabled = !liveEnabled;
    setBusy("configure-assist");
    try {
      const next = await api.configureAssist({ projectId, enabled });
      if (currentProjectId.current !== projectId) return;
      setLiveEnabled(next.assistEnabled !== false); setState({ connected: false }); setEditing(null); setSection("data");
      setNotice(enabled ? tr("实时辅助已开启。重新启动成品后连接。") : tr("实时辅助已关闭，下次启动也会保持关闭。已经修改的游戏进度和存档不会撤销。"));
    } catch (error) { if (currentProjectId.current === projectId) onError(error); }
    finally { if (currentProjectId.current === projectId) setBusy(""); }
  }
  function selectTab(next: AssistTab) {
    setTab(next);
    setSearch("");
    setPage(0);
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % visibleTabs.length
        : event.key === "ArrowLeft"
          ? (index + visibleTabs.length - 1) % visibleTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? visibleTabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(visibleTabs[next].id);
    document.getElementById(`assist-tab-${visibleTabs[next].id}`)?.focus();
  }

  return (
    <>
      <Heading
        title={tr("游玩辅助")}
        description={
          saveMode
            ? tr("先关闭游戏，再打开存档修改数据。每次修改前自动备份，在游戏中读档后生效。")
            : !liveEnabled
              ? tr("实时辅助已关闭，成品仍可正常游玩。需要查看或修改游戏状态时，先开启实时辅助，再从这里启动成品。")
            : tr("从工作台启动汉化成品，查看并修改金钱、物品和游戏状态。可用功能按游戏显示。")
        }
      >
        <span className={`status ${connected ? "ready" : "paused"}`}>
          <i />
          {saveMode ? connected ? tr("存档已打开") : tr("选择游戏存档") : !liveEnabled ? tr("实时辅助已关闭") : connected
            ? tr("已连接游戏")
            : state.connected
              ? tr("开始游戏或读档")
              : tr("启动汉化成品")}
        </span>
      </Heading>
      {nativeDesktop && canManage && modes.length > 1 && (
        <nav className="assist-section-nav" aria-label={tr("辅助模式")}>
          {modes.map((item) => <button key={item} type="button" className={mode === item ? "selected" : ""}
            disabled={Boolean(busy)}
            onClick={() => { setSelectedMode(item); setSection("data"); setEditing(null); }}>
            {item === "save" ? tr("存档辅助") : tr("实时辅助")}
          </button>)}
        </nav>
      )}
      {nativeDesktop && canManage && !saveMode && (
        <section className="panel">
          <div className="panel-heading"><h2>{liveEnabled ? tr("实时辅助已开启") : tr("实时辅助已关闭")}</h2>
            <Button busy={busy === "configure-assist"} disabled={Boolean(busy)} onClick={() => void configureLive()}>{liveEnabled ? tr("关闭实时辅助") : tr("开启实时辅助")}</Button>
          </div>
          <p className="muted">{tr("更改前请关闭由工作台启动的游戏。关闭后不再连接，也不会撤销已改的剧情或存档；RPG Maker XP / VX / VX Ace 的最新成品会恢复辅助安装前的脚本，其他引擎停止辅助会话。")}</p>
          {project.assistance?.status === "install_failed" && !connected && (
            <>
              <p className="muted">{tr("上次辅助安装未完成，已恢复原文件，普通游戏仍可游玩。先关闭游戏，再重新安装并连接。")}</p>
              <Button busy={busy === "launch"} disabled={Boolean(busy) || !liveEnabled || !project.builds.length} onClick={() => void launch()}>{tr("重新安装并连接")}</Button>
            </>
          )}
        </section>
      )}
      {nativeDesktop && canManage && saveMode && (
        <section className="panel">
          <div className="panel-heading"><h2><FileArchive size={18} />{tr(" 游戏存档")}</h2>
            <div className="row-actions">
              <Button onClick={() => void openSave()} busy={busy === "open-save"} disabled={Boolean(busy)}>{tr("选择存档")}</Button>
              {project.builds.length > 0 && <Button onClick={() => void launch()} busy={busy === "launch"} disabled={Boolean(busy)}>{tr("启动成品")}</Button>}
            </div>
          </div>
          <p className="body-copy">{state.saveFile?.path || tr("关闭游戏后选择存档，修改完成再启动游戏并读档。")}</p>
          <div className="row-actions">
            <Button busy={busy === "list-backups"} disabled={Boolean(busy)} onClick={() => void showBackups()}>{tr("恢复存档备份")}</Button>
            {state.saveFile?.backupDir && <Button onClick={() => void api.openPath({ path: state.saveFile!.backupDir! }).catch(onError)}>{tr("打开备份目录")}</Button>}
          </div>
        </section>
      )}
      {connectionError && (
        <div className="banner error" role="status">
          {connectionError}
        </div>
      )}
      {nativeDesktop && canManage && rpgSections && liveEnabled && (
        <nav className="assist-section-nav" aria-label={tr("游玩辅助功能")}>
          {(
            [
              { id: "data", label: tr("角色与数据") },
              { id: "exploration", label: tr("移动与探索") },
              { id: "gallery", label: tr("回想与图鉴") },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "selected" : ""}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => {
                setSection(item.id);
                setNotice("");
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}
      {notice && (
        <div className="banner success" role="status">
          <Wifi size={17} />
          <span>{notice}</span>
        </div>
      )}
      {!nativeDesktop || !canManage ? (
        <section className="panel">
          <div className="panel-heading">
            <h2><EngineLabel engine={project.engine} label={engine?.name} /></h2>
            <span className="tag">{tr("可用功能")}</span>
          </div>
          <p className="body-copy">
            {!nativeDesktop
              ? tr("在桌面版中启动汉化成品后，即可连接游戏并使用辅助功能。")
              : uiMessage(project.assistance?.detail) || uiMessage(engine?.detail) || tr("完成游戏识别后，这里会显示可用功能。")}
          </p>
          <div className="capability-list">
            <div>
              <span>{tr("文字提取")}</span>
              <strong>{engine?.extract ? tr("可使用") : tr("需要适配")}</strong>
            </div>
            <div>
              <span>{tr("制作独立汉化版")}</span>
              <strong>{engine?.build ? tr("可使用") : tr("需要适配")}</strong>
            </div>
            <div>
              <span>{tr("游玩辅助")}</span>
              <strong>{supported ? tr("桌面版可使用") : tr("需要适配")}</strong>
            </div>
          </div>
        </section>
      ) : section === "gallery" && rpgSections && liveEnabled ? (
        <AssistGallery
          key={project.id}
          projectId={project.id}
          state={state}
          onState={(next) => {
            if (currentProjectId.current === project.id) setState(next);
          }}
        />
      ) : !connected ? (
        <Empty
          title={
            saveMode ? tr("选择要修改的存档") : !liveEnabled ? tr("实时辅助已关闭，仍可正常游玩") : state.connected ? tr("开始游戏或读取存档") : tr("启动汉化成品并进入游戏")
          }
          action={
            saveMode ? <Button variant="primary" busy={busy === "open-save"} onClick={() => void openSave()}><FileArchive size={17} />{tr("选择游戏存档")}</Button> : <Button
              variant="primary"
              busy={busy === "launch"}
              disabled={!project.builds.length}
              onClick={() => void launch()}
            >
              <Play size={17} />{tr("启动最新成品")}</Button>
          }
        >
          {!saveMode && !liveEnabled
            ? tr("当前不会连接或显示游戏状态。点击上方“开启实时辅助”后，再启动最新成品。已经修改的剧情和存档不会撤销。")
            : uiMessage(state.detail) || (saveMode ? tr("先关闭游戏，再选择存档。每次修改前会自动备份；修改后启动游戏，读取这份存档即可生效。") : tr("点击“启动最新成品”，再在游戏中开始新游戏或读取存档。这里会自动显示当前游戏状态。"))}
          {!saveMode && !project.builds.length && tr("先在“成品与导出”生成汉化版。")}
        </Empty>
      ) : section === "exploration" && rpgSections ? (
        <AssistExploration
          key={project.id}
          projectId={project.id}
          state={state}
          busy={Boolean(busy)}
          onCommand={command}
        />
      ) : (
        <>
          <div className="assist-session">
            <span>
              <Wifi size={16} />
              <EngineLabel engine={state.engine || project.engine} label={engine?.name} /> · {saveMode ? tr("存档状态") : tr("实时状态")}
            </span>
            <small>
              {saveMode ? tr("每次修改都会写入所选存档，并备份修改前的文件。在游戏中读档后生效。") : namedData
                ? tr("变量修改当前运行值。每项说明是否已知可保存；未确认的字段需在游戏中存档、读档后核对。")
                : tr("修改立即生效。在游戏内存档后，即可保留改动。")}
            </small>
          </div>
          {(state.gold !== undefined ||
            actions.has("setGold") ||
            state.actors !== undefined) && (
            <div className="assist-top">
              {(state.gold !== undefined || actions.has("setGold")) && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>
                      <Coins size={18} />{tr("金钱")}</h2>
                    <span className="tag">{tr("当前持有")}</span>
                  </div>
                  <div className="assist-money">
                    {(state.gold ?? 0).toLocaleString(uiLocale)}
                    <span>G</span>
                  </div>
                  {actions.has("setGold") && (
                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        try {
                          const value = parseAssistValue(
                            goldDraft ?? String(state.gold ?? 0),
                            "number",
                            state.limits?.gold || { integer: true, min: 0, max: 99999999 },
                          ) as number;
                          void command({ action: "setGold", value, expectedSaveSha256: goldSaveVersion,
                            params: { gameSessionId: goldDraft === null ? state.gameSessionId : goldSessionVersion } }).then(
                            (ok) => {
                              if (ok) { setGoldDraft(null); setGoldSaveVersion(undefined); }
                            },
                          );
                        } catch (error) {
                          onError(error);
                        }
                      }}
                    >
                      <input
                        aria-label={tr("新的游戏金钱")}
                        type="number"
                        min={state.limits?.gold?.min ?? 0}
                        max={state.limits?.gold?.max ?? 99999999}
                        step="1"
                        value={goldDraft ?? String(state.gold ?? 0)}
                        onChange={(event) => { if (goldDraft === null) { setGoldSaveVersion(state.saveFile?.sha256); setGoldSessionVersion(state.gameSessionId); } setGoldDraft(event.target.value); }}
                        required
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        busy={busy === "setGold"}
                        disabled={Boolean(busy)}
                      >{tr("设置金钱")}</Button>
                    </form>
                  )}
                  <p className="assist-hint muted">{tr("输入修改后的金钱总额，再点击“设置金钱”。")}</p>
                </section>
              )}
              {state.actors !== undefined && (
                <section className="panel assist-party-panel">
                  <div className="panel-heading">
                    <h2>
                      <Heart size={18} />{tr("队伍状态")}{" "}
                      <span className="assist-count">
                        {state.actors?.length ?? 0}{tr(" 人")}</span>
                    </h2>
                    {actions.has("heal") && (
                      <Button
                        busy={busy === "heal"}
                        disabled={Boolean(busy)}
                        onClick={() => void command({ action: "heal" })}
                      >{tr("恢复全队")}</Button>
                    )}
                  </div>
                  <div className="assist-party">
                    {(state.actors ?? []).map((actor) => {
                      const metrics: {
                        label: string;
                        value: number | undefined;
                        max?: number;
                        min: number;
                        action: Command["action"];
                      }[] = [
                        {
                          label: tr("等级"),
                          value: actor.level,
                          max: actor.maxLevel,
                          min: 1,
                          action: "setLevel",
                        },
                        {
                          label: tr("经验值"),
                          value: actor.exp,
                          min: 0,
                          action: "setExp",
                        },
                        {
                          label: "HP",
                          value: actor.hp,
                          max: actor.maxHp,
                          min: 0,
                          action: "setHp",
                        },
                        {
                          label: mpLabel,
                          value: actor.mp,
                          max: actor.maxMp,
                          min: 0,
                          action: "setMp",
                        },
                      ];
                      return (
                        <article className="assist-actor" key={actor.id}>
                          <header>
                            <strong>{actor.name}</strong>
                            <small>{tr("角色 #")}{actor.id}</small>
                          </header>
                          <div className="assist-actor-values">
                            {metrics
                              .filter((metric) => metric.value !== undefined)
                              .map((metric) => {
                                const editLimit = metric.action === "setHp" ? state.editLimits?.hp : metric.action === "setMp" ? state.editLimits?.mp : undefined;
                                const content = (
                                  <>
                                    <span>{metric.label}</span>
                                    <strong>
                                      {metric.value!.toLocaleString(uiLocale)}
                                      {metric.max !== undefined &&
                                        metric.action !== "setLevel" && (
                                          <small>
                                            {" "}
                                            / {metric.max.toLocaleString(uiLocale)}
                                          </small>
                                        )}
                                    </strong>
                                    {actions.has(metric.action) && (
                                      <em>{tr("修改")}</em>
                                    )}
                                  </>
                                );
                                return actions.has(metric.action) ? (
                                  <button
                                    key={metric.label}
                                    type="button"
                                    disabled={Boolean(busy)}
                                    aria-label={tr`修改${actor.name}的${metric.label}`}
                                    onClick={() =>
                                      setEditing({
                                        id: actor.id,
                                        name: actor.name,
                                        label: metric.label,
                                        value: metric.value!,
                                        action: metric.action,
                                        min: editLimit?.min ?? metric.min,
                                        max: editLimit?.max ?? metric.max ?? 99999999,
                                        integer: editLimit?.integer ?? true,
                                        expectedSaveSha256: state.saveFile?.sha256,
                                        params: { gameSessionId: state.gameSessionId },
                                      })
                                    }
                                  >
                                    {content}
                                  </button>
                                ) : (
                                  <div key={metric.label}>{content}</div>
                                );
                              })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {!state.actors?.length && (
                    <p className="muted assist-hint">{tr("当前队伍为空，角色加入后显示状态。")}</p>
                  )}
                  {actorEditing && (
                    <p className="assist-hint muted">{tr("点击角色数值可调整。")}{actions.has("heal") && tr`恢复全队会补满 HP、${mpLabel} 并解除异常状态。`}
                    </p>
                  )}
                </section>
              )}
            </div>
          )}
          <section className="panel">
            <div
              className="assist-tabs"
              role="tablist"
              aria-label={tr("游戏数据类型")}
            >
              {visibleTabs.map(({ id, title, Icon }, index) => (
                <button
                  key={id}
                  id={`assist-tab-${id}`}
                  role="tab"
                  type="button"
                  aria-selected={activeTab === id}
                  aria-controls="assist-data-panel"
                  tabIndex={activeTab === id ? 0 : -1}
                  onClick={() => selectTab(id)}
                  onKeyDown={(event) => tabKey(event, index)}
                  className={activeTab === id ? "selected" : ""}
                >
                  <Icon size={16} />
                  {id === "variables" && namedData ? tr("游戏变量") : title}
                  <span>{assistRows(state, id).length.toLocaleString(uiLocale)}</span>
                </button>
              ))}
            </div>
            <label className="search-field assist-search">
              <Search size={17} />
              <input
                aria-label={tr("搜索游戏数据")}
                placeholder={
                  activeTab === "items"
                    ? tr("搜索名称、编号、物品 / 武器 / 防具")
                    : namedData
                      ? tr("搜索变量名、当前游戏或所有存档共用")
                      : tr("搜索名称或编号")
                }
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div
              className="assist-data"
              id="assist-data-panel"
              role="tabpanel"
              aria-labelledby={`assist-tab-${activeTab}`}
              tabIndex={0}
            >
              <div className="assist-data-header">
                <span>{namedData ? tr("适用范围 / 变量名") : tr("编号 / 名称")}</span>
                <span>{activeTab === "items" ? tr("持有数量") : tr("当前值")}</span>
                <span>{tr("操作")}</span>
              </div>
              {rows.rows.map((item) => (
                <div
                  className="assist-data-row"
                  key={
                    item.params
                      ? JSON.stringify([item.params.scope, item.params.store, item.params.name])
                      : `${item.type || activeTab}-${item.id}`
                  }
                >
                  <div>
                    <small>
                      {item.id !== undefined && `#${item.id} · `}
                      {item.category}
                      {item.params?.name && rows.rows.some((other) => other !== item && other.name === item.name) && tr` · 标识 ${item.params.name.split(":")[0].slice(0, 16)}`}
                    </small>
                    <strong title={item.params?.name}>{item.name || tr`未命名${item.category}`}</strong>
                  </div>
                  <span
                    className={
                      activeTab === "variables"
                        ? "variable-value"
                        : item.value === true
                          ? "assist-switch-on"
                          : ""
                    }
                  >
                    {typeof item.value === "boolean"
                      ? item.value
                        ? trc("switch", "开启")
                        : trc("switch", "关闭")
                      : item.value === ""
                        ? tr("（空文字）")
                        : String(item.value)}
                  </span>
                  {actions.has(item.action) ? (
                    <Button
                      disabled={Boolean(busy)}
                      aria-label={tr`修改${item.category} ${item.id !== undefined ? `#${item.id} ` : ""}${item.name}`}
                      onClick={() =>
                        setEditing({
                          ...item,
                          label: activeTab === "items" ? tr("持有数量") : tr("修改后的值"),
                          min: item.min ?? (activeTab === "items" ? 0 : undefined),
                          max: item.max ?? (activeTab === "items" ? 99999999 : undefined),
                          integer: item.integer ?? activeTab === "items",
                          fixedType: saveMode,
                          expectedSaveSha256: state.saveFile?.sha256,
                          params: { ...item.params, gameSessionId: state.gameSessionId },
                        })
                      }
                    >{tr("修改")}</Button>
                  ) : (
                    <span className="muted">{tr("仅供查看")}</span>
                  )}
                </div>
              ))}
              {rows.total === 0 && (
                <p className="muted spaced">
                  {search
                    ? tr("匹配 0 条。更换名称或编号后重新搜索。")
                    : saveMode
                      ? tr("所选存档中，这类数据共 0 条。可选择其他存档查看。")
                      : tr("当前读取到 0 条数据。继续游玩后，这里会自动更新。")}
                </p>
              )}
            </div>
            <div className="assist-pagination" aria-label={tr("游戏数据分页")}>
              <span aria-live="polite">
                {rows.start}–{rows.end} / {rows.total.toLocaleString(uiLocale)}{tr(" 条")}</span>
              <div>
                <Button
                  aria-label={tr("上一页游戏数据")}
                  disabled={rows.page === 0}
                  onClick={() => setPage(rows.page - 1)}
                >
                  <ChevronLeft size={15} />{tr("上一页")}</Button>
                <span>
                  {rows.page + 1} / {rows.pages}
                </span>
                <Button
                  aria-label={tr("下一页游戏数据")}
                  disabled={rows.page + 1 >= rows.pages}
                  onClick={() => setPage(rows.page + 1)}
                >{tr("下一页")}<ChevronRight size={15} />
                </Button>
              </div>
            </div>
            <p className="muted assist-hint">
              {state.truncated && tr`当前列表只包含部分字段：${uiMessage(state.limitReason) || tr("已达到本轮扫描上限")}。搜索仅覆盖已读取的字段。`}
              {namedData
                ? tr("按列表中的变量名称查找。每项会标明适用于当前游戏，还是所有存档共用。")
                : tr("按真实编号或作者设置的名称查找，无名称也可修改。不需要 AI 确认。开关和变量可能控制剧情、回想或计数，含义由游戏决定；建议先在游戏内另存一份存档，再逐项尝试。")}
            </p>
          </section>
        </>
      )}
      {backups && <AssistSaveBackupDialog data={backups} busy={busy === "restore-save"} onClose={() => setBackups(null)} onRestore={id => void restoreSave(id)} />}
      {editing && (
        <AssistEdit
          key={`${editing.action}-${editing.type}-${editing.id}-${editing.name}`}
          target={editing}
          onClose={() => setEditing(null)}
          onSave={async (value) => {
            const ok = await command({
              action: editing.action,
              id: editing.id,
              type: editing.type,
              value,
              params: editing.params,
              expectedSaveSha256: editing.expectedSaveSha256,
            });
            if (ok) setEditing(null);
            return ok;
          }}
        />
      )}
    </>
  );
}

function AssistEdit({
  target,
  onClose,
  onSave,
}: {
  target: EditTarget;
  onClose: () => void;
  onSave: (value: string | number | boolean) => Promise<boolean>;
}) {
  const [value, setValue] = useState(String(target.value));
  const [type, setType] = useState(typeof target.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const parsed = parseAssistValue(value, type, target);
      setBusy(true);
      if (!(await onSave(parsed))) setError(tr("请查看页面中的错误说明，处理后再次点击“确认修改”。"));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${target.name || `#${target.id}`} · ${target.label}`}
      onClose={onClose}
      busy={busy}
      error={error}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className="dialog-intro">{tr("当前值：")}{String(target.value)}
          {target.max !== undefined && tr` · 上限 ${target.max.toLocaleString(uiLocale)}`}
        </p>
        {target.hint && <p className="dialog-intro">{target.hint}</p>}
        {target.action === "setVariable" && !target.fixedType && (
          <label className="field">
            <span>{tr("内容类型")}</span>
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value as typeof type);
                setValue(event.target.value === "boolean" ? "false" : "");
              }}
            >
              <option value="number">{tr("数字")}</option>
              <option value="string">{tr("文字")}</option>
              <option value="boolean">{tr("开启或关闭")}</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>{target.label}</span>
          {type === "boolean" ? (
            <select
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="true">{tr("开启 / true")}</option>
              <option value="false">{tr("关闭 / false")}</option>
            </select>
          ) : (
            <input
              autoFocus
              type={type === "number" ? "number" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required={type === "number"}
              min={target.min}
              max={target.max}
              step={target.integer ? 1 : "any"}
            />
          )}
        </label>
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>{tr("取消")}</Button>
          <Button type="submit" variant="primary" busy={busy}>{tr("确认修改")}</Button>
        </div>
      </form>
    </Modal>
  );
}
