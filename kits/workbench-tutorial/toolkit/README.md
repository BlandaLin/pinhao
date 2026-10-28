# Game Localization AI KickStart 0.2

面向接手 AI 的拆包、文本工作台与回写打样。它负责技术流程，不调用翻译 API，不附带游戏内容，不运行游戏脚本。旧版 RPG Maker 专用包无需删除。

这不是“一键汉化所有引擎”。本版提供 14 个引擎路线条目、11 个可运行提取配置，以及相应的示例或外部工具接力说明。识别、文本导出、原生回写、实机验收是四件不同的事。

## 支持层级

| 引擎 | 本包能直接做什么 | 仍需接手 AI 做什么 |
| --- | --- | --- |
| RPG Maker MV / MZ / VX Ace | 标准数据库、完整对话窗、选择项提取和原生数据回写；标准 RGSS 解包 | 插件、自定义字符串、字体、图片、存档兼容、实机 |
| RPG Maker XP / VX | 识别；标准 RGSS 解包 | 旧版 Marshal 字段与编码适配；没有文本回写器 |
| RPG Maker 2000 / 2003 | 识别；显式 JSON 桥接示例 | LCF 原生导出、导入与代码页 |
| Ren'Py | RPA 2/3 脚本解包；原生 `tl` 模板提取与回写 | RPYC 恢复、SDK 生成模板、语言启用、字体、lint |
| TyranoScript / TyranoBuilder | 松散 KS 的保守子集：整段正文、名字和明确显示属性 | 发行包解包、宏、JS/HTML、图片 |
| 吉里吉里 / KAG | 松散 KS 同类子集；保留 BOM 与指定编码 | XP3 解包、KAG 方言、TJS、中文运行环境 |
| Twine / SugarCube | Twee、Twine2 HTML 正文子集回写；链接目标与宏受保护 | Harlowe、宏内文字、代码及隐藏 UI |
| Pixel Game Maker MV | `project.json` 文本资源与标题；`info.json` 标题同步 | 打包资源、字体、图片、运行器 |
| WOLF RPG Editor | WolfTL JSON 显示命令桥接 | 原生导出/导入、数据库和变量字符串、版本匹配 |
| Unity | 可选 TextAsset 只读清点；显式 JSON 桥接 | 具体游戏资源定位、原生导入、Mono/IL2CPP、字体 |
| Godot | 已导出的多语言 CSV / PO 目标栏回写 | PCK 恢复、翻译资源导入和语言启用 |
| Unreal | PO 目标项回写示例 | PAK / IoStore / locres 转换和原生导入 |
| GameMaker | `data.win` 识别；显式 JSON 桥接示例 | 原生导出/导入、GML 与字体定位 |
| NScripter / ONScripter | 识别与路线示例 | 混合命令/正文语法、脚本恢复、编码；没有文本回写器 |

桥接示例只证明 JSON、CSV、PO 的文本闭环，不证明对应商业游戏能启动。Flash、RPG Developer Bakin、SRPG Studio、自研引擎及自定义加密没有原生适配器。不能把未知格式硬套成上述格式。

## 最短使用流程

需要 Python 3.10+。除可选的 Unity 清点外，仅用标准库。Windows 终端先设 `$env:PYTHONIOENCODING='utf-8'`。所有输出都必须是**不存在的新路径**，且不得放在源目录/工作包内部。

在本包目录执行 `python -m unittest discover -p 'test_*.py' -v` 可运行中性自动化测试；不会访问自己的游戏。

```powershell
python kickstart.py catalog
python kickstart.py probe --game 'C:\Games\Example'
python kickstart.py plan --game 'C:\Games\Example' --out 'C:\Work\example-plan.json'
python demo.py --profile rpgmaker --out 'C:\Work\demo-rpgmaker'
python kickstart.py extract --game 'C:\Games\Example' --engine rpgmaker --out 'C:\Work\example-work'
python kickstart.py roundtrip --work 'C:\Work\example-work' --out 'C:\Work\example-nochange'
```

先读 `AI_READ_FIRST.md` 与 `plan` 指定的引擎指南。`probe` 多候选时需要确认根目录或显式配置，不自动猜。`extract --engine` 接受提取配置名，不是引擎品牌名，例如 `renpy-template`、`wolf-export`、`json-selected`。

工作包里 `editable/*.json` 是翻译表，每批默认 120 单元。正文保留整段上下文；不会为了省 Token 把一句话按字符切碎。`source_preview` 用于阅读，`source` / `translation` 中的控制符使用占位符。

翻译 AI 只改 `translation` 与 `notes`。也可只交增量补丁：

```powershell
python kickstart.py patch-template --work 'C:\Work\example-work' --out 'C:\Work\return-patch.json'
python kickstart.py merge --work 'C:\Work\example-work' --patch 'C:\Work\return-patch.json' --out 'C:\Work\example-merged'
python kickstart.py build --work 'C:\Work\example-work' --editable 'C:\Work\example-merged\editable' --out 'C:\Work\example-built'
python kickstart.py verify --work 'C:\Work\example-work' --editable 'C:\Work\example-merged\editable' --build 'C:\Work\example-built'
```

`merge` 的补丁格式见 `PATCH_EXAMPLE.json`。相同 ID 即使译文相同也不自动覆盖；错误基线、未知 ID、占位符增删/重排会失败。直接改整套 editable 时先执行 `validate`，再 `build`，不需要 `merge`。

## 输出与验收

`build` 只输出**基线里记录的数据/源文件集合**及报告，不是完整可玩的游戏。先把这些文件放进测试副本的相同相对路径；桥接引擎还需要外部工具原生导入。不要把 `build-report.json` 放进游戏数据目录。

`roundtrip` 验证原样回写逐字节一致；`verify` 核对本包重建结果。两者都不证明游戏逻辑、字体或界面没问题。必须再验收：启动、标题、一次对话与选择分支、保存/读档、回想房、菜单、字体缺字与换行。原文存在的调用、动态表达式与资源 ID 不翻译。

Ren'Py / CSV / PO 的空目标不会被“不改动构建”填成英文；这样才能保留原始空模板。已有译文作为初始目标保留。只有改变目标内容才会产生文本替换。

字体、图片文字、插件 UI、旧存档中的人名/变量值不是本文本提取器自动解决的内容，详见 `ACCEPTANCE.md`。失败输出可能留作检查，重新运行请换新目录，不要关闭验证闸门。

## 文件入口

- `AI_READ_FIRST.md`：直接交给技术 AI 的工作约束与流程。
- `TRANSLATOR_HANDOFF.md`：交给文字 AI 的简短任务说明。
- `guides/`：14 条引擎路线，每条都有示例与缺口。
- `demo.py`：生成中性资源、工作包、回包、构建和校验结果。
- `test_*.py`：离线自动化测试。
- `RESEARCH.md` / `SOURCES.md`：调研来源、访问限制和选型依据。
- `VERIFICATION.json`：本版实际验证范围，不代表全市场兼容率。

本工具包可以独立分享。实际 `extract` 生成的工作包含原始游戏资源与文本，不应当随工具公开；对外发布前也请排除存档、日志、用户名路径和密钥。
