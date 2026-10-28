# 图片文字处理

`prepareImages()` 在统一任务池的一项任务内顺序处理 UI 图片，通过用户选择的视觉模型识别
完整文字块。识别结果成为 `image_text` 单元，后续使用普通翻译、校对和文字工作包流程。
`applyImageText()` 在游戏组装副本中应用完成的译文。

```js
const result = await prepareImages({ gameDir, inventory, connection, signal, offset: 0, limit: 40 });
const applied = await applyImageText({ outputDir, binding: result.binding, translations, fontPath });
```

`connection` 与其他模型模块一致：`baseUrl`、`model`、`apiKey`。识别请求只提交图片与 OCR
任务卡，记录只保留相对路径、源图 SHA-256、像素矩形与文字。API 密钥和图片数据不进入绑定。
调用者保存 `binding.files` 与单元，在 `nextOffset` 接续下一批；每批最多100图，默认40图。

## 处理范围

- 按 UI、System、Buttons、Title 目录和菜单、帮助等文件名筛选 PNG/JPEG；角色、CG、地图等
  目录保留原资源，`binding.scope` 记录扫描范围与排除文件。
- 每图最多8百万像素、12 MiB，识别最多两次尝试，每次90秒；识别失败记录问题并继续。
  调用方取消信号会向上抛出，使项目保留恢复位置。
- OCR 矩形必须位于原画布内，文字块保持完整，重叠或格式错误结果整体重试。
- 重绘当前支持具有平整背景、单色字形的 PNG 标签、按钮和说明。文字使用显式 TTF/OTF
  `fontfile`，自动换行与适配区域；过密、复杂背景和 JPEG 重绘保留原区域并记录问题。
- 回写校验源图 SHA-256，输出尺寸保持不变。仅替换通过检查的文字矩形；其余解码像素和
  alpha 完整保留。源游戏始终只读。

图片开关默认关闭。开启代表执行上述范围的自动处理；复杂艺术字可继续通过外部图文流程处理。
当前范围不包含加密图像解密、任意背景修复和艺术字风格复刻。

## 验证

```powershell
node --test packages/images/*.test.mjs
```

测试使用中性标签图片、本地模拟视觉端点与实际 AI SDK；覆盖视觉输入、整块提取、有限重试、
取消、批次续接、相对路径、基线变化、PNG区域外像素、透明画布、排版密度和JPEG保留。
没有调用付费服务。

依赖：`sharp@0.35.5`，随发行携带其本机原生运行依赖；无需系统字体安装。
主程序模块采用 GPL-3.0-or-later，Sharp 及各原生组件保留上游许可证。

官方接口参考：[Sharp文字渲染](https://sharp.pixelplumbing.com/api-constructor/#new)、
[Sharp合成](https://sharp.pixelplumbing.com/api-composite/)、
[AI SDK多模态消息](https://ai-sdk.dev/docs/foundations/prompts)。
