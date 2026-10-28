# TyranoScript / TyranoBuilder

层级：松散 KS 源码的保守子集。Tyrano 与吉里吉里不是同一个引擎，语法相似不意味着插件/宏兼容。

```powershell
python demo.py --profile tyrano --out 'C:\Work\demo-tyrano'
python kickstart.py extract --engine tyrano --game 'C:\Games\Copy' --out 'C:\Work\tyrano-work'
```

通常处理 `data/scenario/**/*.ks`。识别 `tyrano/` + `data/scenario/`，默认 UTF-8，BOM 自动保留；其他编码必须显式 `--encoding`。导出连续正文整段、`#名字:表情` 的名字、明确的 text/jname/placeholder/title 引号属性。跳转标签、表情键、变量表达式保持不变。

`iscript`、`html`、块注释不进入翻译表；动态属性、未知命令、转义正文行列入 review。复杂多行标签、宏内显示参数、JS 动态 UI 和 HTML 按钮不是全部支持。不能从 “review_items 很多” 推断漏译数量，需按类别检查。

先原样 roundtrip，再只改一段实机验收。回写是原编码的定点字符区间替换，不重排全脚本。名框不允许换行/冒号，显示属性不允许新引号/标签；正文不能变成 `@`、`*`、`#` 命令行。

发行版若封装在 NW.js 包或其他容器，先在副本用该容器的正确工具导出源。字体与 JS UI 单独处理。来源：[官方网站](https://tyrano.jp/)、[官方源代码](https://github.com/ShikemokuMK/tyranoscript)。
