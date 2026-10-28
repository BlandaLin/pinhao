# 反馈与贡献 / Contributing

欢迎提供使用反馈、引擎适配、测试样例、文字工作包互通和代码改进。
Contributions to compatibility, tests, text-package interoperability, and usability are welcome.

## 问题反馈

通过 GitHub Issues 说明软件版本、Windows 版本、游戏及引擎版本、操作步骤、预期与实际结果。
附相关截图或脱敏日志。引擎兼容问题优先提供可公开再分发的中性最小样例。

API 密钥、访问令牌、个人账号和目录请先遮盖；完整游戏、译文和私人存档留在各自授权范围内。

In an issue, include the software/OS/engine versions, reproduction steps, and expected/actual results.
Attach sanitized screenshots or relevant log excerpts. Neutral, redistributable fixtures are preferred.
Keep credentials and personal data private, and respect the rights attached to game assets and translations.

## 代码贡献

先阅读 [桌面开发说明](../apps/desktop/README.md) 与 [实现进度](product/IMPLEMENTATION.md)。
修复尽量配套最小复现测试；新适配记录原生往返、修改回写、独立输出和实际运行的验证范围。
原有源文件、存档、已接受译文、保护标记和稳定 ID 保持各自的数据合同。

Read the [desktop guide](../apps/desktop/README.md) and [implementation matrix](product/IMPLEMENTATION.md).
Add a regression test for a fix. For an adapter, record native roundtrip, changed writeback,
standalone assembly, and runtime verification separately.

基础检查 / Basic checks:

```powershell
npm ci
npm run build
npm run check:public
npm run test:ci
npm run test:ui
```

完整原生验证先准备固定资源 / Full native verification requires the pinned tools:

```powershell
npm run prepare:tools
npm test
npm run test:engines
```

GitHub 工作流执行基础检查。完整原生测试的运行环境与具体游戏实测结果随各次改动记录。
The GitHub workflow runs the basic checks; native/runtime and per-game validation are recorded with each change.

## 许可

提交代码时保留第三方版权和来源。主程序按 GPL-3.0-or-later，`packages/exchange` 按 MIT；
既有工具与资源沿用各自许可证。官方软件免费提供。

Preserve third-party notices and attribution. The desktop app uses GPL-3.0-or-later,
`packages/exchange` uses MIT, and existing components retain their licenses. Official builds are free.
