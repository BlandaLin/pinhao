# Unity / Unity 制作的视觉小说框架

层级：可选 TextAsset 只读清点 + 显式 JSON 字段桥接。没有通用 Unity 原生重打包器。

```powershell
python demo.py --profile json-selected --out 'C:\Work\demo-unity-bridge'
python kickstart.py unity-inventory --asset 'C:\Games\Copy\Example_Data\resources.assets' --out 'C:\Work\unity-inventory'
```

第二个命令需要另外准备与 Python/资产版本兼容的 [UnityPy](https://github.com/K0lb3/UnityPy)，本包不会自动安装。它只列 TextAsset；UTF-8 候选写到 `textassets.json`，二进制/未知编码仅在 inventory 记录。`native asset_file + path_id` 联合保留，不能只凭 TextAsset.m_Name 合并不同资源。清点后核对源资产哈希未变。

文本候选可能是 shader、Lua、配置、Ink 编译 JSON、Yarn 脚本或内嵌二进制；**候选不等于对白**。从实际显示用途确认目标，导出成 JSON；不得把代码当文本逐字翻译。显式选择文件格式：

```json
{
  "schema": "kickstart-json-selection-v1",
  "fields": [
    {"file": "dialogue.json", "path": ["lines", 0, "text"], "kind": "display_text", "context": {"speaker_id": "CLERK_ID"}}
  ]
}
```

```powershell
python kickstart.py extract --engine json-selected --game 'C:\Work\unity-export' --selection 'C:\Work\unity-export\selection.json' --out 'C:\Work\unity-work'
```

导出 JSON 与 selection 的制作由接手 AI 完成；只选显示槽位，其余全部保持结构。生成的 JSON 要以原生资产身份定位回导：TextAsset、MonoBehaviour 与 Addressables/Bundle 不能共用一条固定写法。缺失 TypeTree、IL2CPP、Bundle 校验、TMP 字体图集需要按项目解决。

可以研究 [UABEA](https://github.com/nesrak1/UABEA) 的对应版本导入流程；本包的 verify 只验 JSON，不验 Unity 原生资产。可选 inventory 在本版只通过模拟对象测试，未安装 UnityPy、未对真实 Unity 游戏做原生回写。
