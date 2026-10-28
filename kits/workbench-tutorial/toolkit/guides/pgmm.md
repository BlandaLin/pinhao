# Pixel Game Maker MV

层级：已恢复的 project JSON 文本资源。与 RPG Maker MV 不是同一引擎。

```powershell
python demo.py --profile pgmm --out 'C:\Work\demo-pgmm'
python kickstart.py extract --engine pgmm --game 'C:\Work\Resources\data' --out 'C:\Work\pgmm-work'
```

选择含 `project.json` 的数据目录，而非只有 player.exe 的目录。按 `textList` 的 folder/children 递归导出文本资源各 locale，保留资源 ID、内部名字、fontId 和其他项目字段。不会把各 locale 自动去重：不同 locale 可能有不同用途，先确认游戏实际激活哪一栏。

`gameInformation.title` 与同目录 `info.json.title` 若存在需源值一致，译文也必须一致；不同步时 validate 失败。文本资源仍整段提取，不按图像字体字符编码切碎。

包内资源恢复、字体图集、字体映射、图片文字、插件和 player 依赖不在本配置中。中文 TTF 不能假定能替代图像字体；参考具体项目资源格式做专属改造。回写 JSON 到测试副本同位置，再检查语言激活、文本资源调用、字体和保存/读档。
