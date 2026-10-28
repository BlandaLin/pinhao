# GameMaker

层级：FORM data.win 线索识别 + 显式 JSON 桥接。没有 data.win 原生导入器。

```powershell
python demo.py --profile json-selected --out 'C:\Work\demo-gamemaker-bridge'
python kickstart.py probe --game 'C:\Games\Copy'
```

先研究 [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool) 对实际 GameMaker 版本的支持，在副本打开原生数据，做一个原样保存样本并试玩。该项目涵盖多种 GameMaker 游戏，但不是全部版本的保证；YYC/VM 编译形式不同。

确认 string table 中哪些是显示文本，哪些被作代码、资源名或查找键使用。不要对所有字符串统一替换。可把明确的对白数据导出成 JSON，保留 native index/资源上下文，按 Unity 指南的 `json-selected` 选择表提取。

桥接构建输出不是 data.win；必须用对应原生工具回导，确认指针/长度、字体字形集、GML 对文字的依赖。图像字体和字符串作键的作品可能需要项目专属代码调整。示例只证明明确定义的 JSON 字段回写。
