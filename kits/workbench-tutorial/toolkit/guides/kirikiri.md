# 吉里吉里 / KAG

层级：KS 源文本子集；XP3 解包与 TJS 不内置。

```powershell
python demo.py --profile kirikiri --out 'C:\Work\demo-kag'
python kickstart.py extract --engine kirikiri --game 'C:\Work\unpacked-ks' --out 'C:\Work\kag-work'
```

示例是带 UTF-16LE BOM 的 KS，证明中文改动仍保留原编码/BOM。实际无 BOM 文件不要猜编码，先确定再用 `--encoding cp932` 等参数。无法表示中文的编码会在 build 失败，不悄悄替换为问号；需要确认运行器可接受的新编码后做专属转换。

先用对应游戏版本的可信工具恢复 XP3；本包只认归档线索，不声称解密任意 XP3。显示文本子集与 Tyrano 指南相同，但 KAG 宏、TJS、表达式和内嵌 HTML 要单独确认。`#名字` 是部分作品习惯，不是所有 KAG 必然使用的标准。

保留跳转标签、资源 storage、macro 参数名与脚本符号。构建只产出原相对路径 KS 集合。具体松散文件/补丁包优先级在测试副本实测，不直接改原归档。原版乱码和中文缺字要区分编码与字体问题。
