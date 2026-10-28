import test from "node:test";
import assert from "node:assert/strict";
import {
  assistPage,
  assistDestination,
  assistMoveSpeeds,
  canRestoreRecollection,
  recollectionScope,
  selectedRecollectionRecipes,
  assistRows,
  parseAssistValue,
  supportedAssistActions,
} from "../../src/assist-view.ts";

test("assist lists paginate beyond the old first-100 limit and search the complete data set", () => {
  const rows = Array.from({ length: 225 }, (_, i) => ({
    id: i + 1,
    name: `数据 ${i + 1}`,
  }));
  assert.deepEqual(
    assistPage(rows, "", 4).rows.map((row) => row.id),
    Array.from({ length: 25 }, (_, i) => i + 201),
  );
  assert.equal(assistPage(rows, "", 4).pages, 5);
  assert.equal(assistPage(rows, "225", 0).rows[0].id, 225);
  assert.equal(assistPage(rows, "", 99).page, 4);
  assert.equal(assistPage(rows, "", -1).page, 0);
  assert.deepEqual(assistPage(rows, "找不到", 3), {
    rows: [],
    total: 0,
    pages: 1,
    page: 0,
    start: 0,
    end: 0,
  });
});

test("recollection selection includes only selected confirmed recipes and scopes stay explicit", () => {
  const recipes = [
    { id: "one", confidence: "confirmed", kind: "event-conditions" },
    { id: "review", confidence: "review", kind: "event-conditions" },
    { id: "display", confidence: "confirmed", kind: "plugin-display" },
  ];
  assert.deepEqual(
    selectedRecollectionRecipes(recipes, [
      "one",
      "review",
      "unknown",
      "one",
    ]).map((item) => item.id),
    ["one"],
  );
  assert.deepEqual(
    selectedRecollectionRecipes(recipes, ["display"]).map((item) => item.id),
    ["display"],
  );
  assert.match(recollectionScope(recipes[0]), /当前存档/);
  assert.match(recollectionScope(recipes[2]), /本次游玩/);
});

test("recollection restoration follows the captured game session and backup status", () => {
  const backup = { status: "applied", capture: { gameSessionId: "session-a" } };
  assert.equal(
    canRestoreRecollection(backup, {
      connected: true,
      gameSessionId: "session-a",
    }),
    true,
  );
  assert.equal(
    canRestoreRecollection(backup, {
      connected: true,
      ready: false,
      gameSessionId: "session-a",
    }),
    false,
  );
  assert.equal(
    canRestoreRecollection(backup, {
      connected: false,
      gameSessionId: "session-a",
    }),
    false,
  );
  assert.equal(
    canRestoreRecollection(backup, {
      connected: true,
      gameSessionId: "session-b",
    }),
    false,
  );
  assert.equal(canRestoreRecollection(backup, { connected: true }), false);
  assert.equal(
    canRestoreRecollection(
      { ...backup, status: "restored" },
      { connected: true, gameSessionId: "session-a" },
    ),
    false,
  );
  assert.equal(
    canRestoreRecollection(
      { ...backup, status: "failed" },
      { connected: true, gameSessionId: "session-a" },
    ),
    true,
  );
});

test("assist destination uses map dimensions and integer tile coordinates", () => {
  const map = { id: 7, width: 20, height: 15 };
  assert.deepEqual(assistDestination(map, "19", "14"), {
    mapId: 7,
    x: 19,
    y: 14,
  });
  assert.throws(() => assistDestination(map, "20", "0"), /最多/);
  assert.throws(() => assistDestination(map, "0", "15"), /最多/);
  assert.throws(() => assistDestination(map, "-1", "0"), /至少/);
  assert.throws(() => assistDestination(map, "1.5", "0"), /整数/);
  assert.throws(() => assistDestination(map, "", "0"), /有效数字/);
  assert.deepEqual(
    assistMoveSpeeds.map((speed) => speed.value),
    [1, 2, 3, 4, 5, 6],
  );
});

test("assist rows keep item type IDs distinct and preserve variable values", () => {
  const state = {
    connected: true,
    items: [
      { id: 1, type: "weapon", name: "木剑", count: 3 },
      { id: 1, type: "armor", name: "布甲", count: 4 },
    ],
    variables: [
      { id: 101, name: "目标名称", value: "城镇" },
      { id: 102, name: "是否前进", value: false },
    ],
  };
  assert.equal(
    assistPage(assistRows(state, "items"), "武器", 0).rows[0].type,
    "weapon",
  );
  assert.deepEqual(
    assistRows(state, "variables").map((row) => row.value),
    ["城镇", false],
  );
  assert.equal(assistRows(state, "variables")[0].action, "setVariable");
});

test("assist capability controls expose advertised actions and keep older bridges usable", () => {
  assert.deepEqual(
    [...supportedAssistActions({ connected: true, actions: ["setHp"] })],
    ["setHp"],
  );
  assert.equal(supportedAssistActions({ connected: true }).has("heal"), true);
  assert.equal(
    supportedAssistActions({ connected: true }).has("setLevel"),
    false,
  );
  assert.equal(
    supportedAssistActions({ connected: true, actions: [] }).size,
    0,
  );
});

test("named variables retain scope, store, session and original primitive values", () => {
  const state = {
    connected: true,
    gameSessionId: "renpy-session",
    actions: ["setNamedVariable"],
    namedVariables: [
      { scope: "store", name: "score", type: "number", value: 12.5 },
      {
        scope: "store",
        store: "chapter",
        name: "score",
        type: "number",
        value: 3,
      },
      { scope: "persistent", name: "gallery", type: "boolean", value: false },
      { scope: "store", name: "nickname", type: "string", value: "" },
    ],
  };
  const rows = assistRows(state, "variables");
  assert.deepEqual(
    rows.map(({ name, value }) => [name, value]),
    [
      ["store.score", 12.5],
      ["chapter.score", 3],
      ["persistent.gallery", false],
      ["store.nickname", ""],
    ],
  );
  assert.deepEqual(rows[1].params, {
    scope: "store",
    store: "chapter",
    name: "score",
    gameSessionId: "renpy-session",
  });
  assert.equal(rows[1].id, undefined);
  assert.equal(rows[2].action, "setNamedVariable");
  assert.equal(assistPage(rows, "全局", 0).rows[0].name, "persistent.gallery");
  assert.equal(assistPage(rows, "chapter", 0).rows[0].value, 3);
  assert.equal(assistRows(state, "items").length, 0);
  assert.equal(supportedAssistActions(state).has("setGold"), false);
});

test("assist edit validation covers actor limits, quantities and variable types", () => {
  assert.equal(
    parseAssistValue("99", "number", { integer: true, min: 1, max: 99 }),
    99,
  );
  assert.equal(
    parseAssistValue("0", "number", { integer: true, min: 0, max: 100 }),
    0,
  );
  assert.throws(() => parseAssistValue("100", "number", { max: 99 }), /最多/);
  assert.throws(() => parseAssistValue("-1", "number", { min: 0 }), /至少/);
  assert.throws(
    () => parseAssistValue("1.5", "number", { integer: true }),
    /整数/,
  );
  assert.throws(() => parseAssistValue("Infinity", "number"), /有效数字/);
  assert.throws(() => parseAssistValue("", "number"), /有效数字/);
  assert.equal(parseAssistValue("", "string"), "");
  assert.equal(parseAssistValue("false", "boolean"), false);
  assert.equal(parseAssistValue("true", "boolean"), true);
  assert.equal(parseAssistValue("1.5", "number"), 1.5);
});
