# RPG Maker MV / MZ / VX Ace

层级：标准原生数据回写。`rpgmaker.py` 老入口保留；新入口是 `kickstart.py`。

```powershell
python demo.py --profile rpgmaker --out 'C:\Work\demo-rpg'
python kickstart.py extract --engine rpgmaker --game 'C:\Games\Copy' --out 'C:\Work\rpg-work'
python kickstart.py roundtrip --work 'C:\Work\rpg-work' --out 'C:\Work\rpg-roundtrip'
```

MV/MZ 根目录或 www 内需核心 JS 与 `data/System.json`。Ace 需 `Data/System.rvdata2`。对话按完整消息窗组织；选项显示与分支标签同步；内部事件名、注释脚本、自定义插件数据不自动翻译。

标准 RGSS v1/v3 归档用 `unpack --archive ... --out ...`，默认只导出数据，省去图片/音频复制。自定义包格式与加密不是默认兼容对象。构建仅是 data/Data 集合，放进测试副本相同路径；避免原归档覆盖或优先于松散数据，具体装配用实机确认。

MV/MZ 的插件 UI、字体和系统术语可能在 JS 内；Ace 的 Scripts.rvdata2 是代码，不按对白翻译。actor 改名/昵称事件已提取，但旧存档中已有的名字仍需项目专属载入兼容。

本版标准 MV/MZ 用合成测试，MZ 与 Ace 另有本地真实资源闭环。新项目仍需字节闭环和实机。图片题面、日文字符谜题、字体与存档另列清单。
