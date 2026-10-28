# RPG Maker XP / VX

层级：检测、标准 RGSS 解包与路线说明，**没有 XP/VX 文本提取/回写器**。`.rxdata`、`.rvdata` 不能靠改扩展名套用 Ace。

```powershell
python demo.py --profile legacy-detection --out 'C:\Work\demo-legacy'
python kickstart.py probe --game 'C:\Games\Copy'
python kickstart.py unpack --archive 'C:\Games\Copy\Game.rgssad' --out 'C:\Work\legacy-data'
```

示例只证明识别，不是可运行游戏。接手 AI 先查对应版本的原生字段、Ruby Marshal 对象图与编码。XP/VX 可能没有 Ruby 1.9 的字符串编码标注；必须证明一条译文的编码与运行器兼容，不能统一把所有字节强改 UTF-8。

可复用本包 `ruby_marshal.py` 读取/定点字符串替换能力，但仍要单独实现字段选择和消息窗规则，补回归测试。不得翻译脚本字节、类名、符号名或资源键。先无改动 roundtrip，再改一条并试玩。失败时保持路线为未完成。
