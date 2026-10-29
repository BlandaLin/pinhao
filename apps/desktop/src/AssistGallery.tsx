import { tr, uiMessage, uiLocale } from "../shared/ui-language.js";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  FileSearch,
  History,
  Image,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import type {
  AssistState,
  RecollectionBackup,
  RecollectionEvidence,
  RecollectionRecipe,
  RecollectionScan,
} from "../../../packages/contracts/index";
import { api, errorMessage } from "./api";
import {
  canRestoreRecollection,
  recollectionScope,
  selectedRecollectionRecipes,
} from "./assist-view";
import { Button, Modal } from "./components";

type Confirmation =
  | { kind: "analyze" }
  | { kind: "apply"; recipes: RecollectionRecipe[]; gameSessionId?: string }
  | { kind: "restore"; backup: RecollectionBackup };
const backupLabels = {
  captured: tr("已备份原值"),
  applied: tr("已应用解锁方案"),
  restored: tr("已恢复原值"),
  failed: tr("操作失败"),
};

export default function AssistGallery({
  projectId,
  state,
  onState,
}: {
  projectId: string;
  state: AssistState;
  onState: (state: AssistState) => void;
}) {
  const [scan, setScan] = useState<RecollectionScan | null>(null);
  const [backups, setBackups] = useState<RecollectionBackup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const currentProject = useRef(projectId);
  const mounted = useRef(true);
  currentProject.current = projectId;
  const scanCurrent = Boolean(scan?.analysisRulesVersion);
  const chosen = selectedRecollectionRecipes(scanCurrent ? scan?.recipes ?? [] : [], selected);
  const confirmed = (scan?.recipes ?? []).filter(
    (recipe) => scanCurrent && recipe.confidence === "confirmed",
  );
  const query = search.trim().toLocaleLowerCase();
  const visibleRecipes = (scan?.recipes ?? []).filter((recipe) =>
    `${recipe.label} ${recollectionScope(recipe)}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const unassignedCandidates = (scan?.candidates ?? []).filter(
    (candidate) =>
      !(scan?.recipes ?? []).some((recipe) =>
        recipe.candidateIds.includes(candidate.id),
      ),
  );
  const connected = state.connected && state.ready !== false;
  const pendingAnalysis = scanCurrent && (scan?.candidates ?? []).some(candidate => candidate.selectable !== false && candidate.confidence !== "confirmed");

  useEffect(() => {
    let active = true;
    setBusy("load");
    setError("");
    setNotice("");
    setSelected([]);
    setScan(null);
    setBackups([]);
    setConfirming(null);
    void api
      .getRecollection({ projectId })
      .then((result) => {
        if (active) {
          setScan(result.scan);
          setBackups(result.backups);
        }
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      })
      .finally(() => {
        if (active) setBusy("");
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function inspect(analyze = false) {
    const activeProject = projectId;
    setBusy(analyze ? "analyze" : "scan");
    setError("");
    setNotice("");
    try {
      const result = await api.scanRecollection({ projectId, analyze });
      if (!mounted.current || currentProject.current !== activeProject) return;
      setScan(result);
      setSelected([]);
      setConfirming(null);
      setNotice(
        uiMessage(result.analysisNotice) || tr`扫描完成，找到 ${result.recipes.filter((recipe) => recipe.confidence === "confirmed").length} 项可用方案。`,
      );
    } catch (failure) {
      if (!mounted.current || currentProject.current !== activeProject) return;
      setError(errorMessage(failure));
      try {
        const result = await api.getRecollection({ projectId });
        if (mounted.current && currentProject.current === activeProject) {
          setScan(result.scan);
          setBackups(result.backups);
          setSelected([]);
        }
      } catch {
        /* Keep the analysis error visible alongside the last loaded scan. */
      }
    } finally {
      if (mounted.current && currentProject.current === activeProject)
        setBusy("");
    }
  }

  async function execute() {
    if (!confirming || busy) return;
    if (confirming.kind === "analyze") {
      await inspect(true);
      return;
    }
    if (!connected) {
      setError(tr("先从工作台启动成品并进入游戏，再应用方案或恢复原值。"));
      return;
    }
    if (confirming.kind === "apply" && confirming.gameSessionId !== state.gameSessionId) {
      setConfirming(null);
      setError(tr("游戏进度已变化，请在当前进度重新选择方案。"));
      return;
    }
    if (
      confirming.kind === "restore" &&
      !canRestoreRecollection(confirming.backup, state)
    ) {
      setError(tr("这份备份只适用于创建它时的那次游玩。当前进度需使用本次游玩的备份。"));
      return;
    }
    const activeProject = projectId;
    setBusy(confirming.kind);
    setError("");
    setNotice("");
    try {
      const result =
        confirming.kind === "apply"
          ? await api.applyRecollection({
              projectId,
              gameSessionId: confirming.gameSessionId,
              recipeIds: confirming.recipes.map((recipe) => recipe.id),
            })
          : await api.restoreRecollection({
              projectId,
              backupId: confirming.backup.id,
            });
      if (!mounted.current || currentProject.current !== activeProject) return;
      onState(result.state);
      setBackups((current) => [
        result.backup,
        ...current.filter((backup) => backup.id !== result.backup.id),
      ]);
      setNotice(
        confirming.kind === "apply"
          ? tr`已应用 ${result.backup.labels.length} 项方案，原值已存入“备份与恢复”。剧情进度的改动请在游戏内存档。`
          : result.state.recollectionResult?.skipped
            ? tr`已恢复 ${result.state.recollectionResult.restored ?? 0} 项原值；另 ${result.state.recollectionResult.skipped} 项后来又被修改，保留当前值。`
            : tr("修改前的数据已恢复到当前游戏。"),
      );
      setConfirming(null);
      setSelected([]);
    } catch (failure) {
      if (!mounted.current || currentProject.current !== activeProject) return;
      setError(errorMessage(failure));
      try {
        const result = await api.getRecollection({ projectId });
        if (mounted.current && currentProject.current === activeProject)
          setBackups(result.backups);
      } catch {
        /* Keep the original operation error visible. */
      }
    } finally {
      if (mounted.current && currentProject.current === activeProject)
        setBusy("");
    }
  }

  return (
    <>
      <section className="panel assist-gallery">
        <div className="panel-heading">
          <h2>
            <Image size={18} />{tr("回想与图鉴")}</h2>
          <span className="tag">{tr("扫描并选择解锁方案")}</span>
        </div>
        <p className="assist-section-intro">{tr("扫描后选择要解锁的条目。应用前自动备份相关数据。")}</p>
        <div className="button-row assist-gallery-toolbar">
          <Button
            variant="primary"
            busy={busy === "scan"}
            disabled={Boolean(busy)}
            onClick={() => void inspect()}
          >
            <FileSearch size={16} />{tr("扫描解锁条件")}</Button>
          <Button
            busy={busy === "analyze"}
            disabled={Boolean(busy) || !pendingAnalysis}
            onClick={() => setConfirming({ kind: "analyze" })}
          >
            <Sparkles size={16} />{tr("AI 分析解锁条件")}</Button>
        </div>
        <p className="assist-hint muted">{tr("扫描在本机完成；AI 分析会把相关游戏内容发送给技术模型，并按服务商规则计费。")}{!pendingAnalysis && tr("当前没有可交给 AI 分析的条件。请先扫描，再查看下方扫描提示。")}
          {scan && !scanCurrent && tr("扫描记录需要更新，请重新扫描后再应用方案。")}
        </p>
        {busy === "load" && (
          <p className="assist-hint muted" role="status">{tr("正在读取本地扫描记录与备份…")}</p>
        )}
        {scan && (
          <div className="assist-gallery-summary">
            <div>
              <strong>{confirmed.length}</strong>
              <span>{tr("可应用的解锁方案")}</span>
            </div>
            <div>
              <strong>{scan.candidates.length}</strong>
              <span>{tr("发现的解锁条件")}</span>
            </div>
            <div>
              <strong>{scan.maps.length}</strong>
              <span>{tr("找到的地图")}</span>
            </div>
          </div>
        )}
        {scan?.analysis && (
          <div className="assist-analysis">
            <Sparkles size={16} />
            <p>{scan.analysis.summary}</p>
          </div>
        )}
      </section>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner success" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {scan && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{tr("解锁方案")}</h2>
            <span className="muted">{tr("已选 ")}{chosen.length}{tr(" 项")}</span>
          </div>
          <label className="search-field assist-search">
            <Search size={17} />
            <input
              aria-label={tr("搜索解锁方案")}
              placeholder={tr("搜索条目名称或适用范围")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="assist-recipe-tools">
            <label>
              <input
                type="checkbox"
                aria-label={tr("选择全部已确认的解锁方案")}
                checked={
                  confirmed.length > 0 && chosen.length === confirmed.length
                }
                disabled={Boolean(busy) || confirmed.length === 0}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? confirmed.map((recipe) => recipe.id)
                      : [],
                  )
                }
              />{tr`选择全部已确认方案（${confirmed.length}）`}
            </label>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !connected || chosen.length === 0}
              onClick={() => setConfirming({ kind: "apply", recipes: chosen, gameSessionId: state.gameSessionId })}
            >{tr("应用已选 ")}{chosen.length}{tr(" 项")}</Button>
          </div>
          {!connected && (
            <p className="assist-hint muted">{tr("从工作台启动成品并进入游戏后，再应用方案或恢复原值。")}</p>
          )}
          <div className="assist-recipes">
            {visibleRecipes.map((recipe) => (
              <article
                key={recipe.id}
                className={`assist-recipe ${recipe.confidence}`}
              >
                <label className="assist-recipe-choice">
                  <input
                    type="checkbox"
                    checked={chosen.some((item) => item.id === recipe.id)}
                    aria-label={tr`选择解锁方案 ${recipe.label}`}
                    disabled={
                      Boolean(busy) || !scanCurrent || recipe.confidence !== "confirmed"
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, recipe.id]
                          : current.filter((id) => id !== recipe.id),
                      )
                    }
                  />
                  <span>
                    <strong>{recipe.label}</strong>
                    <small>
                      {recollectionScope(recipe)} · {recipe.candidateIds.length}{" "}{tr("项条件")}</small>
                  </span>
                  <span
                    className={`tag ${recipe.confidence === "confirmed" ? "assist-confirmed" : ""}`}
                  >
                    {!scanCurrent ? tr("需重新扫描") : recipe.confidence === "confirmed" ? tr("可应用") : tr("需要确认条件")}
                  </span>
                </label>
                <Evidence evidence={recipe.evidence} />
              </article>
            ))}
          </div>
          {visibleRecipes.length === 0 && (
            <p className="assist-section-intro">
              {search
                ? tr("没有匹配的方案，请换个名称或适用范围。")
                : pendingAnalysis ? tr("尚无可应用方案，可用 AI 分析下方待确认的条件。") : tr("未找到可分析的解锁条件，请查看扫描提示。")}
            </p>
          )}
          {unassignedCandidates.length > 0 && (
            <details className="assist-review-candidates">
              <summary>
                {unassignedCandidates.length}{tr(" 项条件需要确认")}</summary>
              {unassignedCandidates.map((candidate) => (
                <article key={candidate.id}>
                  <strong>{candidate.label}</strong>
                  <Evidence evidence={candidate.evidence} />
                </article>
              ))}
            </details>
          )}
          {scan.issues.length > 0 && (
            <details className="assist-review-candidates">
              <summary>{scan.issues.length}{tr(" 项扫描提示")}</summary>
              {scan.issues.map((issue, index) => (
                <p key={index}>
                  {uiMessage(issue.message)}
                  {issue.file && <small>{issue.file}</small>}
                </p>
              ))}
            </details>
          )}
        </section>
      )}
      <section className="panel assist-backups">
        <div className="panel-heading">
          <h2>
            <History size={18} />{tr("备份与恢复")}</h2>
          <span className="tag">{backups.length}{tr(" 条记录")}</span>
        </div>
        {backups.length === 0 ? (
          <p className="assist-section-intro">{tr("应用方案后，原值和条目名称保存在这里。需要还原时，请在读档、新开游戏或关闭游戏前恢复。")}</p>
        ) : (
          <div>
            {backups.map((backup) => (
              <article key={backup.id} className="assist-backup">
                <div>
                  <strong>{backup.labels.join(uiLocale === "en-US" ? ", " : "、")}</strong>
                  <small>
                    {new Date(backup.createdAt).toLocaleString(uiLocale)} ·{" "}
                    {backupLabels[backup.status]}
                  </small>
                  {backup.error && <p>{uiMessage(backup.error)}</p>}
                  {backup.status !== "restored" &&
                    !canRestoreRecollection(backup, state) && (
                      <small>{tr("这份记录只适用于创建备份时的那次游玩，不能跨读档、新游戏或重启恢复。")}</small>
                    )}
                </div>
                <Button
                  disabled={
                    Boolean(busy) || !canRestoreRecollection(backup, state)
                  }
                  onClick={() => setConfirming({ kind: "restore", backup })}
                >
                  <RotateCcw size={15} />
                  {backup.status === "restored" ? tr("已恢复") : tr("恢复原值")}
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>
      {confirming && (
        <Modal
          title={
            confirming.kind === "analyze"
              ? tr("用 AI 分析解锁条件")
              : confirming.kind === "apply"
                ? tr`应用 ${confirming.recipes.length} 项解锁方案`
                : tr("恢复应用前的数据")
          }
          busy={Boolean(busy)}
          onClose={() => setConfirming(null)}
          error={error}
        >
          {confirming.kind === "analyze" ? (
            <p className="dialog-intro">{tr("将解锁条件和相关游戏内容发送给技术模型，按服务商规则计费。分析后由你选择是否应用。")}</p>
          ) : confirming.kind === "apply" ? (
            <>
              <p className="dialog-intro">{tr("确认后先备份原值，再立即应用所选方案。各项范围见下方；剧情进度的改动请在游戏内存档。")}</p>
              <ul className="assist-confirm-list">
                {confirming.recipes.map((recipe) => (
                  <li key={recipe.id}>
                    <strong>{recipe.label}</strong>
                    <small>{recollectionScope(recipe)}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="dialog-intro">{tr("还原下列条目应用前的值；后来又被修改的数据保持当前值。")}</p>
              <ul className="assist-confirm-list">
                {confirming.backup.labels.map((label, index) => (
                  <li key={index}>{label}</li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-actions">
            <Button
              disabled={Boolean(busy)}
              onClick={() => setConfirming(null)}
            >{tr("取消")}</Button>
            <Button
              variant="primary"
              busy={Boolean(busy)}
              disabled={
                confirming.kind === "apply"
                  ? !connected
                  : confirming.kind === "restore"
                    ? !canRestoreRecollection(confirming.backup, state)
                    : false
              }
              onClick={() => void execute()}
            >
              {confirming.kind === "analyze"
                ? tr("开始 AI 分析")
                : confirming.kind === "apply"
                  ? tr("备份并应用")
                  : tr("恢复原值")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Evidence({ evidence }: { evidence: RecollectionEvidence[] }) {
  return (
    <details className="assist-evidence">
      <summary>{tr`查看相关游戏内容（${evidence.length}）`}</summary>
      {evidence.map((item, index) => (
        <div key={index}>
          <small>
            {item.file} · {item.location}
          </small>
          <p>{item.detail}</p>
        </div>
      ))}
    </details>
  );
}
