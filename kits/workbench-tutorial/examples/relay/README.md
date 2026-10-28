# 同一场景：初翻 → 校对 → 润色 → 技术回写

这是自造中性 RPG Maker 数据的完整接力，含数据库、消息窗和短选项，共 18 单元。各阶段参考回包是预先编写的教学答案，不是程序调用 AI 完成翻译，也不是可玩的游戏。

## 文件怎么读

| 目录或文件 | 用途 |
| --- | --- |
| `lesson/work` | 同一只读技术基线与映射，全流程不变 |
| `01-translation/input` | 初翻任务卡、未译输入、原文上下文、术语表 |
| `01-translation/reference/return-text.txt` | 初翻参考回包，故意留一处错误人称和一处生硬对话 |
| `02-proofreading/input` | 从初翻已接回的完整译文生成；任务卡自动切到校对 |
| `02-proofreading/reference/return-text.txt` | 修正人称，保留其余初翻成果 |
| `03-polishing/input` | 从校对已接回的完整译文生成；任务卡自动切到润色 |
| `03-polishing/reference/return-text.txt` | 改善对话口吻，保留人称修正及其余成果；也是修复回包 |
| 每阶段 `accepted/editable` | 回包转换后完整有效工作表，不只是本轮修改的几条 |
| 每阶段 `changes.json` | 对照上一阶段的译文/备注差异，带稳定 ID 和上下文 |
| `03-polishing/recovery` | 缺少 LINE 占位符的坏回包及实际拒绝记录 |
| `final/built`、`final/notes.json`、`final/result.json` | 最终原生数据、独立备注、技术校验结果 |
| `relay.json` | 输入输出指纹、阶段统计与验证范围 |

## 两处文字变化

初翻把角色资料写成“她是一名旅人”；已批准角色资料明确为男性。该句结构合法，程序不会因为人称错而拒绝。校对参考改为“一名旅人”，用自然省略移除错误代词。这是教学作者根据资料确认的语义修正，不是自动检测结果。

前台对话初翻为“你好，动态姓名。到这边来。”。校对阶段没有为显示工作量改写；润色阶段调整为“您好，动态姓名。请这边走。”，保留原意、动态姓名与分行控制。没有改动的选项和词条仍保留完整初翻译文。

## 故障与修复

坏回包仅删去对话中的 `{{LINE0001}}`。技术侧 import 拒绝它，不生成成功构建，也不回写基线。`expected-failure.json` 记录实际异常与 ID。

修复参考恢复同一 ID 上的 LINE 占位符，保留当前全部译文与其他控制符；用新的输出目录重新 import，然后 build/verify。修的是回包，不是基线或校验器。修复文件就是 `03-polishing/reference/return-text.txt`，可与坏文件直接比较。

具体可复制命令见教程根目录的 `docs/08-完整接力与修复.md`。随包示范只读；要自己练习，可在教程根目录运行：

```powershell
python lesson.py prepare-relay --out '../my-relay-practice'
```

这会生成另一套完整参考。真正让文字 AI 练习时，每次只交当前阶段的 `input` 四文件，不交参考答案；收回完整 `return-text.txt` 后由技术侧接回，再从该输出导出下一阶段。字体、实机和存档验收不包含在这套数据练习里。
