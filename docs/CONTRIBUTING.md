# 反馈与贡献 / Contributing

[中文](#中文) · [English](#english)

## 中文

### 反馈问题

在 [Issues](https://github.com/BlandaLin/pinhao/issues/new/choose) 选择“问题反馈”或“引擎兼容”，填写：

- 软件版本、Windows 版本、游戏名称及版本；知道引擎时一并注明。
- 从哪一步开始出错，预期得到什么，实际发生了什么。
- 相关错误提示、截图或日志片段。漏字请指出具体对白或菜单位置。

发出前遮盖密钥、账号和个人目录。不要公开上传完整游戏、私人存档、API 配置或整个工程。能公开分享的小样可以附上；没有小样时，说明文件结构和出错位置即可。

### 提交代码

先读[桌面开发说明](../apps/desktop/README.md)和[实现矩阵](product/IMPLEMENTATION.md)。修复附上复现步骤与回归测试；新引擎适配说明提取、原样回写、改文回写、独立成品和游戏内检查各自的结果。

改动须保留原文件、存档、已接受译文、控制符和稳定 ID；新增依赖须保留来源与许可证。

## English

### Report a Problem

Choose **Bug Report** or **Engine Compatibility** in [Issues](https://github.com/BlandaLin/pinhao/issues/new/choose), and include:

- Pinhao and Windows versions, the game title and version, and the engine if known.
- The steps leading to the problem, what you expected, and what happened.
- The error message, screenshots, or relevant log excerpts. For missing text, identify the dialogue or menu.

Redact keys, account details, and personal paths. Keep full games, private saves, API settings, and complete projects out of public reports. Attach a small sample you have permission to share, or describe the file structure and affected location.

### Contribute Code

Read the [desktop development guide](../apps/desktop/README.md) and [implementation matrix](product/IMPLEMENTATION.md). Include reproduction steps and a regression test with a fix. For a new adapter, record extraction, unchanged roundtrip, changed-text writeback, standalone assembly, and in-game checks separately.

Preserve original files, saves, accepted translations, control sequences, and stable IDs. Retain the source and license notices for added dependencies.

## 开发检查 / Development Checks

```powershell
npm ci
npm run build
npm run check:public
npm run test:ci
npm run test:ui
```

完整原生测试需要先准备固定工具 / Prepare the pinned tools for native tests:

```powershell
npm run prepare:tools
npm test
npm run test:engines
```

GitHub 工作流执行基础检查。请在提交中列出已运行的检查及尚未完成的检查。
The GitHub workflow runs the basic checks. List the checks you ran and any that remain outstanding in your contribution.

## 许可 / License

主程序采用 GPL-3.0-or-later，`packages/exchange` 采用 MIT；第三方组件沿用各自许可证。官方软件免费。
The application uses GPL-3.0-or-later; `packages/exchange` uses MIT. Third-party components retain their licenses. Official downloads are free.
