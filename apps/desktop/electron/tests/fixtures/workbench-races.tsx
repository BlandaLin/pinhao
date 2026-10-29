import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  DesktopApi,
  ProjectDetail,
  TextUnit,
} from "../../../../../packages/contracts/index";

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait();
  }
  throw new Error("Editor fixture timed out");
}
const rows = ["A", "D"].map((translation, i) => ({
  id: `neutral-${i}`,
  source: `Source ${i}`,
  translation,
  notes: "",
  revision: 0,
  tokens: [],
  kind: "message",
  status: "translated",
  context: {},
})) as TextUnit[];
let pending: (() => void) | undefined;
let pendingRead: (() => void) | undefined;
let pendingPage: (() => void) | undefined;
let delayPage = false;
let listCalls = 0;
let listInputs: Parameters<DesktopApi["listText"]>[0][] = [];
let currentRows = rows;
let reviewedRows: TextUnit[] = [];
let reviewRoundId = "review-round";
let onRefresh = async () => {};
let notice = "";
let saveInputs: Parameters<DesktopApi["saveText"]>[0][] = [];
let exportInputs: Parameters<DesktopApi["exportPackage"]>[0][] = [];
window.pinhao = {
  listText: (input) => {
    listCalls++;
    listInputs.push(input);
    if (input.filter === "reviewed") {
      const changed = Boolean(input.reviewRoundId && input.reviewRoundId !== reviewRoundId);
      const search = input.search?.toLowerCase() || "";
      const matching = changed ? [] : reviewedRows.filter((row) =>
        !search || `${row.id} ${row.source} ${row.translation} ${row.notes}`.toLowerCase().includes(search));
      const start = input.offset || 0;
      const page = { units: matching.slice(start, start + (input.limit || 40)), total: matching.length,
        sceneReview: { roundId: reviewRoundId, state: changed ? "changed" as const : "saved" as const, committed: false } };
      return delayPage ? new Promise((resolve) => { pendingPage = () => resolve(page); }) : Promise.resolve(page);
    }
    if (input.search?.startsWith("neutral-"))
      return new Promise((resolve) => {
        pendingRead = () =>
          resolve({
            units: [{ ...rows[0], translation: "Latest", revision: 1 }],
            total: 1,
          });
      });
    const search = input.search?.toLowerCase() || "";
    const matching = currentRows.filter((row) =>
      (input.filter === "all" || !input.filter
        || input.filter === 'needs_evidence' && row.review?.status === 'needs_evidence'
        || (row.status === 'proofread' && row.review?.status === 'needs_evidence' ? 'translated' : row.status) === input.filter) &&
      (!search || `${row.source} ${row.translation}`.toLowerCase().includes(search)),
    );
    const start = input.offset || 0;
    const page = { units: matching.slice(start, start + (input.limit || 40)), total: matching.length };
    return delayPage
      ? new Promise((resolve) => { pendingPage = () => resolve(page); })
      : Promise.resolve(page);
  },
  saveText: (input) => {
    saveInputs.push(input);
    return new Promise((resolve) => {
      pending = () =>
        resolve({
          ...rows.find((row) => row.id === input.unitId)!,
          translation: input.translation,
          notes: input.notes,
          revision: input.expectedRevision + 1,
        });
    });
  },
  importPackage: async () => ({
    accepted: 0,
    unchanged: 1,
    conflicts: [{ id: "neutral-0", baseline: "A", current: "Local", returned: "Returned" }],
  }),
  exportPackage: async input => { exportInputs.push(input); return { path: input.filePath }; },
} as DesktopApi;
const { default: Workbench } = await import("../../../src/Workbench");
const project = {
  id: "neutral-project",
  total: 2,
  updatedAt: "neutral",
  textVersion: 1,
} as ProjectDetail;
const container = document.createElement("div");
document.body.append(container);
let root: Root | undefined;
function render(next: ProjectDetail) {
  flushSync(() =>
    root!.render(
      <Workbench
        project={next}
        onError={(error) => {
          throw error;
        }}
        onNotice={(value) => {
          notice = value;
        }}
        onRefresh={() => onRefresh()}
        onDirtyChange={() => {}}
      />,
    ),
  );
}
async function mount() {
  if (root) flushSync(() => root!.unmount());
  pending = undefined;
  pendingRead = undefined;
  pendingPage = undefined;
  delayPage = false;
  listCalls = 0;
  listInputs = [];
  currentRows = rows;
  reviewedRows = [];
  reviewRoundId = "review-round";
  onRefresh = async () => {};
  notice = "";
  saveInputs = [];
  exportInputs = [];
  root = createRoot(container);
  render(project);
  await until(
    () =>
      document.querySelector<HTMLTextAreaElement>('[aria-label="当前译文"]')
        ?.value === "A",
  );
}
function editor() {
  return document.querySelector<HTMLTextAreaElement>(
    '[aria-label="当前译文"]',
  )!;
}
async function type(value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(editor(), value);
  editor().dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
}
async function typeNotes(value: string) {
  const notes = document.querySelector<HTMLTextAreaElement>('[aria-label="译者备注"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(notes, value);
  notes.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
}
function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) throw new Error("Missing button: " + text);
  button.click();
}
async function savePending() {
  await type("B");
  click("保存译文");
  await until(() => pending);
}
async function finish() {
  pending!();
  await until(() => notice.includes("译文与备注已保存"));
  await wait();
}

async function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait();
}
function pageInput() {
  return document.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')!;
}
function arrow(label: string) {
  return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}
async function mountPages() {
  await mount();
  currentRows = Array.from({ length: 85 }, (_, index) => ({
    ...rows[index % 2], id: `page-${index}`, source: `Page source ${index}`,
    translation: `Page text ${index}`, status: index < 2 ? "proofread" : "translated",
  })) as TextUnit[];
  render({ ...project, total: 85, textVersion: 2 });
  await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 0");
}

function reviewProject(stage = "scene", reviewed = 2, id = reviewRoundId) {
  return { ...project, proofread: 0, reviewRound: { id, stage, total: 2, candidates: 1,
    progress: { total: 2, reviewed, skipped: 0 } },
    progress: { total: 2, counted: 2, done: 2, remaining: 0, percent: 100,
      phases: { pending: 0, translated: 2, proofread: 0, skipped: 0 } } } as ProjectDetail;
}
function filterText(value: string) {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="筛选文字状态"]')!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function sceneEditor() {
  return document.querySelector<HTMLTextAreaElement>('[aria-label="场景校对译文"]');
}
async function mountReview(open = true) {
  await mount();
  reviewedRows = rows.map((row, index) => index ? row : { ...row, translation: "Scene saved", notes: "Saved review note" });
  render(reviewProject());
  await wait();
  if (open) {
    click("查看场景审阅结果");
    await until(() => sceneEditor()?.value === "Scene saved");
  }
}

export async function runEditorChecks() {
  const cases = [
    [
      "notes saving and explicit human confirmation carry distinct actions",
      async () => {
        await mount();
        const notes = document.querySelector<HTMLTextAreaElement>('[aria-label="译者备注"]')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Neutral unresolved identity note');
        notes.dispatchEvent(new Event('input', { bubbles: true }));
        await wait();
        click('保存译文');
        await until(() => saveInputs.length === 1);
        if (saveInputs[0].action !== 'save' || saveInputs[0].translation !== 'A') throw new Error('Notes-only save must not imply confirmation');
        await finish();
        if (!notice.includes('译文与备注已保存') || notice.includes('已校对') || notice.includes('校对已完成')) throw new Error('Saving notice must not claim proofreading');
        click('确认此条已核对');
        await until(() => saveInputs.length === 2);
        if (saveInputs[1].action !== 'confirm') throw new Error('Human approval needs an explicit action');
        pending!();
        await until(() => notice.includes('此条已确认'));
      },
    ],
    [
      "saved scene reviews reuse read-only translation and notes without a second suggestions editor",
      async () => {
        await mountReview();
        if (document.querySelector('option[value="proofread"]')?.textContent !== "校对已完成")
          throw new Error("The final-review filter must name completion rather than saved scene work");
        const fields = document.querySelectorAll<HTMLTextAreaElement>(".unit-editor textarea");
        if (fields.length !== 2 || !fields[0].readOnly || !fields[1].readOnly || fields[1].value !== "Saved review note")
          throw new Error("The existing translation and notes must show saved reviews read-only");
        if (document.querySelector(".unit-editor")?.textContent?.includes("保存译文") ||
          document.querySelector(".unit-editor")?.textContent?.includes("校对修改建议"))
          throw new Error("Saved reviews must not create an editable suggestions workflow");
        if (document.querySelectorAll(".unit-item").length !== 2)
          throw new Error("Reviewed text with no modifications must remain visible");
        sceneEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
        await wait();
        if (pending) throw new Error("Viewing a saved review triggered a formal text save");
        filterText("all");
        await until(() => editor()?.value === "A");
        if (editor().readOnly) throw new Error("The normal editor must remain editable");
      },
    ],
    [
      "zero completed reviews explain saved scene work even while searching and provide the existing view entry",
      async () => {
        await mountReview(false);
        filterText("proofread");
        await until(() => document.querySelector(".list-empty")?.textContent?.includes("本轮校对尚未完成"));
        await fill(document.querySelector<HTMLInputElement>('[aria-label="搜索文字"]')!, "nothing matches");
        await until(() => listInputs.at(-1)?.search === "nothing matches" &&
          document.querySelector(".unit-list")?.getAttribute("aria-busy") === "false");
        if (!document.querySelector(".list-empty")?.textContent?.includes("本轮校对尚未完成"))
          throw new Error("Searching hid the incomplete-round explanation");
        const entry = [...document.querySelectorAll<HTMLButtonElement>(".list-empty button")]
          .find(button => button.textContent?.includes("场景审阅结果"));
        if (!entry) throw new Error("The empty state must lead to already saved scene results");
        entry.click();
        await until(() => sceneEditor()?.value === "Scene saved");
      },
    ],
    [
      "entering saved scene reviews cannot discard or relabel an unsaved formal draft",
      async () => {
        await mountReview(false);
        await type("Local draft");
        click("查看场景审阅结果");
        await wait(250);
        if (editor()?.value !== "Local draft" || sceneEditor() || !notice.includes("保存"))
          throw new Error("The view entry must retain the unsaved formal draft and explain the next action");
        filterText("reviewed");
        await wait(250);
        if (editor()?.value !== "Local draft" || sceneEditor())
          throw new Error("The filter bypassed unsaved draft protection");
      },
    ],
    [
      "saved scene browsing stays on its scene and round when processing enters consistency",
      async () => {
        await mountReview();
        const before = listCalls;
        render(reviewProject("consistency", 1));
        await until(() => listCalls > before && !pageInput().disabled);
        if (sceneEditor()?.value !== "Scene saved" || listInputs.at(-1)?.filter !== "reviewed" ||
          listInputs.at(-1)?.reviewRoundId !== "review-round")
          throw new Error("A backend stage change silently replaced the chosen scene view");
      },
    ],
    [
      "a new round never silently replaces the pinned saved results",
      async () => {
        await mountReview();
        reviewRoundId = "next-review-round";
        reviewedRows = [{ ...rows[0], translation: "Next round saved" }];
        render(reviewProject("scene", 1));
        await until(() => document.querySelectorAll(".unit-item").length === 0 && pageInput().disabled);
        if (sceneEditor() || !document.querySelector(".list-empty")?.textContent?.includes("轮"))
          throw new Error("A changed round must explain why the old saved view is unavailable");
        click("查看场景审阅结果");
        await until(() => sceneEditor()?.value === "Next round saved");
        if (listInputs.at(-1)?.reviewRoundId !== reviewRoundId)
          throw new Error("Explicitly reopening must select the current round");
      },
    ],
    [
      "saved scene reviews keep the existing pagination and search behavior",
      async () => {
        await mountReview(false);
        reviewedRows = Array.from({ length: 85 }, (_, index) => ({ ...rows[index % 2], id: `saved-${index}`,
          source: `Saved source ${index}`, translation: `Saved scene text ${index}` }));
        click("查看场景审阅结果");
        await until(() => sceneEditor()?.value === "Saved scene text 0");
        await fill(pageInput(), "2");
        click("跳转");
        await until(() => sceneEditor()?.value === "Saved scene text 40");
        await fill(document.querySelector<HTMLInputElement>('[aria-label="搜索文字"]')!, "Saved scene text 82");
        await until(() => sceneEditor()?.value === "Saved scene text 82" && !pageInput().disabled);
        if (document.querySelectorAll(".unit-item").length !== 1 || pageInput().value !== "1")
          throw new Error("Saved scene search must use its own matching page count");
      },
    ],
    [
      "a late saved-review page cannot overwrite the normal formal editor",
      async () => {
        await mountReview(false);
        delayPage = true;
        click("查看场景审阅结果");
        await until(() => pendingPage);
        const oldPage = pendingPage!;
        delayPage = false;
        filterText("all");
        await until(() => editor()?.value === "A" && !editor().readOnly);
        oldPage();
        await wait();
        if (editor()?.value !== "A" || sceneEditor())
          throw new Error("A stale saved-review response contaminated the formal editor");
      },
    ],
    [
      "a late formal reload cannot corrupt same-ID saved scene text or trap the user in read-only mode",
      async () => {
        await mountReview(false);
        click("读取已保存版本");
        await until(() => pendingRead);
        click("查看场景审阅结果");
        await until(() => sceneEditor()?.value === "Scene saved");
        pendingRead!();
        await wait();
        if (sceneEditor()?.value !== "Scene saved" || document.querySelector(".translation-field small"))
          throw new Error("A formal reload contaminated the scene baseline or marked its read-only value dirty");
        click("返回全部文字");
        await until(() => editor()?.value === "A" && !editor().readOnly);
      },
    ],
    [
      "page typing is local until Enter or the jump button submits",
      async () => {
        await mountPages();
        if (pageInput().value !== "1" || !document.querySelector(".pagination")?.textContent?.includes("/ 3 页"))
          throw new Error("Pagination must display the current page and count");
        const before = listCalls;
        await fill(pageInput(), "3");
        await wait(250);
        if (listCalls !== before) throw new Error("Typing a page number sent a text query");
        pageInput().form!.requestSubmit();
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 80");
        if (listInputs.at(-1)?.offset !== 80) throw new Error("Enter did not load the requested page");
        await fill(pageInput(), "2");
        click("跳转");
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 40");
        if (listInputs.at(-1)?.offset !== 40) throw new Error("The jump button did not load page two");
      },
    ],
    [
      "arrow navigation synchronizes the page input and rejects invalid pages",
      async () => {
        await mountPages();
        arrow("下一页").click();
        await until(() => pageInput().value === "2" && !arrow("下一页").disabled);
        arrow("上一页").click();
        await until(() => pageInput().value === "1" && !arrow("下一页").disabled);
        const before = listCalls;
        for (const value of ["", "0", "4", "1.5", "abc"]) {
          notice = "";
          await fill(pageInput(), value);
          click("跳转");
          await wait();
          if (!notice.includes("1 到 3") || listCalls !== before)
            throw new Error(`Invalid page ${value} must explain the range without querying`);
        }
      },
    ],
    [
      "filtering resets the page and zero results disable jumping",
      async () => {
        await mountPages();
        await fill(pageInput(), "3");
        click("跳转");
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 80");
        const filter = document.querySelector<HTMLSelectElement>('[aria-label="筛选文字状态"]')!;
        filter.value = "proofread";
        filter.dispatchEvent(new Event("change", { bubbles: true }));
        await until(() => document.querySelectorAll(".unit-item").length === 2 && !pageInput().disabled);
        if (pageInput().value !== "1" || !document.querySelector(".pagination")?.textContent?.includes("/ 1 页"))
          throw new Error("Filtering must use the new page count");
        await fill(document.querySelector<HTMLInputElement>('[aria-label="搜索文字"]')!, "no matching source");
        await until(() => document.querySelector(".list-empty")?.textContent?.includes("找到 0 条文字"));
        if (pageInput().value !== "0" || !pageInput().disabled || !arrow("上一页").disabled || !arrow("下一页").disabled)
          throw new Error("An empty result cannot expose a navigable page");
      },
    ],
    [
      "jumping keeps unsaved translation and notes until a unit switch is confirmed",
      async () => {
        await mountPages();
        await type("Pending translation");
        const notes = document.querySelectorAll<HTMLTextAreaElement>(".unit-editor textarea")[1];
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(notes, "Pending notes");
        notes.dispatchEvent(new Event("input", { bubbles: true }));
        await wait();
        await fill(pageInput(), "2");
        click("跳转");
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 40");
        if (editor().value !== "Pending translation" || notes.value !== "Pending notes")
          throw new Error("Jumping discarded the pending editor content");
        document.querySelector<HTMLButtonElement>(".unit-item")!.click();
        await until(() => document.querySelector("dialog"));
        click("继续编辑");
        await wait();
        if (editor().value !== "Pending translation" || notes.value !== "Pending notes")
          throw new Error("Canceling the unit switch discarded the pending editor content");
      },
    ],
    [
      "background refresh keeps the unsubmitted page and stale page replies cannot win",
      async () => {
        await mountPages();
        await fill(pageInput(), "3");
        const before = listCalls;
        render({ ...project, total: 85, textVersion: 3 });
        await until(() => listCalls === before + 1 && !pageInput().disabled);
        if (pageInput().value !== "3") throw new Error("A background refresh erased the unsubmitted page");
        delayPage = true;
        click("跳转");
        await until(() => pendingPage);
        if (!pageInput().disabled || !arrow("下一页").disabled)
          throw new Error("Navigation must be disabled while a page is loading");
        const oldPage = pendingPage!;
        delayPage = false;
        await fill(document.querySelector<HTMLInputElement>('[aria-label="搜索文字"]')!, "Page source 0");
        await until(() => document.querySelectorAll(".unit-item").length === 1 && !pageInput().disabled);
        oldPage();
        await wait();
        if (pageInput().value !== "1" || document.querySelector(".unit-item strong")?.textContent !== "Page text 0")
          throw new Error("An obsolete page reply replaced the current search result");
      },
    ],
    [
      "a shrinking result returns to its final valid page",
      async () => {
        await mountPages();
        await fill(pageInput(), "3");
        click("跳转");
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Page text 80");
        currentRows = currentRows.slice(0, 41);
        render({ ...project, total: 41, textVersion: 3 });
        await until(() => pageInput().value === "2" && document.querySelector(".unit-item strong")?.textContent === "Page text 40");
        if (!arrow("下一页").disabled || listInputs.at(-1)?.offset !== 40)
          throw new Error("The list stayed beyond its final valid page");
      },
    ],
    [
      "unresolved review explains the retained text and the next user action",
      async () => {
        await mount();
        currentRows = rows.map((row, index) => index ? row : { ...row, review: { reviewId: 'neutral-review', reviewedAt: 'neutral', status: 'needs_evidence', issues: [] } });
        render({ ...project, textVersion: 2 });
        await until(() => document.querySelector('.unit-item small')?.textContent === '已审阅 · 需再核对');
        const text = document.querySelector('.editor-topline')?.textContent || '';
        if (editor().value !== currentRows[0].translation || !text.includes('疑点') || !text.includes('修改后确认') || !text.includes('总览重审疑点'))
          throw new Error('An unresolved review must say what is retained and where to act next');
      },
    ],
    [
      "external pending questions have a dedicated filter and never claim completed review",
      async () => {
        await mount();
        currentRows = rows.map((row, index) => index ? row : { ...row, status: 'proofread', review: {
          reviewId: 'external-question-neutral', reviewedAt: 'neutral', status: 'needs_evidence', issues: [],
        } });
        render({ ...project, textVersion: 2 });
        await until(() => document.querySelector('.unit-item small')?.textContent === '待确认 · 需再核对');
        filterText('needs_evidence');
        await until(() => listInputs.at(-1)?.filter === 'needs_evidence' && document.querySelectorAll('.unit-item').length === 1);
      },
    ],
    [
      "progress updates leave the text query untouched",
      async () => {
        await mount();
        for (let index = 1; index <= 3; index++) {
          render({ ...project, updatedAt: `progress-${index}` });
          await wait(250);
        }
        if (listCalls !== 1)
          throw new Error(`Progress-only updates made ${listCalls - 1} extra queries`);
      },
    ],
    [
      "a text version change refreshes saved text without a timestamp change",
      async () => {
        await mount();
        currentRows = rows.map((row, index) => index ? row : { ...row, translation: "Accepted" });
        render({ ...project, textVersion: 2 });
        await until(() => editor().value === "Accepted");
        if (listCalls !== 2) throw new Error("The text version must trigger one fresh query");
      },
    ],
    [
      "older project summaries still refresh through their timestamp",
      async () => {
        await mount();
        render({ ...project, textVersion: undefined });
        await until(() => listCalls === 2);
        currentRows = rows.map((row, index) => index ? row : { ...row, translation: "Legacy refresh" });
        render({ ...project, textVersion: undefined, updatedAt: "legacy-next" });
        await until(() => editor().value === "Legacy refresh");
      },
    ],
    [
      "a manual save refreshes the list through the returned text version",
      async () => {
        await mount();
        onRefresh = async () => {
          currentRows = rows.map((row, index) => ({
            ...row,
            translation: index ? "Linked change" : "B",
            revision: 1,
          }));
          render({ ...project, textVersion: 2 });
        };
        await savePending();
        await finish();
        await until(() => document.querySelectorAll(".unit-item strong")[1]?.textContent === "Linked change");
        if (listCalls !== 2 || editor().value !== "B")
          throw new Error("Saving must refresh linked rows without losing the saved selection");
      },
    ],
    [
      "a text version refresh retains the pending draft",
      async () => {
        await mount();
        await type("Local draft");
        currentRows = rows.map((row, index) => index ? row : { ...row, translation: "Remote change" });
        render({ ...project, textVersion: 2 });
        await until(() => document.querySelector(".unit-item strong")?.textContent === "Remote change");
        if (editor().value !== "Local draft" || !document.querySelector(".translation-field small"))
          throw new Error("A background text refresh replaced the pending draft");
      },
    ],
    [
      "a late page cannot replace same-ID text after switching projects",
      async () => {
        await mount();
        delayPage = true;
        render({ ...project, textVersion: 2 });
        await until(() => pendingPage);
        const oldPage = pendingPage!;
        delayPage = false;
        currentRows = rows.map((row, index) => index ? row : { ...row, translation: "Project B" });
        render({ ...project, id: "other-project", textVersion: 2 });
        await until(() => editor()?.value === "Project B");
        oldPage();
        await wait();
        if (editor().value !== "Project B")
          throw new Error("A stale project response replaced the same-ID selection");
      },
    ],
    [
      "typing during a save retains the newer draft",
      async () => {
        await mount();
        await savePending();
        await type("C");
        await finish();
        if (editor().value !== "C")
          throw new Error("The save response replaced the newer draft");
        if (!document.querySelector(".translation-field small"))
          throw new Error("The newer draft must remain dirty");
      },
    ],
    [
      "a completed save keeps the newly selected unit",
      async () => {
        await mount();
        await savePending();
        document.querySelectorAll<HTMLButtonElement>(".unit-item")[1].click();
        await wait();
        click("放弃修改并切换");
        await wait();
        await finish();
        if (
          editor().value !== "D" ||
          document.querySelector(".unit-id")?.textContent !== "neutral-1"
        )
          throw new Error("The save response reopened the previous unit");
      },
    ],
    [
      "reading the saved version preserves subsequent typing",
      async () => {
        await mount();
        click("读取已保存版本");
        await until(() => pendingRead);
        await type("C");
        pendingRead!();
        await wait();
        if (editor().value !== "C")
          throw new Error("The reload response replaced the newer draft");
      },
    ],
    [
      "reading a saved version keeps the newly selected unit",
      async () => {
        await mount();
        click("读取已保存版本");
        await until(() => pendingRead);
        document.querySelectorAll<HTMLButtonElement>(".unit-item")[1].click();
        await wait();
        pendingRead!();
        await wait();
        if (editor().value !== "D")
          throw new Error("The reload response reopened the previous unit");
      },
    ],
    [
      "switch confirmation explains pending translation and notes",
      async () => {
        await mount();
        await type("B");
        await typeNotes("Unsaved note");
        document.querySelectorAll<HTMLButtonElement>(".unit-item")[1].click();
        await wait();
        const dialog = document.querySelector("dialog")?.textContent || "";
        if (!dialog.includes("修改未保存") || !dialog.includes("切换将丢弃修改"))
          throw new Error("The switch prompt must explain what will be discarded");
        click("继续编辑");
        await wait();
        if (editor().value !== "B" || document.querySelector<HTMLTextAreaElement>('[aria-label="译者备注"]')?.value !== "Unsaved note")
          throw new Error("Continuing must retain the pending draft");
      },
    ],
    [
      "reload confirmation explains replacement of translation and notes",
      async () => {
        await mount();
        await type("B");
        await typeNotes("Unsaved note");
        click("读取已保存版本");
        await wait();
        const dialog = document.querySelector("dialog")?.textContent || "";
        if (!dialog.includes("最新译文与备注") || !dialog.includes("丢弃当前未保存的修改"))
          throw new Error("The reload prompt must identify both replaced fields");
        click("继续编辑");
        await wait();
        if (editor().value !== "B" || document.querySelector<HTMLTextAreaElement>('[aria-label="译者备注"]')?.value !== "Unsaved note")
          throw new Error("Canceling a reload must retain the pending draft");
      },
    ],
    [
      "export explains the package and both edit formats",
      async () => {
        await mount();
        click("导出文字工作包");
        await wait();
        const dialog = document.querySelector("dialog")?.textContent || "";
        for (const text of ["ZIP", "原文、译文和上下文", "JSON（按字段填写译文和备注）", "纯文字（在文本文件中填写译文）"])
          if (!dialog.includes(text))
            throw new Error("Missing export instruction: " + text);
      },
    ],
    [
      "offline package stage is selectable independently of JSON or text format without starting a model",
      async () => {
        await mount();
        click('导出文字工作包');
        await until(() => document.querySelector('[aria-label="工作包阶段"]'));
        const stage = document.querySelector<HTMLSelectElement>('[aria-label="工作包阶段"]')!;
        stage.value = 'proofreading'; stage.dispatchEvent(new Event('change', { bubbles: true }));
        const profile = [...document.querySelectorAll<HTMLSelectElement>('dialog select')].find(select => [...select.options].some(option => option.value === 'text'))!;
        profile.value = 'text'; profile.dispatchEvent(new Event('change', { bubbles: true }));
        await wait();
        click('导出工作包');
        await until(() => exportInputs.length === 1);
        if (exportInputs[0].taskStage !== 'proofreading' || exportInputs[0].profile !== 'text') throw new Error('Stage and format must both reach the export contract');
        await until(() => !document.querySelector('dialog'));
      },
    ],
    [
      "import conflicts explain the whole-package pause and next action",
      async () => {
        await mount();
        click("导入文字工作包");
        await wait();
        const input = document.querySelector<HTMLInputElement>("dialog .path-input input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-returned.zip");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await wait();
        click("校验并导入");
        await until(() => document.querySelector(".import-result"));
        const result = document.querySelector(".import-result")?.textContent || "";
        for (const text of ["工作包未导入", "项目未改动", "统一修改后重新导入", "导出时的译文", "项目当前译文", "工作包内的新译文"])
          if (!result.includes(text))
            throw new Error("Missing conflict instruction: " + text);
        if (!notice.includes("整包暂不导入"))
          throw new Error("The notice must not imply partial import success");
      },
    ],
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
  return results;
}
Object.assign(window, { runEditorChecks });
