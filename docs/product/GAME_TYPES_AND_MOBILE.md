# 游戏类型与手机游玩

## SLG 与 ADV

SLG、ADV 是游戏类型。软件按游戏实际使用的引擎选择编解码路线，同一类型可以覆盖多个引擎。
导入后查看引擎名称、文字工作台、待处理候选与成品检查记录。

| 游戏实现 | 当前路线 | 继续适配的内容 |
| --- | --- | --- |
| RPG Maker 制作的策略、养成与冒险游戏 | 复用 RPG Maker 数据、事件、脚本显示文字及独立成品链 | 自定义插件、图片字与具体布局 |
| Ren'Py 视觉小说与带数值系统的游戏 | RPY／RPYC／RPA 文字工作台、原生回写、字体；命名变量实时辅助 | 自定义语法、混淆脚本和具体游戏存读档 |
| TyranoScript、KiriKiri／KAG 冒险游戏 | KS、ASAR、XP3／内嵌归档原生路线 | 自定义标签与加载器 |
| Unity 策略、养成或叙事游戏 | SerializedFile／UnityFS；JSON／CSV／TXT TextAsset、UI／TMP 字段、StringTable、内嵌动态 Font | 自定义 MonoBehaviour 显示字段、代码生成文字、加密资源、TMP 字体图集 |
| Godot 冒险或策略游戏 | PCK／内嵌包、场景与脚本恢复、翻译目录 | C#／GDExtension 内文字、加密包 |
| Naninovel 等 Unity 叙事框架 | 结构化资源可进入 Unity 路线；框架脚本进入独立适配清单 | `.nani` 指令、行号关联、动态资源加载与框架专用本地化表 |
| ONScripter／NScripter | 后续独立适配 | `0.txt`／`nscript.dat` 指令、NSA／SAR 容器、编码和运行器字体 |
| 其他专用 SLG 引擎 | 取得样例后评估原生编解码与运行器 | 数据模型、事件与专有容器 |

这次将投入集中在 Unity 原生资源、已有 ADV 路线与 Ren'Py 辅助；新专用引擎根据样例和工作量继续安排。
引擎输入、输出及实际验证范围见[实现进度](IMPLEMENTATION.md)和[原生路线](NATIVE_ENGINES.md)。

参考：[Ren'Py 官方介绍](https://www.renpy.org/)、[Tyrano 官方示例](https://tyrano.jp/example)、
[Naninovel 本地化](https://pre.naninovel.com/guide/localization)、
[ONScripter 官方说明](https://ogapee.github.io/www/onscripter_en.html)。

## JoiPlay 手机包

成品页为 RPG Maker MV／MZ 提供“导出手机游玩包”。生成的 `.rga` 使用
[JoiPlay 官方 RGA 格式](https://github.com/joiplay/rga)：ZIP 容器加 `game.cfg`，以 HTML 入口运行。

- 保留原有目录、`index.html`、汉化数据、图片、音频与字体。
- 排除桌面 EXE／DLL、常见 NW 运行文件、私有存档和工作台构建报告。
- 自动生成游戏标题、稳定包 ID、入口路径及中文使用说明。
- 检查启用插件中的常见桌面 API 引用，将文件定位写入包内报告。
- 原成品和原存档保持原样；导出后在资源管理器中定位 `.rga`。

手机端安装 JoiPlay 后导入 `.rga`；也可解压并在 JoiPlay 中添加包内 `index.html`。
实际设备需要试玩启动、字体、触控、音频与保存读档。包内报告明确保存
`phoneRuntimeVerified: false`，待项目完成手机验收后登记结果。
依赖 Windows DLL、桌面 Node 接口或鼠标键盘专用交互的插件，由项目专用配方处理。

本功能在 Windows 工作台上整理手机游玩资源，输出 `.rga`；Android APK 制作、工作台 Android
客户端和 RPG Maker 旧系列移动运行器接入留待后续版本。
