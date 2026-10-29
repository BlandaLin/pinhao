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
    `Pinhao ${version} - English UI Public Beta`, '',
    'Extract the entire archive to a writable folder, then launch PinhaoWorkbench.exe.',
    'In Settings, enter your own API endpoint, model and key. Technical and text connections can be separate; translation and proofreading share the text connection.',
    'New English-edition settings default to English (en) as the translation target. You can choose another language in Settings; existing saved choices are preserved.',
    'Import a game, try a short scene, then check the finished game before processing or sharing a full project.', '',
    'Settings and the project index live in data beside the portable application. Projects and localized builds default to folders beside the game.',
    'Keep your original game and saves. Preserve data and existing project folders when updating.',
    'Do not share your data directory, API settings, private projects, games, translations or saves with the application.', '',
    'The English UI covers application controls, status and common errors. Game text, user names, font glyph samples, model responses and raw technical evidence retain their original language.',
    'Technical scripts require project permission and run with your Windows user permissions, including file and network access. API keys remain with the host.',
    'This is a beta, not an all-engine compatibility or complete playtesting guarantee.',
    'The original 0.5.8 GitHub test run has four unresolved failures. See the release notes for the exact status; localization is not a claim that those test failures were fixed.', '',
    'Official downloads are free. Model providers may charge for requests. Do not pay to buy the official application package.',
    'Source code: SOURCE-CODE.zip. Application license: LICENSE.txt. Dependency notices: resources/app/THIRD_PARTY_LICENSES.',
    'Documentation and feedback: https://github.com/BlandaLin/pinhao', '',
  ].join('\r\n'));
}
await writeFile(path.join(stage, '使用说明.txt'), [
  `拼好汉化 ${version} · Windows x64 公测版`, '',
  '双击 PinhaoWorkbench.exe 启动。保留整个发行目录。',
  '先在设置中填写自己的 API 地址、模型和密钥，再添加游戏目录。',
  '可以导出文字工作包交由外部 AI 或人工处理，导入后生成独立游戏。',
  '引擎能力与实际检查记录可在软件中查看。', '',
  '当前公测版',
  '首次使用请完整解压。更新已有便携版前，请保留 data 文件夹和游戏旁的工程。分享软件时不要分享自己的 data。',
  '本包内置并默认使用新的技术 Agent 运行环境，无需另外安装 Harness 或设置环境变量。',
  '在设置中配置 API；新工程和汉化成品默认建立在游戏旁边，软件 data 目录保存配置与轻量项目索引。',
  '游戏项目页可打开原路径的新版已有工程；工程移动后请先放回原路径，本版不提供自动搬家迁移。',
  '初翻后进行场景校对；场景完成后由程序计票，仅对残留译名分歧和明确疑点复核，不再全量重校。',
  '进度与翻译覆盖只统计已提取文字，不等于整款游戏全部内容已汉化，也不代替实际游玩检查。',
  '游玩辅助可开启或关闭实时连接；支持的引擎可手动改已有开关和变量，存档写回前保留备份。', '',
  '已知待继续验证：复杂资源适配和持续补漏尚未完成全面验收；完整回归中有一项多项目并发完成等待超时，原因尚未定位。',
  '可先处理已验证的文字；暂停时保留成果。遇到异常请保留工程，勿反复从零导入或删除已付费结果。', '',
  '功能与改良',
  '翻译结果、异常恢复与继续操作共用成果校验，已通过条目持续保留。',
  '翻译与校对可按需查阅项目原文；语义决定绑定证据与版本，同一含义的复用保留明确范围。',
  '校对逐条审阅，仅提交实际修订；准确译文保持原样，需再核对的译文在文字工作台展示。',
  '技术工具保存完整输出，支持分页补读、归档成员适配、关联范围申请和验证后复用。',
  '构建失败保存实际工件供技术 Agent 返修，成品按内容摘要核验，人工修改的旧副本继续保留。',
  'Unity 托管发行资源接入剥离类型树恢复；字体字符覆盖与实际游玩分别记录。',
  'RGSS 游玩辅助支持安装备份与卸载恢复；MV/MZ 辅助重复连接保持插件文件一致。',
  '制作总览、设置、文字工作台和游玩辅助采用统一的操作说明，直接说明当前状态和下一步操作。',
  '暂停原因与可重试状态分别显示；历史原因保留，操作提示对应实际按钮。',
  '删除、导入新版、工作包冲突与源码副本说明明确处理范围和保留内容。',
  '共享连接测试直接核对共享设置，专用模型测试核对各自的连接。',
  '任务排队采用单轮索引，术语检查复用项目快照，大型文字列表使用数据库排序索引。',
  '可选择使用已提取文字继续制作，其余资源保留原文；普通制作不设置隐藏的累计请求或轮次额度，仍保留暂停和真实用量记录。',
  '原生提取结果通过主机句柄和分页交接，减少模型上下文和重复提取。',
  '同一资源的分批适配成果累计保存，已接受文字与回写定位持续保留。',
  '统一保护源文中的制表符、控制字符和行尾反斜杠，完成原样回写后接入文字工作台。',
  '技术适配与翻译校对共用“同时处理任务”设置，支持 1 至 32 项并行。',
  '每份通过验证的资源立即接入文字工作台，暂停和继续沿用已保存成果。',
  '技术进度分别展示已处理、通过、待处理及新增文字，并给出具体停止原因。',
  '已完成配方按实际覆盖选择复用，旧空任务自动收束，长输出按有限轮次接续。',
  '原生解析能力更新后，旧失败项目重新尝试当前解析器，再衔接资源级适配。',
  '技术检查点保存模型消息与工具证据；继续任务时复用已读资料和已验证配方。',
  '原生解包资源直接复用，独立副本按校验记录补齐缺失文件，减少重复读写与空间占用。',
  '模型按候选定位调用文字脚手架，生成标准适配器并执行回写检查。',
  '修复资源覆盖定位核对与 RPG Maker 选项分支注释兼容，保留显示文字和玩法索引。',
  '项目列表、制作总览与游玩辅助显示引擎图标，并保留 MV、MZ 等版本名称。',
  '支持拖入游戏目录、启动程序或快捷方式；项目可取消、删除并清理工作缓存。',
  '制作提供一键流程、仅翻译、仅校对与定向补漏，已有成果可继续使用。',
  '内置思源宋体、思源黑体、霞鹜文楷，字体卡片展示对应字形。',
  '扩展原生引擎适配，覆盖范围见软件中的引擎能力与随包源码说明。',
  'MV/MZ、XP、VX、VX Ace 提供角色物品、移动探索与回想配方辅助。',
  '回想页先扫描条件，再选择配方应用；相关原值保存在备份与恢复记录。', '',
  'Unity SerializedFile／UnityFS 结构化文字与 UI 文本接入原生回写和独立输出。',
  'Ren’Py 新增实时命名变量与 persistent 持久数据辅助。',
  '2000/2003 与 WOLF 提供存档编辑，写回前保存原文件备份。',
  'Tyrano、KAG3、Godot 2/3/4、PGMM、Unity Mono、SGB 与 Bakin 提供实时变量辅助。',
  'MV/MZ 成品可导出 JoiPlay 手机游玩包，保留中文资源与字体，附插件检查记录。',
  '设置页沿用单区滚动，项目删除入口使用红色强调。', '',
  'API 配置和项目索引保存在软件旁的 data 文件夹，密钥使用系统加密；新工程与汉化版默认放在游戏旁。更新程序不需要搬动工程。',
  '图像处理默认关闭；在设置中开启后，视觉模型处理界面候选与平整背景文字。',
  '本包完成构建、随包资源完整性和分享隐私检查；不是已经通过全部引擎及实际游玩验收的稳定版。', '',
  '官方软件免费提供，切勿付费购买官方资源；如已付费，请向销售方申请退款。',
  '源码随包提供于 SOURCE-CODE.zip，主程序许可证见 拼好汉化-LICENSE.txt。',
  '第三方依赖许可证见 resources/app/THIRD_PARTY_LICENSES；Electron 许可证保留在发行目录。', '',
].join('\r\n'));
await writeFile(path.join(stage, '测试说明.txt'), [
  `拼好汉化 ${version} · Windows x64 公测版`, '',
  '1. 将压缩包完整解压，双击 PinhaoWorkbench.exe。',
  '2. 在设置中填写 API 地址、模型和密钥，保存后测试连接。',
  '3. 添加原版游戏目录，点击开始制作；成果在成品页查看。',
  '4. 实时辅助从成品页启动游戏；存档编辑在关闭游戏后选择存档，修改后启动游戏读档。',
  '5. 反馈请附软件版本、游戏名称及引擎、操作步骤、截图和项目问题记录。',
  '分享截图与反馈前，请遮盖 API 密钥及自己的账户、目录等个人信息。', '',
  '本次更新：新的技术 Agent、调查证据接力、小批验证与接入，以及长工具连接、脚本状态和清理竞态修复。',
  '这是公测版，不是稳定版；持续补漏及全引擎效果仍需反馈。完整回归有一项多项目并发等待超时尚未定位。',
  '请保留原版、存档和已有工程，先用副本或小项目尝试；遇到异常先暂停并保留成果，不要反复从零制作。', '',
  '官方软件免费提供，技术与源码随包开放。', '',
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
