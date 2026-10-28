import electron from "electron";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const parent = path.join(root, "local/ui-regression");
async function main() {
  const { app, BrowserWindow } = electron;
  const directory = process.env.PINHAO_UI_TEST_DIR;
  if (!directory) throw new Error("Run this check through npm run test:ui");
  app.setPath("userData", path.join(directory, "profile"));
  let window;
  let code = 1;
  try {
    const availableSuites = [
      { fixture: "workbench-races", run: "runEditorChecks" },
      { fixture: "onboarding", run: "runOnboardingChecks" },
      { fixture: "theme", run: "runThemeChecks" },
      { fixture: "settings-feedback", run: "runSettingsFeedbackChecks" },
    ];
    const selectedSuite = process.env.PINHAO_UI_TEST_SUITE;
    const suites = selectedSuite ? availableSuites.filter(suite => suite.fixture === selectedSuite) : availableSuites;
    if (!suites.length) throw new Error(`Unknown UI test suite: ${selectedSuite}`);
    for (const { fixture } of suites) {
      await build({
        entryPoints: [
          path.join(root, `apps/desktop/electron/tests/fixtures/${fixture}.tsx`),
        ],
        outfile: path.join(directory, `${fixture}.js`),
        bundle: true,
        format: "esm",
        platform: "browser",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
      });
      await writeFile(
        path.join(directory, `${fixture}.html`),
        `<!doctype html><meta charset="utf-8">${fixture === "theme" ? '<link rel="stylesheet" href="./theme.css">' : ""}<script type="module" src="./${fixture}.js"></script>`,
      );
    }
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const results = [];
    for (const { fixture, run } of suites) {
      console.log(`UI suite: ${fixture}`);
      // Separate documents keep each fixture's captured API mock isolated.
      await window.loadFile(path.join(directory, `${fixture}.html`));
      results.push(...await window.webContents.executeJavaScript(`window.${run}()`));
    }
    code = results.every((result) => result.passed) ? 0 : 1;
    console.log(JSON.stringify({ uiRegression: results }));
  } catch (error) {
    console.error(error);
  } finally {
    window?.destroy();
    app.exit(code);
  }
}
if (process.versions.electron) {
  void main().catch((error) => {
    console.error(error);
    electron.app.exit(1);
  });
} else
  void run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

async function run() {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "editor-"));
  try {
    const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, PINHAO_UI_TEST_DIR: directory },
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const line = result.stdout
      ?.split(/\r?\n/)
      .find((value) => value.startsWith('{"uiRegression":'));
    const passed =
      line && JSON.parse(line).uiRegression.every((item) => item.passed);
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status === 0 && passed ? 0 : 1;
  } finally {
    // Profile handles are released only after the Electron child has exited.
    if (
      path.dirname(directory) !== parent ||
      !path.basename(directory).startsWith("editor-")
    )
      throw new Error("Unexpected test directory");
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
