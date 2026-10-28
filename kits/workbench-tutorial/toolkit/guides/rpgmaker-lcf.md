# RPG Maker 2000 / 2003

层级：LCF 外部工具路线 + 显式 JSON 桥接示例；不是原生 LDB/LMU 导入器。

```powershell
python demo.py --profile json-selected --out 'C:\Work\demo-lcf-bridge'
python kickstart.py probe --game 'C:\Games\Copy'
```

`RPG_RT.ldb` 提示 LCF 数据。先研究 [EasyRPG liblcf](https://github.com/EasyRPG/liblcf) 或 [rpgrt](https://github.com/johannschopplich/rpgrt) 的对应版本导出/导入能力。记录工具版本，导出一张地图并证明原样往返；不能凭已有 JSON 示例猜测外部工具格式。

将实际导出的 JSON 定位为明确可显示字段，写 `json-selected` selection；保留原生事件命令、数字 ID、分支和编码信息。模板见 Unity 指南或 `demo.py --profile json-selected` 输出。

之后走通用工作台，再用**同一工具版本**原生导入。LCF 的代码页和中文运行器是单独问题，检查 `RPG_RT.ini` 与字符编码，不用新版 MV 的 JS 字体补丁套用。没有原生样本时，只报告桥接小样通过。
