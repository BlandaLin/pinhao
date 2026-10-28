# 技术工具

KickStart 0.2 的主实现位于 `kits/workbench-tutorial/toolkit`。
它与原独立工具包的34个文件逐字一致，不再复制第二套需要同步维护的源码。

在项目根目录使用便捷入口：

```powershell
python -B tools/kickstart.py catalog
python -B tools/kickstart.py probe --game 'C:\Games\Example'
python -B tools/kickstart.py plan --game 'C:\Games\Example' --out 'C:\Work\example-plan.json'
```

完整支持矩阵、示例和验收要求见
[主实现 README](../kits/workbench-tutorial/toolkit/README.md)。
便捷入口只转发参数，不改引擎支持范围或校验规则。
