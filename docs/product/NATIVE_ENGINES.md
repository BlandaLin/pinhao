# 原生引擎路线

所有适配沿用同一条制作链：选择游戏、完整提取、无改动回写、文字工作台、翻译与校对、
保护标记校验、原生重建、独立成品。模型配置和文字交换格式保持统一。

## 成品资源

| 引擎 | 资源输入与输出 |
| --- | --- |
| TyranoScript | KS 场景、显示名、按钮；标准 Electron ASAR 解包后生成独立应用目录 |
| KiriKiri / KAG | 标准 XP3 的 raw/zlib 分段、补丁包、EXE 内嵌归档；保留运行器并重建原容器；修改的 KS 使用带 BOM 的 Unicode |
| Ren'Py | RPY、RPYC、RPA2/3；静态恢复编译脚本，合并引擎规定的补丁优先序，输出可由原运行器加载的源脚本；保留图片和音频 |
| Godot | PCK、EXE 内嵌 PCK、编译场景及 GDScript；恢复可写资源，原路径重打包；动态 `tr()` 使用原键与本地翻译目录 |
| Pixel Game Maker MV | 根目录、`data/`、`Resources/data/` 的项目资源；加密项目从 `info.json` 恢复资源密钥，回写后恢复原加密格式 |
| SMILE GAME BUILDER | SGBPACK 与 SGR；使用游戏随带的原生 Catalog 编解码器，按显示字段和事件命令写回 |
| RPG Developer Bakin | RBPACK 与 RBR；保留未知块、目录顺序及地图几何，原生对象按字段重建后重新封包 |
| Unity | SerializedFile／UnityFS；按容器、成员、path ID 与显示字段定位，TextAsset／TextMesh／已确认 UI、TMP、StringTable 写回原生资源 |

角色名、资源 ID、跳转目标、表达式和逻辑字段分别处理。Ren'Py 的 `_()`／`_p()`、
Godot 的翻译键、Yukar 的格式参数进入各自的显示绑定与控制符规则。
批次以完整显示单元和上下文组织，既有专名词表、校对接力和外部回包流程继续适用。

## 字体与图片

Tyrano 使用本地字体 CSS；Ren'Py 更新默认及 GUI 样式；KAG3 使用匹配位数的私有字体插件；
Godot 使用随资源包加载的本地化启动模块；PGMM 保留字体 ID 和字号，更新各语言的 TTF 配置，
位图字体切换到同字号 TTF；SGB/Bakin 替换运行器实际读取的字体资源。
Unity 替换内嵌动态 Font 的字体数据与字体名；静态字库、外置字体和 TMP SDF 图集进入专用字体适配清单。

可选图片处理在文字阶段建立识别绑定。原生归档引擎在封包前接收经过摘要校验的 PNG 结果，
图片随 XP3、PCK、SGBPACK、RBPACK 或 PGMM 资源一起输出。默认保留图片原样，
开启后沿用 UI 优先范围、平整背景重绘和区域排版检查。

## 适配边界

| 变体 | 处理方式 |
| --- | --- |
| XP3 厂商自定义加密过滤器 | 提取时校验资源摘要，登记所需过滤器配方 |
| KAG 自定义加载器 / x64 字体插件 | 采用该游戏的加载顺序和匹配位数插件；默认工具携带官方 x86 addFont |
| Ren'Py 自定义语法、混淆容器、动态归档顺序 | 扩展静态反编译和加载器配方；保留未知 AST 的明确错误 |
| Godot C# / GDExtension 内显示字面量 | 场景与翻译目录继续处理，托管和原生扩展中的字面量单独适配 |
| SGB/Bakin 原生对象版本 | 提取时对实际可写对象做无改动原生序列化核对，保留其他原始块 |
| SGB Unity 导出 | 使用独立的 Unity 资源适配配方；当前 SGB 路线面向原生 Windows／.NET 运行器 |
| Godot 仅源码工程 | 配合匹配版本的运行器生成独立成品；发行版游戏直接保留其随带运行器 |
| Unity 自定义 MonoBehaviour、指令脚本与运行期生成文字 | 根据类身份和显示数据 schema 建立字段绑定；脚本和逻辑字段保留原样 |
| Unity 加密包、缺失 typetree、静态字体及 TMP SDF | 项目登记资源与字体适配项，使用原始资源保留未处理内容 |

项目的结构检查、原生回写和游戏场景验收分别记录。运行器加载中性场景的验收证明对应格式的
成品链路；具体游戏的剧情分支、存读档和自定义插件由项目检查记录承接。

## 依赖与重现

```powershell
npm run prepare:tools
npm test
npm run test:engines
npm run check:public
```

依赖固定版本与摘要，随产品提供：[GDRETools](https://github.com/GDRETools/gdsdecomp)、
[unrpyc](https://github.com/CensoredUsername/unrpyc)、
[PGMMV_Decrypter](https://github.com/wqhanginge/PGMMV_Decrypter)、
[KiriKiri SDK](https://krkrz.github.io/)。各自许可保留在 `adapters/vendor`、
`adapters/python/vendor` 和发行依赖目录中。SGB/Bakin 使用所选游戏随带的原生编解码组件。
Unity 使用 [UnityPy 1.23.0](https://github.com/K0lb3/UnityPy) 与固定 Windows CPython 3.12 wheel；
11 个依赖逐一校验 SHA-256，各自许可随 `.dist-info` 保留。文字路线保留所需开源依赖，
准备阶段剔除上游包内的 FMOD 音频运行库。

格式实现参考官方公开源码与文档：[KiriKiri XP3](https://github.com/krkrz/krkrz/blob/master/base/XP3Archive.cpp)、
[Ren'Py](https://github.com/renpy/renpy)、[Godot](https://github.com/godotengine/godot)、
[PGMMV](https://github.com/GGGweb-adm/PGMMV)。

可选实机测试使用另行下载的官方 SDK／示例目录和中性文本，游戏、SDK、缓存及测试输出位于
本机私有目录。自动测试发现可用运行器后执行相应验收；源码分享保留测试程序和许可证。
