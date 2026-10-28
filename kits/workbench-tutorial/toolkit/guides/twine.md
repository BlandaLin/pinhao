# Twine / Twee / SugarCube

层级：plain/SugarCube Twee 与 Twine2 SugarCube HTML 正文子集。Harlowe 和其他 Story Format 没有通用兼容器。

```powershell
python demo.py --profile twine-html --out 'C:\Work\demo-twine'
python demo.py --profile twee --out 'C:\Work\demo-twee'
python kickstart.py extract --engine twine-html --game 'C:\Games\Copy' --out 'C:\Work\twine-work'
```

HTML 只改 `tw-storydata` 内正文 passage，保留播放器、script、stylesheet、pid/name/tags 和转义。Twee 只改 prose passage，不改 StoryData、StoryTitle 与代码 passage。当前 format 明确为 Harlowe 或遇到其宏时失败，不把宏当自然语言改写。

`[[显示文字|目标]]` 整体、`<<macro>>`、`<<script>>`、HTML 标签和 `$变量` 被保护。**链接显示文字与宏参数里的文字也暂时保留原文**，列入 review 待接手 AI 扩展，而不是全部翻译的假象。需要拆分时必须只改显示槽位、不改 target/表达式，并补自己的回归测试。

Harlowe 的命名钩子/宏和 SugarCube 的 set/if/link 行为不同；不要通过删标签来让提取器接受。浏览器实测 passage 跳转、历史、存档、变量和导出文件位置。未带 format 标识的普通 HTML 仅按该保守子集处理，先确认实际运行器。

来源：[Twine2 HTML 规范](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md)、[Twee3 规范](https://github.com/iftechfoundation/twine-specs/blob/master/twee-3-specification.md)。
