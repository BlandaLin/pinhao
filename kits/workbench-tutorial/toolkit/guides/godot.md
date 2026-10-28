# Godot

层级：CSV / PO 本地化交换格式；不解 PCK、不改 GDScript 字符串。

```powershell
python demo.py --profile godot-csv --out 'C:\Work\demo-godot'
python kickstart.py extract --engine godot-csv --source-language en --language schinese --game 'C:\Work\godot-export' --out 'C:\Work\godot-work'
```

CSV 必须已有唯一的 key/source/target 三类列，默认 en -> schinese，可用参数指定项目实际 locale，如 zh_CN。不会新建列，不能把 key 或 source 栏当 target，重复 key/不同列数会失败。引号、双引号转义、多行和 CRLF 保留；只替换 target 单元格。locale 名必须与最终 Godot 设置一致，schinese 只是打样默认值。

PO 用 `--engine gettext-po`。保持 msgid/msgctxt 与 plural 槽位；fuzzy 标志保持并列复核，不自动决定翻译已审定。复数规则按目标 locale 与原生导入要求检查。

只有 PCK 时，先研究 [GDRETools](https://github.com/GDRETools/gdsdecomp) 对该版本的恢复能力，在副本上做原样恢复。再按照 [Godot 原生本地化文档](https://docs.godotengine.org/en/stable/tutorials/i18n/internationalizing_games.html) 导入翻译资源、注册 locale 并启用。回写 CSV/PO 并不自动更新 .translation 或运行 PCK。

没有原生项目/样本时只报告交换格式小样通过，不能说 Godot 游戏已经完成汉化。
