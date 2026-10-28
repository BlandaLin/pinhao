# AI 汉化工作台教程与打样包

版本：1.3。导出可直接选择初翻、校对、润色；新增同一场景的完整接力与错误回包修复示范。保留文字经验、质量任务附页、疑点台账和正反例，不附发帖草稿。

把拆包、编码和回写交给技术 AI，把完整文字单元交给翻译、校对、润色 AI。文字 AI 不需要学游戏引擎，也不需要重写合并脚本。技术 AI 不需要替文字 AI 改剧情。这份教程教你怎样把这种分工落实为可检查的文件和操作步骤。

核心不是“更长的提示词”，而是**完整上下文、只读基线、稳定 ID、少量可写字段、程序校验和小样闭环**。程序挡住结构错误，文字人员判断含义，人负责范围与试玩。

## 从哪里开始

| 你要做什么 | 入口 |
| --- | --- |
| 分享方法或第一次组织项目 | `docs/01-简明教程.md` |
| 给 AI 接手一个新项目 | `AI_START_HERE.md`，再按职责选一份 prompts |
| 文字 AI 不会编码也不想维护 JSON | 只交 `text-only-ai`：译文与备注填在纯文本中 |
| 文字 AI 能编辑结构化工作表 | 只交 `text-ai` 或 `proof-ai`，不交全套技术材料 |
| 先照着完整打样练习 | `docs/02-打样操作.md`，现成示例在 `examples/` |
| 为自己的游戏建工作包 | `docs/03-技术建包规范.md` + `toolkit/AI_READ_FIRST.md` |
| 把已有工作包变成纯文字填写包 | `docs/04-纯文字接力.md`，无需再写转换器 |
| 照着做初翻 → 校对 → 润色 → 回写与故障修复 | `docs/08-完整接力与修复.md`、`examples/relay` |
| 给翻译、校对、润色设定质量底线 | `docs/05-信达雅文字质量手册.md` |
| 定向返工、安排抽查与控制重复成本 | `docs/06-定向复核与成本控制.md` |
| 直接交一张质量要求给文字 AI | `templates/文字质量任务附页.md`，先由负责人填好 |
| 给上下文受限的 AI 看正反例 | `examples/text-quality/示范与练习.md`，五组中性小样 |
| 了解经验来源及修正原因 | `docs/07-来源与改良说明.md`、`文字经验来源.json` |
| 新会话恢复或汇总批次 | `templates/新会话交接.md`、`templates/批次台账.json` |

现成示例有三套：RPG Maker 数据、Ren'Py 原生翻译模板、Tyrano KS。每套带翻译工作包、参考回包与错误回包。RPG Maker 还故意放入一条“她/他”语义错误，演示为什么结构校验不能代替文字校对。

最低编码负担的方式是 `text-only-ai`：技术人员已填好版本与 ID，文字 AI 只改 `TEXT=` 和 `NOTE=` 后的文字。程序把回包重新组装为标准 editable，再按原校验器验证，不让文字 AI 生成脚本、查映射或计算 hash。

## 文字质量怎么接力

本次吸收了项目负责人提供的《信达雅兜底手册》和《AI汉化交接指南》：术语先定，小样示范，先保原意再做自然度与风格，拿不准就按 ID 留疑点，只针对有问题的地方返工。文字 AI 读取本轮任务卡、必要上下文和填好的附页即可，不用每轮重读整套教程。

改良版把**结构硬错误、文字预警、语义结论**分开；保留稳定 ID，不按裸行号回填，不因原文重复就强行统一译文。长度比例、符号计数和可疑句法只能用于安排复核，不能保证无漏译或无人称错误。本包没有新增自动语义检测器，检查规则设计见第 06 篇。

## 不用重新找工具

`toolkit/` 已附 Game Localization AI KickStart 0.2：14 条引擎路线、11 个提取配置、自己的中性测试。无需另外下载工具包、API 密钥或大型运行库。Python 3.10+ 即可完成本教程的数据练习；可选 Unity 功能另需依赖。

本包新增入口是 `lesson.py`。它只生成中性教学数据、检查回包和回写示例。**教学资源不含商业引擎运行器，不是可玩游戏**。真实项目的字体、图片、插件、旧存档和实机验收仍按引擎处理。

`lesson.py export-text/import-text` 还可直接桥接 toolkit 0.2 所生成的真实 work，不局限三套教学例子；它不负责把未知旧格式猜成兼容格式。当前版本译文会完整导出，便于校对与润色串行接力。

`export-text --stage translation|proofreading|polishing` 会自动配置对应的纯文字任务卡、当前译文与回包说明。校对/润色必须显式传入 `--editable`，不会默默从初始未译表开始；版本指纹供技术侧核对，不是语义完成证明。

`examples/relay` 保留同一份 18 单元数据的各阶段完整输入、参考回包、差异、有效工作表和最终构建；还演示缺失占位符被拒绝后，修好回包再构建。想生成自己的完整示范可运行 `python lesson.py prepare-relay --out '../my-relay-practice'`。程序只使用预写中性答案，不调用翻译 AI。

```powershell
$env:PYTHONIOENCODING='utf-8'
python lesson.py check --lesson examples/rpgmaker --editable examples/rpgmaker/reference/good-editable
python lesson.py integrate --lesson examples/rpgmaker --patch examples/rpgmaker/reference/good-patch.json --out '../tutorial-practice-result'
```

输出必须是不存在的新目录，并在教程包/练习输入之外。读取 `examples` 不会改它。需要一份自己可编辑的练习时：

```powershell
python lesson.py prepare --profile rpgmaker --out '../tutorial-my-practice'
```

## 本包可以分享什么

工具、教程、任务模板、这里自造的中性例子可以随本包分享。实际游戏工作包含原始游戏文本/数据，应按项目权限处理，不能把教学包的分发规则直接套到商业游戏上。分享前不要混入个人存档、日志、密钥、机器路径或原版游戏文件。

代码使用随附 MIT 许可。教程与本包自造的中性示例允许免费转载、改编，注明来源为“AI 汉化工作台教程与打样包”即可；第三方工具和作品不包含在这项许可中。

## 验证范围

教学入口 15 项测试、内附 toolkit 51 项测试均通过，详见 VERIFICATION.json。纯文字导出/导入还在一份 13217 单元的既有 MZ 工作包上复核：147 个 editable 文件返回后逐字节一致；该真实工作包未放入分享包。

自行复测：在本包根目录运行 `python -m unittest discover -p 'test_lesson.py' -v` 和 `python -m unittest discover -s toolkit -p 'test_*.py' -v`。它们只使用中性测试资源，不访问你自己的游戏。教学示例没有运行器，不把数据验证称为实机试玩通过。
