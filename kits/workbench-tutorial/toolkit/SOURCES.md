# 格式与路线来源

查阅日期：2026-10-11。下列是实施依据与接力入口，不是对第三方工具所有版本的兼容保证。外部工具不随包附带，不自动下载或运行。

## 第一方引擎/格式文档

- [Ruby Marshal 格式](https://ruby-doc.org/3.2/marshal_rdoc.html)：对象、字符串和链接；本包仅解析数据，不调用 Ruby 恢复钩子。
- RPG Maker MV/MZ/Ace：标准字段与事件代码结合本地原版运行文件和已有项目工作台验证；不随公共包附带商业运行文件。
- [Ren'Py 翻译](https://www.renpy.org/doc/html/translation.html)、[Ren'Py CLI](https://www.renpy.org/doc/html/cli.html)、[官方 RPA loader](https://github.com/renpy/renpy/blob/master/renpy/loader.py)：原生模板、版本对应 SDK、RPA 索引和前缀。
- [Tyrano 官方网站](https://tyrano.jp/)、[TyranoScript 官方代码](https://github.com/ShikemokuMK/tyranoscript)：KS 行处理、引擎与吉里吉里不同；不复制整套运行器。
- [Twine2 HTML 规范](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md)、[Twee3 规范](https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md)：passage 元数据与 body；Story Format 需单独适配。
- [WOLF RPG Editor 官方页面](https://silversecond.com/WolfRPGEditor/)：引擎入口；实际 JSON 显示命令还结合本地原生导出数据验证。
- [Godot 国际化](https://docs.godotengine.org/en/stable/tutorials/i18n/internationalizing_games.html)：CSV/PO 交换数据仍需原生资源导入。
- [Unreal 本地化概览](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-overview-for-unreal-engine)：本地化目标与原生编译资源分开。
- Pixel Game Maker MV：按此前本地 project.json/info.json/textList 资源验证；不捆绑商业项目资源，具体格式仍按项目版本确认。

## 外部工具项目本身的文档

- [RGSS3 解包参考](https://github.com/TheRainbowPhoenix/rgss3a-unpack/blob/main/dec.py)：本包独立实现标准格式读取与流式解码，不复制其代码。
- [UnityPy](https://github.com/K0lb3/UnityPy)、[UABEA](https://github.com/nesrak1/UABEA)：可选资源清点与具体原生资产编辑；TextAsset 不一定是显示文本。
- [WolfTL](https://github.com/Sinflower/WolfTL)、[wolftrans](https://github.com/elizagamedev/wolftrans)、[rewolf-trans](https://github.com/KCFindstr/rewolf-trans)：不同导出/导入和编码路线不能混用。部分工具版本会清空输出目录。
- [GDRETools](https://github.com/GDRETools/gdsdecomp)：Godot PCK/资源恢复的外部入口。
- [UnrealLocres](https://github.com/akintos/UnrealLocres)：locres 转换外部入口，不假设其导出直接是 PO。
- [EasyRPG liblcf](https://github.com/EasyRPG/liblcf)、[rpgrt](https://github.com/johannschopplich/rpgrt)：LCF 外部处理路线。
- [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool)：GameMaker 原生数据外部处理路线。
- [ONScripter](https://github.com/ogapee/onscripter)：NScripter 派生运行器与语法参考。

## 调研线索，不作为份额统计

- [moxie](https://github.com/Milisource/moxie)、[wLib](https://github.com/kirin-3/wLib)：F95 相关开源管理工具的引擎分类。
- F95Zone 与 DLsite 的实际页面访问限制见 `RESEARCH.md`；未完成站内抽样，不捏造占比。

原包许可证覆盖本包自身代码；外部工具、字体、商业引擎与游戏资源各自遵循其许可证。本包未打包第三方可执行文件、字体或游戏。
