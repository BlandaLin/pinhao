import { tr } from "../shared/ui-language.js";
import type {
  AssistState,
  DesktopApi,
  RecollectionBackup,
  RecollectionRecipe,
} from "../../../packages/contracts/index";

type Action = Parameters<DesktopApi["assistCommand"]>[0]["action"];
export type AssistTab = "items" | "switches" | "variables";
export type AssistRow = {
  id?: number;
  name: string;
  value: string | number | boolean;
  action: Action;
  type?: string;
  category: string;
  params?: Parameters<DesktopApi["assistCommand"]>[0]["params"];
  hint?: string;
  min?: number;
  max?: number;
  integer?: boolean;
};
const legacyActions: Action[] = [
  "setGold",
  "setItem",
  "setSwitch",
  "setVariable",
  "heal",
];

export function supportedAssistActions(state: AssistState): Set<Action> {
  return new Set(state.actions ?? legacyActions);
}

export function assistRows(state: AssistState, tab: AssistTab): AssistRow[] {
  if (tab === "items")
    return (state.items ?? []).map((item) => ({
      ...item,
      value: item.count,
      action: "setItem",
      category:
        item.type === "weapon"
          ? tr("武器")
          : item.type === "armor"
            ? tr("防具")
            : tr("物品"),
    }));
  const rows: AssistRow[] = (state[tab] ?? []).map((item) => ({
    ...item,
    action: tab === "switches" ? "setSwitch" : "setVariable",
    category: tab === "switches" ? tr("开关") : tr("变量"),
  }));
  if (tab === "variables") {
    rows.push(
      ...(state.namedVariables ?? []).map((item): AssistRow => ({
        name: item.label || `${item.store || (item.scope === "persistent" ? "persistent" : "store")}.${item.name}`,
        value: item.value,
        action: "setNamedVariable",
        category:
          item.scope === "persistent"
            ? tr`所有存档共用（全局）${item.store ? ` · ${item.store}` : ""}`
            : tr`当前游戏${item.store ? ` · ${item.store}` : ""}`,
        min: item.min,
        max: item.max,
        integer: item.integer,
        params: {
          scope: item.scope,
          store: item.store,
          name: item.name,
          gameSessionId: state.gameSessionId,
        },
        hint:
          state.mode === "save"
            ? tr("写入所选存档前，会备份修改前的文件；在游戏中读取这份存档后生效。")
            : item.persistence === "persistent" || item.scope === "persistent"
            ? tr("确认修改后立即保存，所有存档共用这项数据。")
            : item.persistence === "game-save"
              ? tr("修改立即生效。在游戏内存档后保留，读取其他存档会切换为对应的数据。")
              : item.persistence === "volatile"
                ? tr("只修改当前游戏中的值，不会写入存档。")
                : tr("修改会更新当前值；是否写入存档由游戏决定，请存档后再读档核对。"),
      })),
    );
  }
  return rows;
}

export function assistPage<
  T extends { id?: number; name: string; category?: string },
>(rows: T[], search: string, requestedPage: number, size = 50) {
  const query = search.trim().toLocaleLowerCase();
  const matches = query
    ? rows.filter((row) =>
        `${row.id} ${row.name} ${row.category ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : rows;
  const total = matches.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pages - 1, Math.max(0, requestedPage));
  const offset = page * size;
  return {
    rows: matches.slice(offset, offset + size),
    total,
    pages,
    page,
    start: total ? offset + 1 : 0,
    end: Math.min(total, offset + size),
  };
}

export function parseAssistValue(
  value: string,
  type: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
): string | number | boolean {
  if (type === "boolean") return value === "true";
  if (type !== "number") return value;
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number))
    throw new Error(tr("请输入有效数字，例如 0 或 12.5。"));
  if (options.integer && !Number.isSafeInteger(number))
    throw new Error(tr("请输入整数，例如 0、1 或 2。"));
  if (options.min !== undefined && number < options.min)
    throw new Error(tr`请输入至少为 ${options.min} 的数值。`);
  if (options.max !== undefined && number > options.max)
    throw new Error(tr`请输入最多为 ${options.max} 的数值。`);
  return number;
}

export const assistMoveSpeeds = [
  { value: 1, label: tr("1 · 最慢") },
  { value: 2, label: tr("2 · 慢速") },
  { value: 3, label: tr("3 · 缓步") },
  { value: 4, label: tr("4 · 标准步行") },
  { value: 5, label: tr("5 · 快速") },
  { value: 6, label: tr("6 · 最快") },
];

export function assistDestination(
  map: { id: number; width: number; height: number },
  xText: string,
  yText: string,
) {
  const x = parseAssistValue(xText, "number", {
    integer: true,
    min: 0,
    max: map.width - 1,
  }) as number;
  const y = parseAssistValue(yText, "number", {
    integer: true,
    min: 0,
    max: map.height - 1,
  }) as number;
  return { mapId: map.id, x, y };
}

export function selectedRecollectionRecipes(
  recipes: RecollectionRecipe[],
  ids: string[],
) {
  const chosen = new Set(ids);
  return recipes.filter(
    (recipe) => recipe.confidence === "confirmed" && chosen.has(recipe.id),
  );
}

export function recollectionScope(recipe: Pick<RecollectionRecipe, "kind">) {
  return recipe.kind === "plugin-display"
    ? tr("本次游玩 · 回想显示状态")
    : tr("当前存档 · 剧情开关与进度");
}

export function canRestoreRecollection(
  backup: RecollectionBackup,
  state: AssistState,
) {
  return (
    state.connected &&
    state.ready !== false &&
    backup.status !== "restored" &&
    Boolean(state.gameSessionId) &&
    backup.capture.gameSessionId === state.gameSessionId
  );
}
