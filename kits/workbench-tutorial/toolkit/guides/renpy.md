# Ren'Py

层级：RPA 2/3 解包 + 原生翻译模板子集。不是直接扫描所有 Python 字符串。

```powershell
python demo.py --profile renpy-template --out 'C:\Work\demo-renpy'
python kickstart.py unpack --archive 'C:\Games\Copy\game\scripts.rpa' --out 'C:\Work\renpy-unpacked'
python kickstart.py extract --engine renpy-template --language schinese --game 'C:\Games\Copy' --out 'C:\Work\renpy-work'
```

默认 RPA 只导出 .rpy/.rpyc；需要其他资源时显式加 `--all-resources`。RPA 2/3 使用受限数据反序列化，不执行 pickle 全局对象。RPYC 不在本包反编译范围；松散 RPYC 本身不能当 RPY 文本提取。

在**可信游戏副本**上用与游戏兼容的 SDK 生成 `game/tl/schinese/*.rpy`。官方 Windows SDK CLI 的形式如下，先查 SDK 实际目录：

```powershell
.\lib\py3-windows-x86_64\python.exe renpy.py 'C:\Games\Copy' translate schinese --empty
```

此 SDK 操作会运行 Ren'Py 初始化代码，本工具不会自动执行它。`dialogue` 导出报告不等同 `tl` 翻译模板。参考 [原生翻译文档](https://www.renpy.org/doc/html/translation.html)、[CLI](https://www.renpy.org/doc/html/cli.html)。

提取器支持模板中的常规 say 与 strings old/new；翻译 Python/style 块保持只读，复杂/triple-quote 语句列待复核。原生 translate ID、speaker 表达式、old 原文、插值和文字标签不变。空 new 保留为空直到有改动；已有 new 译文保留。

构建文件放回同路径 tl 目录，用原生 `Language("schinese")`/项目设置启用；另处理中文字体、GUI 样式、lint 与实际对话。不要改原版角色变量名来“翻译名字”。
