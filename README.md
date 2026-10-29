<p align="center">
  <img src="apps/desktop/public/pinhao-app-icon.png" width="136" height="136" alt="拼好汉化四字红印方标">
</p>

<h1 align="center">拼好汉化 · Pinhao</h1>

<p align="center"><strong>把喜欢的游戏，做成读得懂的故事。</strong></p>

<p align="center">
  面向 Windows 的游戏汉化工作台，把资源处理、AI 翻译校对和成品制作放在同一流程，帮助你制作可以独立运行的汉化版。
</p>

<p align="center">中文 · <a href="README.en.md">English</a></p>

<p align="center">
  <a href="https://github.com/BlandaLin/pinhao/releases/tag/v0.5.8"><strong>下载 0.5.8 Windows 便携版</strong></a> ·
  <a href="#开始你的第一个项目">开始使用</a> ·
  <a href="#适合哪些游戏">适用范围</a> ·
  <a href="#当前状态与已知问题">当前已知问题</a>
</p>

<p align="center">
  <strong>0.5.8 公开测试版</strong> · Windows 10 / 11 x64 · 软件免费，模型费用按所选服务计
</p>

![历史界面演示：中性示例项目的制作总览](.github/media/overview.png)

<p align="center"><sub>历史界面演示，使用原创中性示例与本地模型演示数据；不是 0.5.8 真实游戏验收截图。</sub></p>

## 从喜欢一款游戏开始

我自己做游戏汉化时，已经用现有工具做出过成品。但有些文字，现成解析器提取不出来，后面的翻译和制作也就无法继续。

拼好汉化从这个问题出发：把原生工具、AI 的技术调查、翻译校对和成品制作接在一起。我希望遇到特殊格式时，软件能够继续研究、尝试适配，让更多汉化项目有机会做下去，而不是把一堆工具和配置重新交给使用者。

| 你想完成的事 | 拼好的做法 |
| --- | --- |
| 制作一份能检查、能独立运行的汉化版 | 提取、翻译、校对与构建在同一工作台完成，输出独立游戏副本，再检查实际显示与游玩效果。 |
| 提取卡住时，继续调查缺口 | 技术 Agent 查看文件、运行工具并尝试编写适配方案；通过验证并正式接入的文字才进入翻译。 |
| 留住成果，方便修改与接力 | 已接受译文持续保存，可以在工作台修订，也可用开放文字工作包交给其他 AI 工具或译者，再导回项目。 |

**导入游戏 → 提取与调查缺口 → 翻译与校对 → 生成独立副本 → 检查后游玩**

## 适合哪些游戏

主要面向 RPG Maker、同人 RPG、ADV 和相关轻型引擎游戏。以下是已接入的处理路线，不是所有游戏全流程通过的保证。

| 引擎 | 已提供的路线 | 仍需注意 |
| --- | --- | --- |
| **RPG Maker MV / MZ、XP / VX / VX Ace、2000 / 2003** | JSON、Ruby Marshal、LCF 原生数据与独立组装；2000/2003 中文成品携带 EasyRPG。 | 自定义插件、脚本动态文字、老运行器与布局。 |
| **WOLF RPG Editor** | 归档提取、WolfTL 原生回写、字体配置与组装。 | 归档变体、编码与实际游戏运行。 |
| **TyranoScript / KiriKiri KAG** | KS 场景、显示名与按钮，标准 ASAR、raw/zlib XP3 及相应内嵌归档。 | 自定义标签、宏、脚本及厂商加密。 |
| **Ren'Py** | RPY、RPYC 静态恢复、RPA2/3，已接入的对白、选项、人物名与 UI。 | 自定义 Python 显示逻辑与具体游戏布局。 |
| **Godot / Unity** | PCK、UnityFS 等原生资源路线，已接入的场景、文字载体与字体处理。 | 加密包、自定义脚本、动态显示与 Unity TMP/SDF 字体。 |
| **Pixel Game Maker MV / SMILE GAME BUILDER / RPG Developer Bakin** | 已接入的原生目录、资源容器、显示事件文字及运行器组装。 | 格式版本、特殊资源与真实游玩验证。 |

引擎识别、文字提取、原生回写和实际可玩分别检查。各路线的格式与验证范围见[实现矩阵](docs/product/IMPLEMENTATION.md)和[原生引擎说明](docs/product/NATIVE_ENGINES.md)。

目前配图展示的是界面操作，还不是“原游戏 → 文字工作台 → 中文成品”的真实案例对照；技术 Agent 的适配尝试也不等于已经解决该游戏的全部漏提。

## 开始你的第一个项目

准备 **Windows 10 / 11 x64**、一个游戏目录，以及自己的模型接口。

1. **打开工作台。** 下载 [`pinhao-0.5.8-Windows-x64.zip`](https://github.com/BlandaLin/pinhao/releases/download/v0.5.8/pinhao-0.5.8-Windows-x64.zip)，完整解压到可写目录，启动 `PinhaoWorkbench.exe`；不要只取出 EXE。
2. **接好模型。** 在“设置”填写 OpenAI-compatible 接口地址、模型名和密钥。技术与文字连接可用相同或不同模型，翻译与校对共用文字连接。
3. **导入游戏，先试一段。** 拖入游戏目录、启动程序或 Windows 快捷方式，查看提取结果与待处理项，再开始制作。先用少量文字确认效果和 API 开销。
4. **打开并检查成品。** 在“成品与导出”打开独立汉化副本，检查对白、选项、字体及存读档；确认后再按需导出分享 ZIP。

**文件在哪里？** 设置和索引在程序旁的 `data`；工程默认在原游戏旁的“游戏名-拼好工程”，成品默认在旁边的“游戏名-汉化版”。资源按工具需要准备，详见[工程与磁盘存储](docs/product/PROJECT_STORAGE.md)。

**当前下载包的界面为中文。** 中英文主页已提供，英文界面公测版计划后续制作，尚无单独的英文版下载。本地模型需要提供兼容接口，接入示例见[本地模型说明](docs/product/LOCAL_MODELS.md)。

**官方软件免费，切勿付费购买官方包。** 模型服务可能收费，技术调查、翻译和校对请求都可能计入服务商账单。

## 当前状态与已知问题

0.5.8 是公开测试版。[首轮 GitHub 自动检查](https://github.com/BlandaLin/pinhao/actions/runs/40733479423)有 **4 项测试未通过**：其中两项已定位为 Windows 长短路径比较问题，另两项仍待定位，不能视为已经修复。

源码检查、模型任务结果和游戏内实际效果是不同的证据。请保留原版与存档，从短场景开始验证；未知插件、加密资源、图片文字和字体布局可能需要继续处理。

完整状态、版本边界与下载说明集中在 [0.5.8 发布说明](docs/release-notes/v0.5.8.md#known-issues)。

**欢迎用一段实际场景帮助改进。** 在 [Issues](https://github.com/BlandaLin/pinhao/issues) 告诉我们软件版本、引擎、操作步骤、预期与实际结果，以及卡住的阶段或漏字位置。附脱敏截图即可，不必公开上传完整游戏、个人工程、API 配置或私人存档。[反馈与贡献指南](docs/CONTRIBUTING.md)。

## 技术 Agent 怎样处理提取缺口

原生解析器先处理已知格式。遇到提取失败或漏提资源时，技术 Agent 可以查看文件、检索公开资料、运行工具并尝试编写适配方案。候选经过宿主验证并正式接入，才会成为工作台中的文字；模型说“完成”不等于任务成功。

技术执行采用 **[DeepSeek Harness](docs/product/DSH_RUNTIME.md)**，模型仍由你选择，不要求使用 DeepSeek 模型。项目保存可复用的适配结果，并在复用时核对资源基线；这里的复用不是重新训练模型。

<details>
<summary>执行权限与验证细节</summary>

轻量 JavaScript 配方通过 QuickJS WASM 和主程序提供的文件能力执行。需要编写新脚本时，技术 Agent 使用受管本地执行，首次启用须为当前项目授权。

脚本以当前 Windows 用户权限运行，可访问该用户的文件与网络；这不是操作系统强隔离沙箱。主程序保管 API 密钥，产品不向脚本传入密钥。暂停后可以撤销授权。

宿主检查原样往返、允许的文字修改、控制符与改文回读，再将通过的结果接入文字及构建流程。DeepSeek Harness 的固定版本、上游来源和 MIT 许可见[运行时说明](docs/product/DSH_RUNTIME.md)。

[自主适配与验证](docs/product/AUTONOMOUS_ADAPTATION.md)

</details>

## 文字成果，可以继续接力

初翻处理完整语义单元与必要场景、人物参考，专名随译文积累，不先另做一轮付费全量词表整理。场景校对后，人物与术语复核针对实际分歧与明确问题，不无条件再审一遍全文。

“已审阅”表示场景审阅结果已保存；“校对已完成”表示收尾检查及正式提交完成。文字工作台可以搜索、翻页、查看上下文和修订当前译文。

![历史界面演示：文字工作台的原文、译文与上下文](.github/media/text-workbench.png)

*历史界面演示，使用原创中性示例；不是 0.5.8 实际游戏成果对照。*

开放 ZIP 文字工作包可交给外部 AI 工具或译者，再导回同一项目。程序负责身份映射、保护标记与版本合并，不让模型反复搬运工程定位结构。

<details>
<summary>工作包里有什么</summary>

包含阅读入口、源文、场景参考、导出时的译文基线、JSON 或纯文字编辑入口、共享术语和问题记录。

当前导出 **PinHao Text Package 0.2**，可导入完整的旧 0.1 包。稳定 ID 留在本地及工作包中，回导使用三方合并处理期间发生的修改。

[格式与参考实现](packages/exchange/README.md) · [工作包设计](docs/product/TEXT_PACKAGE.md) · [文字接力与恢复](docs/product/TEXT_EXECUTION.md)

</details>

## 字体、游玩辅助与其他功能

- 内置思源宋体、思源黑体、霞鹜文楷；可沿用游戏字体或选择自己的 TTF/OTF。具体字体与布局仍须在成品中检查。
- [游玩辅助](docs/product/PLAY_ASSIST.md)按引擎提供角色、物品、金钱、移动、开关与变量等入口；回想解锁依赖已确认的游戏条件，不是通用一键解锁。
- MV/MZ 成品可导出 JoiPlay `.rga`，手机端效果需要[实际设备检查](docs/product/GAME_TYPES_AND_MOBILE.md)。可选图片文字回写目前覆盖平整背景 PNG 区域。
- 侧栏可切换日间与深夜模式；已有译文和版本记录可供后续修补与新版接力。

<details>
<summary>字体与首次使用引导的历史界面演示</summary>

![历史界面演示：字体选择](.github/media/font-choices.png)

![历史界面演示：首次使用引导](.github/media/welcome.png)

以上均为历史界面演示，不代表重新拍摄的 0.5.8 实测截图。

</details>

## 开发与资料

Electron + TypeScript/React + SQLite，进程外 Python 复用原生编解码器。技术 Agent 使用 DSH，翻译与校对沿用独立文字协议；产品负责作业状态、业务验证和成果接入。

<details>
<summary>从源码运行与打包</summary>

Windows 上准备 **Node.js 24.5+**、npm 和 Git：

```powershell
npm ci
npm run prepare:tools
npm run prepare:dsh -- --build
npm run build
npm run desktop
```

准备脚本下载并核验固定工具、字体及 DSH，首次需要联网。源码构建旧版托管桥需要 Windows 的 **.NET Framework 3.5** 功能；便携包已带编译好的桥。完整依赖见[桌面开发说明](apps/desktop/README.md)与[DSH 运行时](docs/product/DSH_RUNTIME.md)。

```powershell
npm test
npm run test:engines
npm run test:ui
npm run package
```

`test:engines` 需要可用的 Python；发行目录生成在 `local/releases/<版本>/PinhaoWorkbench-win32-x64/`。组件测试使用中性样例或本地模拟端点，不代替真实模型、实际游戏与干净机器验收。当前 CI 状态见上方已知问题。

</details>

[产品与架构](docs/product/README.md) · [实现与验证矩阵](docs/product/IMPLEMENTATION.md) · [工程经验](docs/工程经验.md) · [反馈与贡献](docs/CONTRIBUTING.md)

开发者可以从引擎适配、已知问题和文档改进参与；译者可以提供一个能说明术语或上下文问题的小例子。可公开再分发的样例和脱敏复现最有帮助。

## 许可与分享

**官方软件免费，技术开放；切勿付费购买官方包。** 欢迎分享官方地址、贡献与支持。

桌面程序与产品模块采用 [GPL-3.0-or-later](LICENSE)，开放文字读写库采用 [MIT](packages/exchange/LICENSE)。允许依许可证商业使用；分发 GPL 改版时提供相应源码。内置字体采用 SIL Open Font License，第三方组件保留各自许可证。

游戏资源、译文和分享行为遵循各自授权。
