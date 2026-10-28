# 引擎路线调研记录

日期：2026-10-11。目标是给接手 AI 减少拆包/文本回写试错，不做作品推荐或市场份额统计。

## F95Zone 与 DLsite

尝试读取 F95Zone：本次浏览工具被 robots.txt 阻止，没有进入论坛、登录或绕过访问限制。因此没有站内抽样，也没有计算引擎占比。

尝试读取 DLsite 首页、商品/帮助相关页面：本次浏览工具未能取得可核验页面内容。不能据此声称哪些引擎“占市场多数”，也不能把搜索摘要当成完整商品样本。

用 F95 相关开源管理工具作补充线索：[moxie](https://github.com/Milisource/moxie)、[wLib](https://github.com/kirin-3/wLib) 的引擎检测分类涉及 Ren'Py、Unity、Unreal、Godot、RPG Maker、WOLF 等。这仅说明这些工具所处理的生态类别，不是论坛市场份额证据。

[Tyrano 官方网站](https://tyrano.jp/) 的作品介绍涉及商业发行/DLsite 使用案例；它能支持 Tyrano 作为日系文字游戏路线之一的判断，但也不代表 DLsite 的总体分布。

选型因此由三部分决定：我们已有项目验证经验、上述生态分类线索、对应引擎和格式的第一方文档。没有统计基础时不写“覆盖 90%”之类数字。

## 本版落地选择

| 优先级 | 路线 | 实际完成内容 |
| --- | --- | --- |
| 原生标准数据 | RPG Maker MV/MZ/Ace | 继承原生文本闭环与标准 RGSS 解包 |
| 原生翻译机制 | Ren'Py | RPA 2/3；`tl` 模板子集，避免翻译全部 Python 字符串 |
| 松散脚本/项目 | Tyrano/KAG、Twine、PGMM | 保守源格式子集，控制符/跳转/资源 ID 不动 |
| 有成熟外部导出路线 | WOLF、Godot、Unreal | WolfTL JSON、CSV、PO 的验证与回写小样 |
| 不适合统一猜字段 | Unity、LCF、GameMaker | 显式选择 JSON 桥接；Unity 可选只读 TextAsset 清点 |
| 先识别而非伪兼容 | XP/VX、NScripter | 检测/解包线索、缺口和接力步骤 |

Unity 资产版本与游戏脚本框架差异、WOLF 原生版本、Unreal 容器、NScripter 混排正文都不能用一个“找所有字符串”的函数解决。与其给能力较弱 AI 一个会误改代码的万能脚本，本版把每一步的输入/输出、闸门和未完成项写死。

## 测试与限制

新适配器使用中性资源测试，不公开游戏文本。本地已有 Tyrano、PGMM 和 WolfTL JSON 做了只读原样往返与单条技术标记闭环。MZ/Ace 旧成果用新入口复核。

真实 Ren'Py、Twine、Unity、Godot、Unreal、LCF、GameMaker、NScripter 的原生运行/导入没有在本版完成，不能把模拟/桥接测试写成实机兼容。可选 UnityPy 未安装，清点器使用模拟 API 对象测试。

以后若需更可靠的 F95/DLsite 分布调查，可由用户提供公开页面/商品清单，以明确时间、采样规则和去重方法另做统计；本版不等待这项研究，也不依赖它完成工具。
