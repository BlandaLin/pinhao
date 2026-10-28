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
  captured: "已备份原值",
  applied: "已应用解锁方案",
  restored: "已恢复原值",
  failed: "操作失败",
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
        result.analysisNotice || `扫描完成，可应用的解锁方案共 ${result.recipes.filter((recipe) => recipe.confidence === "confirmed").length} 项。`,
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
      setError("请从工作台启动成品，开始新游戏或读档后，再应用方案或恢复原值。");
      return;
    }
    if (confirming.kind === "apply" && confirming.gameSessionId !== state.gameSessionId) {
      setConfirming(null);
      setError("游戏进度已变化，请在当前进度重新选择方案。");
      return;
    }
    if (
      confirming.kind === "restore" &&
      !canRestoreRecollection(confirming.backup, state)
    ) {
      setError("恢复需要保持创建备份时的这次游玩。当前进度请重新应用解锁方案，使用新的恢复记录。");
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
          ? `已应用 ${result.backup.labels.length} 项解锁方案。修改前的数据已保存在“备份与恢复”。当前存档的改动请在游戏内存档后保留。`
          : result.state.recollectionResult?.skipped
            ? `已恢复 ${result.state.recollectionResult.restored ?? 0} 项原值。另 ${result.state.recollectionResult.skipped} 项已被后续操作改动，继续保留当前值。`
            : "修改前的数据已恢复到当前游戏。",
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
            <Image size={18} />
            回想与图鉴
          </h2>
          <span className="tag">扫描并选择解锁方案</span>
        </div>
        <p className="assist-section-intro">
          先扫描回想入口与解锁条件，再选择要开放的条目。每次应用前都会备份相关数据的原值。
        </p>
        <div className="button-row assist-gallery-toolbar">
          <Button
            variant="primary"
            busy={busy === "scan"}
            disabled={Boolean(busy)}
            onClick={() => void inspect()}
          >
            <FileSearch size={16} />
            扫描解锁条件
          </Button>
          <Button
            busy={busy === "analyze"}
            disabled={Boolean(busy) || !pendingAnalysis}
            onClick={() => setConfirming({ kind: "analyze" })}
          >
            <Sparkles size={16} />
            AI 分析解锁条件
          </Button>
        </div>
        <p className="assist-hint muted">
          “扫描解锁条件”在本机读取游戏内容。“AI 分析解锁条件”会调用设置中的技术模型，进一步核对解锁条件。
          {!pendingAnalysis && "当前没有可供本轮 AI 审核的候选，不会调用模型。请先扫描并查看未提取或阻塞原因。"}
          {scan && !scanCurrent && "这份历史记录缺少分析规则身份，请重新扫描；旧确认不能继续应用。"}
        </p>
        {busy === "load" && (
          <p className="assist-hint muted" role="status">
            正在读取本地扫描记录与备份…
          </p>
        )}
        {scan && (
          <div className="assist-gallery-summary">
            <div>
              <strong>{confirmed.length}</strong>
              <span>可应用的解锁方案</span>
            </div>
            <div>
              <strong>{scan.candidates.length}</strong>
              <span>发现的解锁条件</span>
            </div>
            <div>
              <strong>{scan.maps.length}</strong>
              <span>找到的地图</span>
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
            <h2>解锁方案</h2>
            <span className="muted">已选 {chosen.length} 项</span>
          </div>
          <label className="search-field assist-search">
            <Search size={17} />
            <input
              aria-label="搜索解锁方案"
              placeholder="搜索条目名称或适用范围"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="assist-recipe-tools">
            <label>
              <input
                type="checkbox"
                aria-label="选择全部已确认的解锁方案"
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
              />
              选择全部已确认方案（{confirmed.length}）
            </label>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !connected || chosen.length === 0}
              onClick={() => setConfirming({ kind: "apply", recipes: chosen, gameSessionId: state.gameSessionId })}
            >
              应用已选 {chosen.length} 项
            </Button>
          </div>
          {!connected && (
            <p className="assist-hint muted">
              从工作台启动成品，开始新游戏或读档后，再应用方案或恢复原值。
            </p>
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
                    aria-label={`选择解锁方案 ${recipe.label}`}
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
                      {recollectionScope(recipe)} · {recipe.candidateIds.length}{" "}
                      项条件
                    </small>
                  </span>
                  <span
                    className={`tag ${recipe.confidence === "confirmed" ? "assist-confirmed" : ""}`}
                  >
                    {!scanCurrent ? "需重新扫描" : recipe.confidence === "confirmed" ? "可应用" : "需要确认条件"}
                  </span>
                </label>
                <Evidence evidence={recipe.evidence} />
              </article>
            ))}
          </div>
          {visibleRecipes.length === 0 && (
            <p className="assist-section-intro">
              {search
                ? "匹配 0 项。更换条目名称或适用范围后重新搜索。"
                : pendingAnalysis ? "本轮扫描没有可应用方案，可审核已有候选。" : "本轮没有可供审核的解锁候选，请查看扫描问题和能力范围。"}
            </p>
          )}
          {unassignedCandidates.length > 0 && (
            <details className="assist-review-candidates">
              <summary>
                {unassignedCandidates.length} 项条件需要确认
              </summary>
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
              <summary>{scan.issues.length} 项扫描提示</summary>
              {scan.issues.map((issue, index) => (
                <p key={index}>
                  {issue.message}
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
            <History size={18} />
            备份与恢复
          </h2>
          <span className="tag">{backups.length} 条记录</span>
        </div>
        {backups.length === 0 ? (
          <p className="assist-section-intro">
            应用解锁方案后，这里会保存修改前的数据和条目名称。请在读档、开始新游戏或关闭游戏前恢复原值。
          </p>
        ) : (
          <div>
            {backups.map((backup) => (
              <article key={backup.id} className="assist-backup">
                <div>
                  <strong>{backup.labels.join("、")}</strong>
                  <small>
                    {new Date(backup.createdAt).toLocaleString()} ·{" "}
                    {backupLabels[backup.status]}
                  </small>
                  {backup.error && <p>{backup.error}</p>}
                  {backup.status !== "restored" &&
                    !canRestoreRecollection(backup, state) && (
                      <small>恢复需要保持创建备份时的这次游玩。读档、开始新游戏或重启游戏后，请使用新创建的记录。</small>
                    )}
                </div>
                <Button
                  disabled={
                    Boolean(busy) || !canRestoreRecollection(backup, state)
                  }
                  onClick={() => setConfirming({ kind: "restore", backup })}
                >
                  <RotateCcw size={15} />
                  {backup.status === "restored" ? "已恢复" : "恢复原值"}
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
              ? "用 AI 分析解锁条件"
              : confirming.kind === "apply"
                ? `应用 ${confirming.recipes.length} 项解锁方案`
                : "恢复应用前的数据"
          }
          busy={Boolean(busy)}
          onClose={() => setConfirming(null)}
          error={error}
        >
          {confirming.kind === "analyze" ? (
            <p className="dialog-intro">
              将本项目的解锁条件及相关游戏内容交给设置中的技术模型分析。分析完成后，在下方选择要应用的解锁方案。
            </p>
          ) : confirming.kind === "apply" ? (
            <>
              <p className="dialog-intro">
                先备份相关数据的原值，再立即应用下列解锁方案。适用范围逐项列出；当前存档的改动需要在游戏内存档后保留。
              </p>
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
              <p className="dialog-intro">
                将下列条目涉及的数据恢复到应用前的值。应用后又被其他操作改动的数据，会继续保留当前值。
              </p>
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
            >
              取消
            </Button>
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
                ? "开始 AI 分析"
                : confirming.kind === "apply"
                  ? "备份并应用"
                  : "恢复原值"}
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
      <summary>查看对应的游戏内容（{evidence.length}）</summary>
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
