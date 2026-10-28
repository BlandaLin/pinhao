# 技术 Agent 引擎手册

产品按已识别的引擎选择一份手册，连同共用执行与覆盖契约完整送入技术 Agent 的系统指令。
不是让 Agent 先翻一本十六引擎总书，也不把十六份正文全部发出。
`engine-operations.mjs` 是选择与装配入口；`inspect_context` 只返回索引，显式补读才返回相应正文。

## 十六份独立手册

| 引擎或版本 | 正文唯一维护位置 |
| --- | --- |
| RPG Maker MV | [rpgmaker-mv.mjs](rpgmaker-mv.mjs) |
| RPG Maker MZ | [rpgmaker-mz.mjs](rpgmaker-mz.mjs) |
| RPG Maker XP | [rpgmaker-xp.mjs](rpgmaker-xp.mjs) |
| RPG Maker VX | [rpgmaker-vx.mjs](rpgmaker-vx.mjs) |
| RPG Maker VX Ace | [rpgmaker-vx-ace.mjs](rpgmaker-vx-ace.mjs) |
| RPG Maker 2000 | [rpgmaker-2000.mjs](rpgmaker-2000.mjs) |
| RPG Maker 2003 | [rpgmaker-2003.mjs](rpgmaker-2003.mjs) |
| WOLF | [wolf.mjs](wolf.mjs) |
| Ren'Py | [renpy.mjs](renpy.mjs) |
| KiriKiri/KAG | [kag.mjs](kag.mjs) |
| TyranoScript | [tyrano.mjs](tyrano.mjs) |
| Unity | [unity.mjs](unity.mjs) |
| Godot | [godot.mjs](godot.mjs) |
| Pixel Game Maker MV | [pgmm.mjs](pgmm.mjs) |
| SMILE GAME BUILDER | [sgb.mjs](sgb.mjs) |
| RPG Developer Bakin | [bakin.mjs](bakin.mjs) |

正文采用多行文本模块，源码直接运行与 Electron 打包使用同一份内容，无需另加文档加载器或复制资源路径。
共同的工具协议只维护一次。Unity 专用原生审阅段依实际登记能力装配，不把手册当作工具安装器。
当前原生识别可能仅返回 `RPG Maker 2000/2003`；此时明确标记 LCF 版本未确认，不把内部默认 codec 参数冒充准确识别。

## 维护准则

- 从真实资源、消费者和报错提炼方法；不加入游戏名判断、私人路径、测试答案、长候选编号或游戏原文。
- 写清载体、文字边界、原生工具、剩余调查、错误反馈、原生回写和验收，不堆版本百科。
- 工具是否可用与参数以当前登记目录为准。手册不限制通用工具、代码编写、受管执行或独立任务并发。
- 明确显示文字与逻辑身份、可读投影与原生载体、局部覆盖与整份资源完成、结构验证与实际运行的区别。
- 已读证据、恢复位置与已有工作台继续复用。原版只读，必要资源按需复制，不按 Agent 反复解包全游戏。
- 修改指南时递增装配版本，并运行 `engine-operations.test.mjs`、工具契约和实际请求装配测试。
- 文档通过不等于 Agent 能力通过。实际新增位置、用途、原生回写、请求数、时间与用量由真实运行另行验证。

## 事实来源

引擎描述参考原作者资料，产品能力以当前实现及实际工具结果为准：

- [MV 原作者 Game_Interpreter](https://github.com/rpgtkoolmv/corescript/blob/master/js/rpg_objects/Game_Interpreter.js)、[MZ 插件注解](https://rpgmakerofficial.com/product/mz/plugin/make/annotation.html)：事件与插件的真实消费者；MZ 参数还应核对目标游戏实际运行代码。
- [Ruby Marshal](https://docs.ruby-lang.org/en/master/marshal_rdoc.html)、[EasyRPG/liblcf](https://github.com/EasyRPG/liblcf)：RGSS 序列化与 LCF 格式，不代表本产品自动支持每种编码或运行时。
- [Unity TextAsset](https://docs.unity3d.com/Manual/class-TextAsset.html)、[Unity 脚本后端](https://docs.unity3d.com/Manual/scripting-backends.html)：载体类型与 Mono/IL2CPP 区别。
- [Godot 资源包](https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html)、[本地化](https://docs.godotengine.org/en/stable/tutorials/i18n/internationalizing_games.html)、[GDRETools](https://github.com/GDRETools/gdsdecomp)：资源恢复、语言键与实际包加载。

具体产品能力核对 `adapters/python` 下对应引擎的原生模块、`source_native.py`、
`kits/workbench-tutorial/toolkit/text_formats.py` 及 `packages/core/native-tools.mjs`。
普通字面量、覆盖分类、证据补读与脚本执行以 `packages/technical/adaptation.mjs` 及其子模块为准。
真实游戏、私人审计报告和模型请求不随公开源码分发。
