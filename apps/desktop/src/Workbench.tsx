import { tr, uiLocale, uiLanguage } from "../shared/ui-language.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Search,
  Save,
  RefreshCw,
} from "lucide-react";
import type {
  ImportResult,
  ProjectDetail,
  TextPage,
  TextUnit,
} from "../../../packages/contracts/index";
import { api, errorMessage } from "./api";
import { Button, Empty, Heading, LoadingState, Modal, PathField } from "./components";
import { ProgressPanel, readProgress } from "./status";

const pageSize = 40;
const kindNames: Record<string, string> = {
  dialogue: tr("对话"),
  message: tr("对话"),
  choice: tr("选项"),
  name: tr("名称"),
  description: tr("说明"),
  script: tr("脚本显示文字"),
  database: tr("游戏资料"),
  text: tr("文字"),
  nickname: tr("称号或昵称"),
  database_nickname: tr("称号或昵称"),
  speaker: tr("说话人名称"),
  speaker_name: tr("说话人名称"),
  character_name: tr("角色名称"),
  database_name: tr("名称"),
  database_profile: tr("人物简介"),
  database_description: tr("说明"),
  map_display_name: tr("地图名称"),
  actor_attribute: tr("角色名称"),
  system_text: tr("系统文字"),
  system_type: tr("类型名称"),
  system_term: tr("系统用语"),
  display_name: tr("显示名称"),
  display_attribute: tr("显示属性"),
  script_display: tr("动态显示文字"),
  picture_text: tr("图片文字"),
};
const statusNames = {
  pending: tr("待翻译"),
  translated: tr("已翻译"),
  proofread: tr("校对已完成"),
  skipped: tr("待重试"),
};

export default function Workbench({
  project,
  onError,
  onNotice,
  onRefresh,
  onDirtyChange,
}: {
  project: ProjectDetail;
  onError: (error: unknown) => void;
  onNotice: (notice: string) => void;
  onRefresh: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [result, setResult] = useState<TextPage>({ units: [], total: 0 });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [reviewRoundId, setReviewRoundId] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [pageDraft, setPageDraft] = useState("0");
  const [selected, setSelected] = useState<TextUnit | null>(null);
  const [translation, setTranslation] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exchange, setExchange] = useState<"export" | "import" | null>(null);
  const [mobileEditor, setMobileEditor] = useState(false);
  const [pendingUnit, setPendingUnit] = useState<TextUnit | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [reload, setReload] = useState(0);
  const loadVersion = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const draftRef = useRef({ translation, notes });
  draftRef.current = { translation, notes };
  const projectRef = useRef(project.id);
  projectRef.current = project.id;
  const dirtyRef = useRef(false);
  const dirty =
    selected !== null &&
    (translation !== selected.translation || notes !== selected.notes);
  dirtyRef.current = dirty;
  const textVersion = project.textVersion ?? project.updatedAt;
  const pageCount = Math.ceil(result.total / pageSize);
  const currentPage = result.total ? Math.floor(offset / pageSize) + 1 : 0;
  const viewingReview = filter === "reviewed";
  const viewRef = useRef("");
  viewRef.current = viewingReview ? `reviewed:${reviewRoundId ?? ""}` : "formal";
  const reviewVersion = viewingReview ? JSON.stringify(project.reviewRound) : "";
  const unfinishedReview = !project.reviewRound?.committedAt &&
    ["scene", "consistency", "resolve", "commit"].includes(project.reviewRound?.stage ?? "");

  useEffect(() => {
    setPageDraft(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    onDirtyChange(dirty);
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  useEffect(() => {
    setOffset(0);
    setSelected(null);
    setSearch("");
    setFilter("all");
    setReviewRoundId(undefined);
    setTranslation("");
    setNotes("");
    setMobileEditor(false);
  }, [project.id]);

  useEffect(() => {
    const version = ++loadVersion.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.listText({
          projectId: project.id,
          offset,
          limit: pageSize,
          search: search.trim(),
          filter,
          ...(viewingReview ? { reviewRoundId } : {}),
        });
        if (version !== loadVersion.current) return;
        setResult(next);
        const finalOffset = Math.max(0, (Math.ceil(next.total / pageSize) - 1) * pageSize);
        if (offset > finalOffset) {
          setOffset(finalOffset);
          return;
        }
        const current = selectedRef.current;
        const refreshed = next.units.find((unit) => unit.id === current?.id);
        const active =
          refreshed || (!dirtyRef.current ? next.units[0] : current);
        if (active && !dirtyRef.current) {
          setSelected(active);
          setTranslation(active.translation);
          setNotes(active.notes);
        }
        if (!next.units.length && !dirtyRef.current) setSelected(null);
      } catch (error) {
        if (version === loadVersion.current) onError(error);
      } finally {
        if (version === loadVersion.current) setLoading(false);
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      loadVersion.current++;
    };
  }, [project.id, textVersion, offset, search, filter, reviewRoundId, reviewVersion, reload]);

  function changeFilter(next: string) {
    if ((viewingReview || next === "reviewed") && dirty) {
      onNotice(tr("此条译文或备注有待保存的修改，请先保存，或读取已保存版本后再切换查看。"));
      return;
    }
    if (viewingReview || next === "reviewed") {
      setSelected(null);
      setTranslation("");
      setNotes("");
      setResult({ units: [], total: 0 });
      setMobileEditor(false);
    }
    if (next === "reviewed") setReviewRoundId(project.reviewRound?.id);
    setFilter(next);
    setOffset(0);
    setPageDraft("1");
  }

  function viewSceneResults() {
    if (dirty) { changeFilter("reviewed"); return; }
    changeFilter("reviewed");
    setSearch("");
    setReload(value => value + 1);
  }

  function jumpPage(event: FormEvent) {
    event.preventDefault();
    if (loading || !pageCount) return;
    const value = pageDraft.trim();
    const page = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      onNotice(tr`请输入 1 到 ${pageCount} 之间的整数页码`);
      return;
    }
    setPageDraft(String(page));
    setOffset((page - 1) * pageSize);
  }

  function choose(unit: TextUnit) {
    if (unit.id === selected?.id) {
      setMobileEditor(true);
      return;
    }
    if (dirty) {
      setPendingUnit(unit);
      return;
    }
    setSelected(unit);
    setTranslation(unit.translation);
    setNotes(unit.notes);
    setMobileEditor(true);
  }

  async function save(action: 'save' | 'confirm' = 'save') {
    if (!selected || saving || viewingReview) return;
    const projectId = project.id;
    const view = viewRef.current;
    const submitted = { translation, notes };
    setSaving(true);
    try {
      const input = {
        projectId,
        unitId: selected.id,
        translation,
        notes,
        expectedRevision: selected.revision,
        action,
      };
      const saved = await api.saveText(input);
      if (projectRef.current !== projectId || viewRef.current !== view) return;
      if (selectedRef.current?.id === saved.id) {
        setSelected(saved);
        if (draftRef.current.translation === submitted.translation)
          setTranslation(saved.translation);
        if (draftRef.current.notes === submitted.notes) setNotes(saved.notes);
      }
      setResult((current) => ({
        ...current,
        units: current.units.map((unit) =>
          unit.id === saved.id ? saved : unit,
        ),
      }));
      onNotice(action === 'confirm' ? tr("此条文字已由你明确确认；关联文字的独立疑点保持不变") : tr("译文与备注已保存，未自动标记为已校对"));
      await onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }
  async function readLatest() {
    if (!selected) return;
    const projectId = project.id;
    const view = viewRef.current;
    const unitId = selected.id;
    const submitted = { translation, notes };
    setLoading(true);
    try {
      const latest = await api.listText({
        projectId,
        search: unitId,
        limit: 10,
      });
      const unit = latest.units.find((item) => item.id === unitId);
      if (!unit) throw new Error(tr("此条文字需要重新查找。请在文字工作台搜索原文，再打开对应条目。"));
      if (
        projectRef.current !== projectId ||
        viewRef.current !== view ||
        selectedRef.current?.id !== unitId
      )
        return;
      setSelected(unit);
      if (draftRef.current.translation === submitted.translation)
        setTranslation(unit.translation);
      if (draftRef.current.notes === submitted.notes) setNotes(unit.notes);
      setReloadConfirm(false);
      setReload((value) => value + 1);
    } catch (error) {
      onError(error);
    } finally {
      if (viewRef.current === view) setLoading(false);
    }
  }

  return (
    <>
      <Heading
        title={tr("文字工作台")}
        description={tr("查看原文和上下文，修改译文，或用文字工作包交换外部翻译成果。")}
      >
        <Button onClick={() => setExchange("import")}>
          <ArrowDownToLine size={16} />
          {tr("导入文字工作包")}
        </Button>
        <Button onClick={() => setExchange("export")}>
          <ArrowUpFromLine size={16} />
          {tr("导出文字工作包")}
        </Button>
      </Heading>
      <ProgressPanel progress={readProgress(project)} compact onViewSceneReview={viewSceneResults} />
      <div className="workbench-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label={tr("搜索文字")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
              setPageDraft("1");
            }}
            placeholder={tr("搜索原文、译文或条目编号")}
          />
        </label>
        <select
          aria-label={tr("筛选文字状态")}
          value={filter}
          onChange={(event) => changeFilter(event.target.value)}
        >
          <option value="all">{tr("全部文字")}</option>
          <option value="pending">{tr("待翻译")}</option>
          <option value="translated">{tr("已翻译")}</option>
          <option value="reviewed">{tr("场景审阅结果（已保存）")}</option>
          <option value="proofread">{tr("校对已完成")}</option>
          <option value="needs_evidence">{tr("待核对疑点")}</option>
          <option value="skipped">{tr("待重试")}</option>
          <option value="changed">{tr("已修改")}</option>
        </select>
        <span className="muted">{result.total.toLocaleString(uiLocale)} {tr("条")}</span>
      </div>
      {viewingReview && <p className="workbench-view-note" role="status">
        <strong>{tr("场景审阅结果（已保存）")}</strong>{" · "}
        {result.sceneReview?.committed
          ? tr("本轮校对已完成；这里保留场景审阅时的结果，定稿后的译文请查看“校对已完成”。")
          : tr("仅查看已保存的场景校对译文与备注；收尾检查后统一更新当前译文。")}
        <Button variant="ghost" onClick={() => changeFilter("all")}>{tr("返回全部文字")}</Button>
      </p>}
      {project.total === 0 ? (
        project.status === "preparing" || project.status === "running" ? (
          <LoadingState title={tr("正在提取文字")} detail={tr("已提取的文字与上下文会显示在这里。可在“制作总览”查看当前进度。")} />
        ) : (
          <Empty title={tr("当前项目已提取 0 条文字")}>
            {tr("打开“制作总览”，查看文件处理进度和下一步操作。")}
          </Empty>
        )
      ) : (
        <div className={`workbench-grid ${mobileEditor ? "show-editor" : ""}`}>
          <section
            className="unit-list"
            aria-label={tr("文字条目列表")}
            aria-busy={loading}
          >
            {result.units.length ? (
              result.units.map((unit) => (
                <button
                  className={`unit-item ${selected?.id === unit.id ? "selected" : ""}`}
                  onClick={() => choose(unit)}
                  key={unit.id}
                >
                  <div>
                    <span className="tag">
                      {kindNames[unit.kind] || tr("其他游戏文字")}
                    </span>
                    <small
                      className={
                        unit.status === "pending" ? "muted" : "accent-text"
                      }
                    >
                      {viewingReview ? tr("场景已审阅 · 已保存") : unit.review?.status === "needs_evidence" ? unit.review.reviewId.startsWith('external-question-') ? tr("待确认 · 需再核对") : tr("已审阅 · 需再核对") : statusNames[unit.status]}
                    </small>
                  </div>
                  <strong>
                    {unit.translation || unit.source || tr("空文字条目")}
                  </strong>
                  <p>{unit.translation ? unit.source : unit.id}</p>
                </button>
              ))
            ) : (
              <div className="list-empty" role="status">
                {loading && <LoaderCircle size={18} className="spin" aria-hidden="true" />}
                {loading ? tr("正在检索文字…")
                  : filter === "proofread" && project.proofread === 0 && unfinishedReview ? <>
                    <strong>{tr("本轮校对尚未完成")}</strong>
                    <p>{tr("场景审阅结果会持续保存，收尾检查后才会显示在“校对已完成”中。")}</p>
                    <Button onClick={viewSceneResults}>{tr("查看场景审阅结果")}</Button>
                  </> : viewingReview && result.sceneReview?.state === "changed" ? <>
                    <strong>{tr("已开始新一轮校对")}</strong>
                    <p>{tr("当前查看的轮次已结束，请重新选择本轮结果。")}</p>
                    <Button onClick={viewSceneResults}>{tr("查看本轮场景结果")}</Button>
                  </> : viewingReview ? (search.trim()
                    ? tr("没有符合搜索条件的场景审阅结果，请调整搜索词。")
                    : tr("暂时没有已保存的场景审阅结果。校对结果保存后会显示在这里。"))
                  : tr("找到 0 条文字。请调整搜索词或筛选条件。")}
              </div>
            )}
            <form className="pagination" aria-label={tr("文字列表分页")} onSubmit={jumpPage} noValidate>
              <Button
                aria-label={tr("上一页")}
                disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
              >
                <ChevronLeft size={17} />
              </Button>
              <label className="page-jump-label">
                <span>{tr("第")}</span>
                <input
                  aria-label={tr("跳转页码")}
                  inputMode="numeric"
                  value={pageDraft}
                  disabled={loading || !pageCount}
                  onChange={(event) => setPageDraft(event.target.value)}
                />
                <span>/ {pageCount} {tr("页")}</span>
              </label>
              <Button type="submit" disabled={loading || !pageCount}>{tr("跳转")}</Button>
              <Button
                aria-label={tr("下一页")}
                disabled={offset + pageSize >= result.total || loading}
                onClick={() => setOffset(offset + pageSize)}
              >
                <ChevronRight size={17} />
              </Button>
              {loading && <span className="pagination-status" role="status">{tr("正在加载…")}</span>}
            </form>
          </section>
          <section className="unit-editor">
            {selected ? (
              <>
                <div className="editor-topline">
                  <button
                    className="mobile-back button ghost"
                    onClick={() => setMobileEditor(false)}
                  >
                    <ChevronLeft size={16} />
                    {tr("返回列表")}
                  </button>
                  <div>
                    <span className="tag gold">
                      {kindNames[selected.kind] || tr("其他游戏文字")}
                    </span>
                    <small>{tr("版本")} {selected.revision}</small>
                    {!viewingReview && selected.review?.status === "needs_evidence" && <small>{tr("当前译文已保留。可查看下方上下文手动修改，或到“制作总览”定向重审疑点。")}</small>}
                  </div>
                  {!viewingReview && <Button
                    variant="primary"
                    disabled={!dirty}
                    busy={saving}
                    onClick={() => void save()}
                  >
                    <Save size={16} />
                    {tr("保存译文")}
                  </Button>}
                  {!viewingReview && <Button
                    variant="ghost"
                    disabled={saving || loading}
                    onClick={() => void save('confirm')}
                  >
                    {tr("确认此条已核对")}
                  </Button>}
                </div>
                {!viewingReview && <Button
                  variant="ghost"
                  title={tr("将此条译文和备注更新为已保存的最新版本")}
                  disabled={saving || loading}
                  onClick={() =>
                    dirty ? setReloadConfirm(true) : void readLatest()
                  }
                >
                  <RefreshCw size={15} />
                  <span className="reload-text">{tr("读取已保存版本")}</span>
                </Button>}
                <p className="unit-id">{selected.id}</p>
                <div className="source-block">
                  <h2>{tr("原文")}</h2>
                  <p>{selected.source || tr("（空）")}</p>
                </div>
                <label className="field translation-field">
                  <span>
                    {viewingReview ? tr("场景校对译文") : tr("当前译文")}{" "}
                    {dirty && <small className="accent-text">{tr("本次修改待保存")}</small>}
                  </span>
                  <textarea
                    aria-label={viewingReview ? tr("场景校对译文") : tr("当前译文")}
                    readOnly={viewingReview}
                    value={translation}
                    onChange={(event) => setTranslation(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        void save();
                      }
                    }}
                    rows={7}
                    placeholder={tr("在这里填写译文")}
                  />
                </label>
                {selected.tokens.length > 0 && (
                  <div className="token-strip">
                    <span>{tr("译文中按原顺序保留以下符号")}</span>
                    {selected.tokens.map((token, index) => (
                      <code key={`${token}-${index}`}>{token}</code>
                    ))}
                  </div>
                )}
                <label className="field">
                  <span>{tr("译者备注")}</span>
                  <textarea
                    aria-label={tr("译者备注")}
                    readOnly={viewingReview}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={2}
                    placeholder={tr("术语、疑点或校对说明")}
                  />
                </label>
                <details className="context-block" open>
                  <summary>{tr("上下文与位置")}</summary>
                  <Context value={selected.context} />
                </details>
                <div className="editor-footnote">
                  <Check size={14} />{viewingReview ? tr("这里只查看已保存的场景校对结果。要手动修改当前译文，请返回“全部文字”。")
                    : <>{tr("按 Ctrl + Enter 保存译文与备注。其他任务已修改此条时，会提示你重新读取。")}
                      {selected.context.syncGroup ? tr("此条译文与其他显示位置关联，保存时会同步修改那些位置的译文，备注仅保存到此条。") : ""}</>}
                </div>
              </>
            ) : (
              <Empty title={tr("选择一条文字")}>{tr("点击文字列表中的条目，查看原文和上下文。")}</Empty>
            )}
          </section>
        </div>
      )}
      {exchange && (
        <Exchange
          mode={exchange}
          project={project}
          onClose={() => setExchange(null)}
          onError={onError}
          onNotice={onNotice}
          onImported={async () => {
            setReload((value) => value + 1);
            await onRefresh();
          }}
        />
      )}
      {pendingUnit && (
        <Modal title={tr("切换前处理本次修改")} onClose={() => setPendingUnit(null)}>
          <p className="dialog-intro">
            {tr("此条译文或备注有待保存的修改。选择“继续编辑”可返回保存；选择“放弃修改并切换”会丢弃本次修改，打开另一条文字。")}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPendingUnit(null)}>{tr("继续编辑")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setSelected(pendingUnit);
                setTranslation(pendingUnit.translation);
                setNotes(pendingUnit.notes);
                setMobileEditor(true);
                setPendingUnit(null);
              }}
            >
              {tr("放弃修改并切换")}
            </Button>
          </div>
        </Modal>
      )}
      {reloadConfirm && (
        <Modal
          title={tr("读取已保存版本")}
          onClose={() => setReloadConfirm(false)}
          busy={loading}
        >
          <p className="dialog-intro">
            {tr("读取此条译文和备注已保存的最新版本，并替换编辑框中的内容。本次待保存的修改会被丢弃。")}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setReloadConfirm(false)} disabled={loading}>
              {tr("继续编辑")}
            </Button>
            <Button
              variant="primary"
              busy={loading}
              onClick={() => void readLatest()}
            >
              {tr("放弃修改并读取")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Context({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (!entries.length)
    return (
      <p className="muted spaced">{tr("此条文字提供了条目编号和文字类型。可结合原文判断含义。")}</p>
    );
  const labels: Record<string, string> = {
    file: tr("原文所在文件"),
    path: tr("位置"),
    map: tr("地图"),
    event: tr("事件"),
    speaker: tr("说话人"),
    scene: tr("场景"),
    before: tr("前文"),
    after: tr("后文"),
    branch: tr("分支"),
    page: tr("事件页"),
    previous: tr("前文"),
    next: tr("后文"),
    route: tr("路线"),
    command: tr("事件指令"),
    record: tr("记录编号"),
    field: tr("显示字段"),
    line: tr("行号"),
    column: tr("列号"),
    index: tr("序号"),
    label: tr("场景标签"),
    node: tr("场景节点"),
    property: tr("属性名称"),
    attribute: tr("属性名称"),
    code: tr("事件指令编号"),
    indent: tr("事件指令层级"),
    syncGroup: tr("需使用相同译文的关联组"),
    adaptationLocator: tr("补充文字在文件中的位置"),
    adaptationSourceHash: tr("原文内容校验值"),
    controlFingerprint: tr("控制符校验值"),
    protectedControlSyntax: tr("需保留的控制符规则"),
  };
  return (
    <dl className="context-values">
      {entries.map(([key, content]) => (
        <div key={key}>
          <dt>{labels[key] || key}</dt>
          <dd>
            {typeof content === "string" || typeof content === "number"
              ? String(content)
              : JSON.stringify(content, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Exchange({
  mode,
  project,
  onClose,
  onError,
  onNotice,
  onImported,
}: {
  mode: "export" | "import";
  project: ProjectDetail;
  onClose: () => void;
  onError: (error: unknown) => void;
  onNotice: (notice: string) => void;
  onImported: () => Promise<void>;
}) {
  const [path, setPath] = useState(
    mode === "export"
      ? `${project.workspaceDir}\\${project.name}${uiLanguage === "en" ? "-text-package.zip" : "-文字工作包.zip"}`
      : "",
  );
  const [profile, setProfile] = useState<"json" | "text">("json");
  const [taskStage, setTaskStage] = useState<'translation' | 'proofreading'>(
    ['proofreading', 'review-issues'].includes(project.runMode ?? 'all') ? 'proofreading' : 'translation',
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [localError, setLocalError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setLocalError("");
    try {
      if (mode === "export") {
        await api.exportPackage({
          projectId: project.id,
          filePath: path.trim(),
          profile,
          taskStage,
        });
        onNotice(tr`文字工作包已保存到 ${path.trim()}`);
        onClose();
      } else {
        const imported = await api.importPackage({
          projectId: project.id,
          filePath: path.trim(),
        });
        setResult(imported);
        await onImported();
        onNotice(
          imported.conflicts.length
            ? tr`工作包有 ${imported.conflicts.length} 条冲突，本次整包暂不导入。请核对下方差异后重新导入。`
            : tr`已导入 ${imported.accepted} 条，沿用当前内容 ${imported.unchanged} 条。`,
        );
      }
    } catch (error) {
      setLocalError(errorMessage(error));
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={mode === "export" ? tr("导出文字工作包") : tr("导入文字工作包")}
      error={localError}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className="dialog-intro">
          {mode === "export"
            ? tr("导出 ZIP 文件，交给外部 AI 或译者翻译、校对。工作包包含原文、已有译文、上下文和阅读说明；处理后将工作包导回这里。")
            : tr("选择处理后的 ZIP 工作包。软件会比较导出时的版本、项目当前版本和包内的新版本。译文或备注发生冲突时，整包暂不导入，当前项目保持原样；核对并统一两边的修改后可重新导入。")}
        </p>
        <PathField
          label={mode === "export" ? tr("工作包保存位置") : tr("处理后的工作包")}
          kind={mode === "export" ? "save" : "package"}
          value={path}
          onChange={setPath}
          onError={onError}
        />
        {mode === "export" && (
          <label className="field">
            <span>{tr("本次工作阶段")}</span>
            <select aria-label={tr("工作包阶段")} value={taskStage}
              onChange={event => setTaskStage(event.target.value as 'translation' | 'proofreading')}>
              <option value="translation">{tr("初翻：填写目标文字的译文")}</option>
              <option value="proofreading">{tr("校对：审阅已有译文")}</option>
            </select>
            <small>{tr("仅导出材料，不启动模型；无需在软件中配置 API。校对包只选择已有译文。")}</small>
          </label>
        )}
        {mode === "export" && (
          <label className="field">
            <span>{tr("文字编辑格式")}</span>
            <select
              value={profile}
              onChange={(event) =>
                setProfile(event.target.value as "json" | "text")
              }
            >
              <option value="json">{tr("JSON（按字段填写译文和备注）")}</option>
              <option value="text">{tr("纯文字（在文本文件中填写译文）")}</option>
            </select>
          </label>
        )}
        {result && (
          <div className="import-result">
            <p>
              {tr("已导入")} <strong>{result.accepted}</strong> {tr("条，沿用当前内容")}{" "}
              <strong>{result.unchanged}</strong> {tr("条，需核对冲突")}{" "}
              <strong>{result.conflicts.length}</strong> {tr("条。")}{result.conflicts.length > 0 && tr("本次整包暂不导入，当前项目保持原样。展开下方条目查看译文差异，并核对双方备注；统一修改后重新导入。可在文字工作台搜索条目编号，查看和修改项目当前内容。")}
            </p>
            {result.conflicts.map((conflict) => (
              <details key={conflict.id}>
                <summary>{conflict.id}</summary>
                <p>
                  <b>{tr("导出时的译文：")}</b>
                  {conflict.baseline}
                </p>
                <p>
                  <b>{tr("项目当前译文：")}</b>
                  {conflict.current}
                </p>
                <p>
                  <b>{tr("工作包内的新译文：")}</b>
                  {conflict.returned}
                </p>
              </details>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            {result ? tr("完成") : tr("取消")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!path.trim()}
          >
            {mode === "export" ? tr("导出工作包") : tr("校验并导入")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
