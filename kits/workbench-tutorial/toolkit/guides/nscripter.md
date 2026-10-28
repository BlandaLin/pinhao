# NScripter / ONScripter

层级：检测与外部路线；没有正文提取/回写器。

```powershell
python demo.py --profile nscripter-detection --out 'C:\Work\demo-nscript'
python kickstart.py probe --game 'C:\Games\Copy'
```

`nscript.dat`、`nscr_sec.dat` 或 `0.txt` + NSA 是线索，不是最终版本证据。示例文件只是中性检测签名，不是假可玩游戏或有效 NSA 归档。

先确认 NScripter/ONScripter 方言、编码、脚本恢复方法和资源布局。参考 [ONScripter 源码](https://github.com/ogapee/onscripter)。在一份很小的测试脚本上解析命令/标签/变量与正文，证明原样字节往返，再允许文本修改。

命令与正文可能在同一行、冒号分隔，日文编码也可能影响多字节判断；不能以“不是英文开头”或“包含假名”作为可翻译字段规则。不能直接套 KS 行解析器。接手 AI 若写专属适配器，先给中性混排语法建立测试，并保护跳转目标、点击等待、变量插值和资源路径。

确认运行器中文编码与字体；不要把所有原生字节强转 UTF-8。未实现解析与回写前，保持状态为 detect/external-recipe。
