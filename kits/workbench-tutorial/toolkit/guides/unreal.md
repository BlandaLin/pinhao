# Unreal Engine

层级：PO 交换格式工作台 + 原生路线说明。没有 PAK/IoStore/locres 通用解包器。

```powershell
python demo.py --profile gettext-po --out 'C:\Work\demo-unreal-po'
python kickstart.py extract --engine gettext-po --game 'C:\Work\unreal-po-export' --out 'C:\Work\unreal-work'
```

PO 提取只改 msgstr，保留 msgid/msgctxt、引用和复数槽位。不能按原文相同合并不同 namespace/key/context。fuzzy 和元数据保持不变，需要原生导入复核；错误 PO 不通过时不改成随意 JSON 伪装已导入。

先参考 [Unreal 官方本地化流程](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-overview-for-unreal-engine)。只有编译资产时，可研究 [UnrealLocres](https://github.com/akintos/UnrealLocres) 的格式/版本支持；该工具实际导出格式不一定是 PO，必须显式转换且保留 namespace/key，或转成 `json-selected` 桥接。不要假定 CSV 改扩展名就成为 PO。

PAK 与 IoStore 是不同容器；打包/原生翻译文件、版本、签名/校验和字体是单独步骤。本包不会寻找密钥或自动执行外部工具。没有完成原生无改动往返与实机前，只报告交换格式闭环。
