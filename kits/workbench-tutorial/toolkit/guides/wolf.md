# WOLF RPG Editor

层级：WolfTL 导出的 JSON 显示命令桥接。原生 .mps/.common/.dat/.wolf 的导出、导入由外部工具负责。

```powershell
python demo.py --profile wolf-export --out 'C:\Work\demo-wolf'
python kickstart.py extract --engine wolf-export --game 'C:\Work\export\dump\mps' --out 'C:\Work\wolf-work'
```

本配置针对 `code` + `intArgs` + `stringArgs` 的 WolfTL 命令结构：101/102 显示文字，以及 150 且文字模式的 picture 字符串。图片路径模式、脚本和非显示命令保持只读。数据库名称、字符串变量另用 `json-selected` 明确选字段，不递归翻译所有 stringArgs。

WOLF 的 `\\font[3]...\\font[0]` 特殊字形段和 `@数字` 等受保护；不能把这些特殊符号当人名翻译。不同版本可有扩展控制符，先检查样本，不保证覆盖所有插件。

外部路线可研究 [WolfTL](https://github.com/Sinflower/WolfTL)、[wolftrans](https://github.com/elizagamedev/wolftrans)。二者格式不能混用。先查工具版本与 help，证明一个文件的原样 roundtrip 再扩大。某些外部工具会删除已有输出目录，必须使用新目录；本包不下载/执行它们，也不提供通用兼容承诺。

在此前特定修正版 WolfTL 中使用过 `DATA_DIR EXPORT_DIR --create --skip-game_dat` 与 `DATA_DIR PATCH_ROOT --patch --skip-game_dat`，PATCH_ROOT/dump 装 JSON。但这不是所有发行版固定 CLI，不能机械照抄。先验证命令、目录布局和原生导入输出。

构建输出还是 JSON，不是游戏 Data。用匹配导出工具导入，再检查默认编码、字体、道具描述、回想名牌和旧存档字符串。没有 Game.dat 可靠适配时不顺手改它。
