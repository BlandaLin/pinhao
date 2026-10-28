import test from "node:test";
import assert from "node:assert/strict";
import {
  assistRows,
  parseAssistValue,
  recollectionScope,
} from "../../src/assist-view.ts";

test("variable copy explains save scope while preserving original names and command identity", () => {
  const state = {
    connected: true,
    engine: "RenPy",
    gameSessionId: "current-game",
    namedVariables: [
      { scope: "store", store: "chapter", name: "score", value: 2, persistence: "game-save" },
      { scope: "persistent", name: "gallery", value: false },
    ],
  };
  const [current, shared] = assistRows(state, "variables");
  assert.equal(current.name, "chapter.score");
  assert.equal(shared.name, "persistent.gallery");
  assert.equal(current.value, 2);
  assert.equal(shared.value, false);
  assert.match(current.category, /当前游戏/);
  assert.match(shared.category, /所有存档共用/);
  assert.match(current.hint, /立即生效.*游戏内存档后保留/);
  assert.match(shared.hint, /立即保存.*所有存档共用/);
  assert.deepEqual(shared.params, {
    scope: "persistent",
    store: undefined,
    name: "gallery",
    gameSessionId: "current-game",
  });
  for (const row of [current, shared]) {
    assert.doesNotMatch(`${row.category} ${row.hint}`, /persistent|store|作用域|持久化/);
  }
});

test("save-edit copy keeps the selected file, original backup and load-to-apply steps explicit", () => {
  const [row] = assistRows({
    connected: true,
    mode: "save",
    namedVariables: [{ scope: "store", name: "score", value: 3 }],
  }, "variables");
  assert.match(row.hint, /写入所选存档/);
  assert.match(row.hint, /备份修改前的文件/);
  assert.match(row.hint, /读取这份存档后生效/);
  assert.doesNotMatch(row.hint, /立即生效/);
});

test("recollection labels distinguish temporary display changes from current-save progress", () => {
  assert.equal(recollectionScope({ kind: "plugin-display" }), "本次游玩 · 回想显示状态");
  assert.equal(recollectionScope({ kind: "event-conditions" }), "当前存档 · 剧情开关与进度");
});

test("number-entry errors explain the required correction and retain actual limits", () => {
  assert.throws(() => parseAssistValue("", "number"), /请输入有效数字，例如/);
  assert.throws(() => parseAssistValue("1.5", "number", { integer: true }), /请输入整数/);
  assert.throws(() => parseAssistValue("-1", "number", { min: 0 }), /请输入至少为 0 的数值/);
  assert.throws(() => parseAssistValue("8", "number", { max: 7 }), /请输入最多为 7 的数值/);
});

test("generic runtime fields never promise save persistence without evidence", () => {
  const [unknown, saved, shared] = assistRows({ connected: true, engine: 'Unity', namedVariables: [
    { scope: 'store', name: 'cache', value: 1 },
    { scope: 'store', name: 'score', value: 2, persistence: 'game-save' },
    { scope: 'persistent', name: 'gallery', value: true, persistence: 'persistent' },
  ] }, 'variables');
  assert.match(unknown.hint, /由游戏决定/);
  assert.match(saved.hint, /游戏内存档后保留/);
  assert.match(shared.hint, /立即保存/);
});
