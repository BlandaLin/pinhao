import { build } from 'esbuild';
import { packager } from '@electron/packager';
import { access, cp, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectPublicSourceFiles } from './public-source.mjs';
import { godotResources } from './prepare-godot-tools.mjs';
import { includeUnityRuntimePath } from './prepare-unity-tools.mjs';
import { validateManagedTools } from './prepare-managed-tools.mjs';
import { builtinFonts } from '../apps/desktop/electron/fonts.mjs';
import { pruneDesktopLocales, quickJsRuntimePackages } from './desktop-runtime.mjs';
import { readFormatKernelIdentity } from '../packages/technical/adaptation/format-capabilities.mjs';
import { copyDshRuntimeForRelease } from './dsh-release-policy.mjs';
import { desktopBundleBuilds } from './desktop-bundle-policy.mjs';
import { cleanupDesktopStage } from './desktop-stage-lifecycle.mjs';
import { uiLanguage } from '../apps/desktop/shared/ui-language.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const directoryOnly = process.argv.includes('--directory-only');
// --acceptance-bundle adds isolated business exports; --keep-stage preserves this run's staging directory.
const dshRuntimeDirectory = process.argv.find(value => value.startsWith('--dsh-runtime='))?.slice('--dsh-runtime='.length);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const stage = path.join(root, 'local', 'desktop-stage', stamp);
const output = path.join(root, 'local', 'releases', `${version}-${stamp}`);
const run = promisify(execFile);
const sourceFiles = await collectPublicSourceFiles(root);
const builtLanguage = JSON.parse(await readFile(path.join(root, 'apps/desktop/dist/ui-language.json'), 'utf8')).language;
if (builtLanguage !== uiLanguage) throw new Error('UI language mismatch. Set PINHAO_UI_LANGUAGE and rebuild the desktop before packaging.');
await validateManagedTools(root);
await import('./prepare-icon.mjs');
await access(path.join(root, 'local', 'runtime', 'python', 'python.exe'));
await mkdir(path.dirname(stage), { recursive: true });
await mkdir(stage);
const define = { __PINHAO_FORMAT_KERNEL__: JSON.stringify(await readFormatKernelIdentity()), __PINHAO_UI_LANGUAGE__: JSON.stringify(uiLanguage) };
const bundleReports = [];
await mkdir(path.join(output, 'build-metadata'), { recursive: true });
for (const entry of desktopBundleBuilds({ root, stage, define, args: process.argv.slice(2) })) {
  const result = await build(entry.options);
  const metadata = path.join(output, 'build-metadata', `${entry.name}.json`);
  await writeFile(metadata, JSON.stringify(result.metafile, null, 2));
  bundleReports.push({ name: entry.name, metadata,
    bytes: Object.values(result.metafile.outputs).reduce((sum, file) => sum + file.bytes, 0) });
}
{
  const { inspectDshRuntime } = await import('../packages/technical/dsh-runner.mjs');
  const runtime = dshRuntimeDirectory ? path.resolve(dshRuntimeDirectory) : path.join(root, 'local/dsh-runtime');
  await inspectDshRuntime({ sourceRoot: runtime });
  await copyDshRuntimeForRelease({ sourceRoot: runtime, outputDirectory: path.join(stage, 'resources/dsh') });
  for (const relative of ['dsh-profile.patch.yml', 'dsh-runtime-entry.mjs', 'dsh-tools-plugin/index.mjs']) {
    await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
    await cp(path.join(root, 'packages/technical', relative), path.join(stage, relative));
  }
}
await cp(path.join(root, 'apps/desktop/dist'), path.join(stage, 'ui'), { recursive: true });
await cp(path.join(root, 'apps/desktop/dist-host/preload.cjs'), path.join(stage, 'preload.cjs'));
await cp(path.join(root, 'adapters/python'), path.join(stage, 'resources/adapters'), { recursive: true, filter: source => !/[\\/](tests|__pycache__)([\\/]|$)|[\\/](test_[^\\/]+|verify_local_sample\.py)$/.test(source) });
await cp(path.join(root, 'local/runtime/python'), path.join(stage, 'resources/python'), { recursive: true });
await mkdir(path.join(stage, 'resources/fonts'), { recursive: true });
for (const font of builtinFonts) {
  for (const file of [font.file, font.licenseFile]) {
    await cp(path.join(root, 'local/runtime/fonts', file), path.join(stage, 'resources/fonts', file));
  }
}
await cp(path.join(root, 'local/runtime/tool-versions.json'), path.join(stage, 'resources/tool-versions.json'));
for (const resource of ['wolftl/WolfTL.exe', 'uberwolf/UberWolfCli.exe', 'lcf/lcf2xml.exe', 'easyrpg/Player.exe', 'easyrpg/COPYING', 'easyrpg/SOURCE.txt', 'easyrpg/easyrpg-player-0.8.1.1.tar.gz',
  ...[...godotResources, 'LICENSE', 'SOURCE.txt'].map(name => `gdre/${name}`),
  'kirikiri/addFont.dll', 'kirikiri/LICENSE.txt', 'kirikiri/provenance.json',
  'managed/Mono.Cecil.dll', 'managed/Mono.Cecil-LICENSE.txt', 'managed/Pinhao.ManagedPatch.exe', 'managed/Pinhao.UnityDisplay.exe',
  'managed/net20/Pinhao.ManagedAssist.dll', 'managed/net40/Pinhao.ManagedAssist.dll', 'managed/provenance.json',
  ...['Pinhao.UnitySchema.exe', 'AssetsTools.NET.dll', 'AssetsTools.NET.MonoCecil.dll', 'Mono.Cecil.dll', 'Mono.Cecil.Rocks.dll', 'AssetsTools.NET-LICENSE.txt', 'Mono.Cecil-LICENSE.txt', 'provenance.json'].map(name => `unity-schema/${name}`),
  'wolfsave/WolfSave.exe', 'wolfsave/LICENSE', 'wolfsave/README.md', 'wolfsave/provenance.json']) {
  await mkdir(path.dirname(path.join(stage, 'resources/dependencies', resource)), { recursive: true });
  await cp(path.join(root, 'local/dependencies', resource), path.join(stage, 'resources/dependencies', resource));
}
for (const directory of ['pgmdec', 'pgmdec-0.6.0.dist-info']) {
  await cp(path.join(root, 'local/dependencies/pgmm', directory), path.join(stage, 'resources/dependencies/pgmm', directory), { recursive: true, filter: source => !/[\\/]__pycache__([\\/]|$)/.test(source) });
}
await cp(path.join(root, 'local/dependencies/pgmm/provenance.json'), path.join(stage, 'resources/dependencies/pgmm/provenance.json'));
const unityRuntime = path.join(root, 'local/dependencies/unitypy');
await cp(unityRuntime, path.join(stage, 'resources/dependencies/unitypy'), {
  recursive: true,
  filter: source => includeUnityRuntimePath(path.relative(unityRuntime, source)),
});
const copied = new Set();
async function copyNativeDependency(name, parent = root) {
  let directory = path.join(parent, 'node_modules', name);
  try { await access(path.join(directory, 'package.json')); } catch { directory = path.join(root, 'node_modules', name); }
  try { await access(path.join(directory, 'package.json')); } catch { return; }
  if (copied.has(directory)) return;
  copied.add(directory);
  await cp(directory, path.join(stage, path.relative(root, directory)), { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) await copyNativeDependency(dependency, directory);
}
await copyNativeDependency('sharp');
for (const dependency of quickJsRuntimePackages) await copyNativeDependency(dependency);
await cp(path.join(root, 'adapters/vendor'), path.join(stage, 'THIRD_PARTY_LICENSES/adapters'), { recursive: true });
await mkdir(path.join(stage, 'resources/toolkit'), { recursive: true });
for (const file of await readdir(path.join(root, 'kits/workbench-tutorial/toolkit'))) {
  if ((file.endsWith('.py') && !file.startsWith('test_') && file !== 'demo.py') || file === 'LICENSE.txt') {
    await cp(path.join(root, 'kits/workbench-tutorial/toolkit', file), path.join(stage, 'resources/toolkit', file));
  }
}
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
await cp(path.join(root, 'COPYING'), path.join(stage, 'COPYING'));
await writeFile(path.join(stage, 'source-files.json'), JSON.stringify(sourceFiles.files));
await run(path.join(root, 'local/runtime/python/python.exe'), ['-B', '-c',
  'import json,sys,zipfile; from pathlib import Path; root=Path(sys.argv[1]); stage=Path(sys.argv[2]); files=json.loads((stage/"source-files.json").read_text(encoding="utf-8")); z=zipfile.ZipFile(stage/"SOURCE-CODE.zip","w",zipfile.ZIP_DEFLATED); [(z.write(root/f,f)) for f in files if (root/f).is_file()]; z.close()', root, stage], { windowsHide: true });
await unlink(path.join(stage, 'source-files.json'));
const licenses = path.join(stage, 'THIRD_PARTY_LICENSES');
await mkdir(licenses, { recursive: true });
const packages = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')).packages;
for (const location of Object.keys(packages)) {
  if (!location.startsWith('node_modules/')) continue;
  const directory = path.join(root, location);
  let entries;
  try { entries = await readdir(directory); } catch { continue; }
  for (const entry of entries.filter(name => /^(license|licence|copying|notice)([._-]|$)/i.test(name))) {
    const dest = location.replaceAll('/', '__') + '__' + entry;
    try { await cp(path.join(directory, entry), path.join(licenses, dest), { recursive: true }); } catch { /* Package metadata can contain non-file license links. */ }
  }
}
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'pinhao-workbench', productName: uiLanguage === 'en' ? 'Pinhao Workbench' : '拼好汉化工作台', version, uiLanguage, type: 'module', main: 'main.mjs', license: 'GPL-3.0-or-later', author: 'Pinhao' }, null, 2));
if (uiLanguage === 'en') {
  await writeFile(path.join(stage, 'README-English.txt'), [
    `Pinhao ${version} - English UI Public Beta`,
    "",
    "GETTING STARTED",
    "1. Extract the whole archive to a writable folder and run PinhaoWorkbench.exe.",
    "2. In Settings, enter your OpenAI-compatible API endpoint, model, and key. Technical and text tasks can use separate models; translation and proofreading share the text model.",
    "3. New settings default to translating into English (en). Change Target language in Advanced settings if needed; saved language choices are preserved.",
    "4. Import a game and choose Start translation & review. In Text Workbench, edit translations or exchange text packages with external AI tools and translators.",
    "5. Generate a copy in Builds & Export. Check dialogue, choices, fonts, and save/load before sharing it.",
    "",
    "DATA AND UPDATES",
    "Settings and the project index are in data beside the app. New projects and localized copies default to folders beside the game.",
    "Keep the original game, saves, data, and project folders. Close the app before updating. Keep project folders at their original paths; return moved projects before reopening them.",
    "Do not include your data folder, API settings, games, private projects, translations, or saves when sharing the application.",
    "",
    "PERMISSIONS AND COSTS",
    "Technical scripts require permission for each project. They run with your Windows user's file and network access. The host keeps API keys and does not pass them to scripts.",
    "Official downloads are free. Do not pay to buy the official package. API costs follow your model provider's pricing.",
    "",
    "BETA NOTES",
    "Custom plugins, encrypted resources, dynamic text, and font layout can need further adaptation. Try a small project first and keep its original files.",
    "Play-assistance entries explain how changes are saved. Disabling assistance does not undo earlier game-state or save edits.",
    "",
    "Source: SOURCE-CODE.zip. Application license: LICENSE.txt. Dependency notices: resources/app/THIRD_PARTY_LICENSES. Electron notices remain in the release folder.",
    "Documentation and downloads: https://github.com/BlandaLin/pinhao",
    "Report issues: https://github.com/BlandaLin/pinhao/issues",
    "",
  ].join('\r\n'));
}
await writeFile(path.join(stage, '使用说明.txt'), [
  `拼好汉化 ${version} · Windows x64 公测版`,
  "",
  "开始使用",
  "1. 完整解压到可写文件夹，运行 PinhaoWorkbench.exe，保留其他随包文件。",
  "2. 在设置中填写 OpenAI 兼容服务的 API 地址、模型和密钥，保存后测试连接。技术任务与文字任务可用不同模型，翻译和校对共用文字模型。",
  `3. 新配置默认翻译目标为${uiLanguage === 'en' ? '英语（en）' : '简体中文（zh-Hans）'}；可在设置中更改，已有语言选择会保留。`,
  "4. 导入游戏，点击“开始翻译与校对”。文字工作台可修改译文，也可导出文字工作包交给外部 AI 或译者，再将结果导回。",
  "5. 在“成品与导出”生成独立游戏。检查对白、选项、字体、分支和存读档后，再导出分享包。",
  "",
  "文件与更新",
  "程序旁的 data 保存配置与项目索引；新工程和独立成品默认放在原游戏旁边。",
  "保留原游戏、存档、data 和工程。更新前关闭程序；工程目录暂不支持搬家，移动后请放回原位置再打开。",
  "分享软件时不要附带自己的 data、API 配置、工程、游戏、译文或存档。",
  "",
  "权限与费用",
  "技术脚本需要按项目授权，以当前 Windows 用户权限访问文件和网络。API 密钥由主程序保管，不传给脚本。",
  "官方软件免费，请勿付费购买官方包。模型 API 费用按服务商定价计算。",
  "",
  "使用范围",
  "自定义插件、加密资源、动态文字和字体布局仍可能需要适配。先用小项目确认效果，保留原文件。",
  "图片文字回写用于平整背景 PNG 区域；复杂背景和其他格式需另行处理。",
  "游玩辅助的保存方式见各项说明。关闭辅助不撤销已改的剧情或存档；修改存档和应用回想方案时会备份相关原值。",
  "遇到错误先暂停并保留工程与报错信息，再提交反馈。",
  "",
  "源码见 SOURCE-CODE.zip，主程序许可证见 拼好汉化-LICENSE.txt。第三方声明见 resources/app/THIRD_PARTY_LICENSES，Electron 许可保留在发行目录。",
  "文档与下载：https://github.com/BlandaLin/pinhao",
  "问题反馈：https://github.com/BlandaLin/pinhao/issues",
  "",
].join('\r\n'));
await writeFile(path.join(stage, '测试说明.txt'), [
  `拼好汉化 ${version} · 反馈与问题排查`,
  "",
  "反馈请附：",
  "- 软件版本及中英文版、Windows 版本。",
  "- 游戏名称、版本和引擎；引擎不确定时可以留空。",
  "- 出错前的操作、预期结果、实际结果和相关截图。漏字请指出对白或菜单位置。",
  "",
  "遇到错误请先暂停，保留工程和报错信息。请勿公开上传 API 配置、完整游戏、私人译文或存档；截图和日志先遮盖密钥、账号与个人路径。",
  "反馈入口：https://github.com/BlandaLin/pinhao/issues",
  "",
  "For feedback, include your app edition and Windows version, game and engine, steps, expected and actual results, and screenshots of the affected screen.",
  "Pause and keep the project and error details. Redact keys, accounts, and personal paths; keep API settings, full games, private translations, and saves out of public reports.",
  "Report issues: https://github.com/BlandaLin/pinhao/issues",
  "",
  "官方软件免费；模型 API 费用按服务商定价计算。 / Official downloads are free; API costs follow your provider's pricing.",
  "",
].join('\r\n'));
const productName = uiLanguage === 'en' ? 'Pinhao' : '拼好汉化';
const paths = await packager({ dir: stage, out: output, tmpdir: path.join(root, 'local/packager-temp'), name: 'PinhaoWorkbench', platform: 'win32', arch: 'x64', electronVersion: '44.8.0', electronZipDir: path.join(root, 'local/runtime'), appVersion: version, appCopyright: 'Pinhao', icon: path.join(root, 'apps/desktop/public/pinhao-app-icon.ico'), asar: false, overwrite: false, prune: false, executableName: 'PinhaoWorkbench', win32metadata: { ProductName: productName, FileDescription: productName } });
if (paths.length !== 1) throw new Error('请将上一轮发行目录移到备份位置，再执行打包');
const archives = [];
const sizeReports = [];
const localePruning = [];
for (const directory of paths) {
  let archive;
  localePruning.push(await pruneDesktopLocales(directory));
  await cp(path.join(stage, '使用说明.txt'), path.join(directory, '使用说明.txt'));
  await cp(path.join(stage, '测试说明.txt'), path.join(directory, '测试说明.txt'));
  await cp(path.join(stage, 'LICENSE'), path.join(directory, '拼好汉化-LICENSE.txt'));
  if (uiLanguage === 'en') {
    await cp(path.join(stage, 'README-English.txt'), path.join(directory, 'README-English.txt'));
    await cp(path.join(stage, 'LICENSE'), path.join(directory, 'LICENSE.txt'));
  }
  await rename(path.join(directory, 'resources/app/SOURCE-CODE.zip'), path.join(directory, 'SOURCE-CODE.zip'));
  if (!directoryOnly) {
    archive = path.join(output, uiLanguage === 'en' ? `pinhao-${version}-en-Windows-x64.zip` : `拼好汉化-${version}-Windows-x64.zip`);
    const zipped = await run(path.join(root, 'local/runtime/python/python.exe'), ['-B', path.join(root, 'scripts/portable-release.py'), directory, archive], { windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    archives.push(JSON.parse(zipped.stdout));
  }
  const sizeReport = path.join(output, `release-size-${path.basename(directory)}.json`);
  const measured = await run(path.join(root, 'local/runtime/python/python.exe'), ['-B', path.join(root, 'scripts/release-size.py'),
    '--directory', directory, '--output', sizeReport, ...(archive ? ['--archive', archive] : []),
    ...(process.argv.includes('--acceptance-bundle') ? ['--acceptance-bundle'] : [])], { windowsHide: true, encoding: 'utf8' });
  sizeReports.push({ path: sizeReport, ...JSON.parse(measured.stdout) });
}
const stageRetained = directoryOnly || process.argv.includes('--keep-stage');
if (!stageRetained) await cleanupDesktopStage({ stageRoot: path.dirname(stage), stage, createdByThisRun: true });
console.log(JSON.stringify({ version, uiLanguage, packaged: paths, archives, sizeReports, directoryOnly, acceptanceBundle: process.argv.includes('--acceptance-bundle'), stage, stageRetained, localePruning, bundleReports }));
