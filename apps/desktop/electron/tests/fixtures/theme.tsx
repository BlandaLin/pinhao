import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { DesktopApi, ProjectDetail, Settings, Snapshot, TextUnit } from "../../../../../packages/contracts/index";
import { themeStorageKey } from "../../../src/theme";
import "../../../src/styles.css";

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait();
  }
  throw new Error("Theme fixture timed out");
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const nativeUpdates: string[] = [];
const media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-color-scheme: dark)" });
window.matchMedia = () => media as unknown as MediaQueryList;
function system(dark: boolean) {
  media.matches = dark;
  media.dispatchEvent(new Event("change"));
}
const connection = { baseUrl: "http://localhost:1/v1", model: "fixture" };
const settings: Settings = {
  connection,
  roles: {
    technical: { useShared: true, connection },
    translation: { useShared: true, connection },
    proofreading: { useShared: true, connection },
  },
  concurrency: 3, pauseOnLocalFailure: false, processImages: false,
  proofreading: true, targetLanguage: "简体中文", fontPath: "",
};
const detail: ProjectDetail = {
  id: "theme-neutral", name: "山间来信", gameDir: "fixture/game", workspaceDir: "fixture/workspace",
  engine: "mv", status: "completed", stage: "本轮制作完成", total: 3, done: 3,
  skipped: 0, translated: 3, proofread: 3, pending: 0,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  issues: [], tasks: [],
  builds: [{ id: "fixture-build", path: "fixture/output", launchPath: "fixture/output/Game.exe", createdAt: "2026-01-01T00:00:00.000Z", changed: 3, checks: [] }],
  assistance: { supported: true, modes: ["live"] },
};
const units: TextUnit[] = [
  ["Welcome to the mountain village.", "欢迎来到山间的小村。"],
  ["A letter is waiting by the old bridge.", "旧桥边有一封等着你的信。"],
  ["Let us set out together.", "一起出发吧。"],
].map(([source, translation], index) => ({
  id: `neutral-${index}`, legacyId: `neutral-${index}`, source, translation,
  kind: "dialogue", notes: "", tokens: [], revision: 1, sourceHash: `fixture-${index}`,
  status: "proofread", context: { file: "data/Map001.json", speaker: "向导", scene: "山间来信 · 初到村庄" },
}));
let includeProject = true;
let failSnapshot = false;
const snapshot = (): Snapshot => ({
  projects: includeProject ? [detail] : [], settings,
  engines: [{ id: "mv", name: "RPG Maker MV", extract: true, build: true, assist: true, detail: "原生文字与游玩辅助" }],
  fonts: [],
});
window.pinhao = {
  snapshot: async () => { if (failSnapshot) throw new Error("中性测试提示：工作空间正在重新连接。"); return snapshot(); },
  getProject: async () => detail,
  listText: async () => ({ units, total: units.length }),
  assistSnapshot: async () => ({
    connected: true, ready: true, engine: "mv", mode: "live", gold: 128,
    actions: ["setGold", "setItem", "setSwitch", "setVariable", "heal"],
    items: [{ id: 1, type: "item", name: "旅行药草", count: 3 }],
    switches: [{ id: 1, name: "旧桥来信", value: true }],
    variables: [{ id: 1, name: "旅途天数", value: 2 }],
    actors: [{ id: 1, name: "向导", hp: 120, mp: 40, level: 3 }],
  }),
  setAppearance: async ({ theme }) => { nativeUpdates.push(theme); },
  onChanged: () => () => {},
} as DesktopApi;
const { default: App } = await import("../../../src/App");
const container = document.createElement("div");
container.id = "root";
document.body.append(container);
let root: Root | undefined;
async function mount(project = true) {
  if (root) flushSync(() => root!.unmount());
  includeProject = project;
  failSnapshot = false;
  localStorage.setItem("pinhao.welcome.v1", "seen");
  root = createRoot(container);
  flushSync(() => root!.render(<App />));
  await until(() => !document.querySelector(".loading-state"));
  if (project) await until(() => document.querySelector(".overview-hero"));
}
function button(text: string) {
  const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === text);
  assert(result, `Missing button: ${text}`);
  return result;
}
function toggle() {
  const element = document.querySelector<HTMLButtonElement>(".theme-toggle");
  assert(element, "Sidebar theme toggle is missing");
  return element;
}
function dark() { return document.documentElement.dataset.theme === "dark"; }
function color(selector: string, property = "backgroundColor") {
  const element = document.querySelector(selector);
  assert(element, `Missing styled element: ${selector}`);
  return getComputedStyle(element)[property as keyof CSSStyleDeclaration];
}
function assertDarkSurface(selector: string) {
  const value = String(color(selector));
  const channels = value.match(/[\d.]+/g)?.map(Number);
  assert(channels && channels.length >= 3 && channels.slice(0, 3).every(channel => channel < 100), `${selector} has a light surface: ${value}`);
}

export async function runThemeChecks() {
  const cases = [
    ["first launch follows the system theme and synchronizes native appearance", async () => {
      localStorage.removeItem(themeStorageKey);
      system(true);
      await mount();
      assert(dark(), "Dark system preference was ignored");
      assert(toggle().type === "button" && !toggle().hasAttribute("aria-pressed"), "Theme action should use ordinary button semantics");
      assert(toggle().getAttribute("aria-label") === "当前深夜模式，切换到日间模式", "Theme action should announce its current and target modes");
      assert(toggle().textContent === "日间模式" && toggle().querySelector(".lucide-sun"), "Night mode should offer the Sun day-mode action");
      assert(localStorage.getItem(themeStorageKey) === null, "Automatic system preference became a user override");
      assert(nativeUpdates.at(-1) === "system", "Native window should follow the system before an explicit selection");
    }],
    ["system changes are followed until an explicit selection is made", async () => {
      system(false);
      await until(() => !dark());
      assert(toggle().textContent === "深夜模式" && toggle().querySelector(".lucide-moon"), "Day mode should offer the Moon night-mode action");
      toggle().click();
      await until(dark);
      assert(localStorage.getItem(themeStorageKey) === "dark", "Explicit night mode was not saved");
      assert(nativeUpdates.at(-1) === "dark", "Explicit night mode should reach the native window");
      system(true);
      system(false);
      await wait();
      assert(dark(), "System preference replaced an explicit selection");
    }],
    ["day and night selections survive application remounts", async () => {
      await mount();
      assert(dark(), "Saved night mode was lost on remount");
      toggle().click();
      await until(() => !dark());
      assert(toggle().getAttribute("aria-label") === "当前日间模式，切换到深夜模式", "Day-mode action should announce its current and target modes");
      await mount();
      assert(!dark() && localStorage.getItem(themeStorageKey) === "light", "Saved day mode was lost on remount");
      assert(nativeUpdates.at(-1) === "light", "Native window did not switch back to day mode");
    }],
    ["invalid saved values use the current system preference", async () => {
      localStorage.setItem(themeStorageKey, "invalid");
      system(true);
      await mount();
      assert(dark(), "Invalid preference should fall back to the system");
    }],
    ["night palette covers settings, inputs, buttons, error banners and tutorial dialogs", async () => {
      button("设置").click();
      await until(() => document.querySelector("#settings-form"));
      for (const selector of ["html", ".sidebar", ".topbar", ".panel", "input"]) assertDarkSurface(selector);
      assert(color("html", "color") === "rgb(240, 234, 228)", "Night foreground is not the soft-white token");
      assert(color("input", "color") === color("html", "color"), "Input foreground does not follow the theme");
      const primary = document.querySelector<HTMLButtonElement>(".button.primary");
      assert(primary?.disabled && color(".button.primary", "color") === "rgb(255, 244, 239)", "Disabled primary action should retain readable themed text");
      failSnapshot = true;
      document.querySelector<HTMLButtonElement>('[aria-label="刷新项目"]')!.click();
      await until(() => document.querySelector(".banner.error"));
      assertDarkSurface(".banner.error");
      assert(color(".banner.error", "color") === "rgb(255, 177, 167)", "Error text does not use the night error token");
      failSnapshot = false;
      button("使用教程").click();
      await until(() => document.querySelector("dialog[open]"));
      assertDarkSurface("dialog[open]");
      assertDarkSurface(".welcome-note");
      button("先看看界面").click();
    }],
    ["night palette covers workbench editor and connected assistance", async () => {
      button("文字工作台").click();
      await until(() => document.querySelector(".unit-editor textarea"));
      for (const selector of [".workbench-grid", ".unit-list", ".unit-item.selected", ".pagination", ".unit-editor textarea"]) assertDarkSurface(selector);
      button("游玩辅助").click();
      await until(() => document.querySelector(".assist-top"));
      assertDarkSurface(".assist-top .panel");
      assert(document.body.textContent?.includes("旅行药草"), "Connected neutral assistance data is missing");
    }],
    ["night palette also covers the project empty state", async () => {
      await mount(false);
      assertDarkSurface("html");
      assert(document.querySelector(".empty"), "Empty project view is missing");
      assertDarkSurface(".empty-emblem");
    }],
  ] as const;
  const results = [];
  for (const [name, run] of cases) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
  }
  root?.unmount();
  localStorage.removeItem(themeStorageKey);
  localStorage.removeItem("pinhao.welcome.v1");
  return results;
}
Object.assign(window, { runThemeChecks });
if (new URLSearchParams(location.search).has("preview")) {
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "dark" || theme === "light") localStorage.setItem(themeStorageKey, theme);
  await mount();
}
