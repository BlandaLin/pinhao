export default () => [
  { id: "tyrano", title: "TyranoScript 技术适配操作手册", text: `## 找到真正的应用与脚本

先读 \`inspect_context\`、\`native_probe\`。常见证据是 tyrano/ 与 data/scenario/ 的 .ks，也可能位于 www/、resources/app、app.asar 或 NW.js 的 EXE 内嵌 ZIP。应依据归档索引和应用清单确认根目录，不把任意 ZIP、Electron 或 NW.js 应用都当 Tyrano。它使用 .ks，但不是 KiriKiri/KAG；不要调用 XP3 编码器或照搬 KAG 字符编码与字体插件。

原生路线能处理已识别的松散布局、ASAR 和受支持的 PE+ZIP 包装。已有工作台和 member 视图先复用；不要为查一页剧情把视频、图片和音频整套复制多次。某种包装已识别但缺合适解码能力时，保留实际错误和输入证据，再研究对应工具，不以“识别成功”冒充提取成功。

## 原生提取与边界

普通叙述按完整段落提取，保留 label、说话人线索、原文跨度及控制符。整行标签只对明确 text、jname、placeholder、title 等字面属性建定位；变量表达式、内嵌 JavaScript/HTML、定制插件仍需追用途。人物引用标记与真正显示名分开，不翻 storage、target、name 等逻辑身份来凑数量。

Tyrano 逃逸行的第一个 \`_\` 是语法前缀，后面的内容可以是真正正文；写回只改其后的显示跨度，不能整行丢弃，也不能去掉正文里剩余下划线。该行为已按实际发货解析器验证，但仍应核对目标游戏的 parser 及版本，不把它扩展为所有 .ks 的通用规则。纯控制标签和空白不属于文字，标点与正常数字仍保留。

## 剩余资源如何调查

先 \`inspect_units\` 或 \`native_inspect\` 查当前定位，再从 \`inspect_coverage\` 找候选。用 \`list_files\`、\`search_files\`、\`read_resource\` 查场景、插件注册、脚本调用及负责标签的实现，确定实际加载和显示路径。发现宏或插件字符串时，应说明哪段运行逻辑把它用于画面；builder 主题、编辑器预览和项目说明可能根本不进玩家运行时。

明确候选可沿 \`write_text_adapter\` 接入；自定义 HTML、JS 或新载体可在 workDir 编写、运行脚本调查并交付 \`write_adapter\`。脚本读取原资源，必要修改输入才复制；使用 \`copy_source_files\` 补齐关联依赖，勿猜 source 是 cwd 下的物理文件夹。保留通用工具和网络研究能力，但不把游戏文件上传外部服务。

## 根据真实错误改路线

\`ADAPTER_TEXT_READBACK\` 表示写回后读出的目标文字未吻合；应查看失败差异、实际标签 parser、引号转义和跨度，不反复提交相同主题 JSON 或修改无关配置。工具参数不接受时先核对 \`inspect_context\` 的当前合同，不创造别名，也不把 evidenceId 当 evidenceHash。

标题或主题能改不代表漏提剧情已修；把已提取字段重新写入只会制造假收益。变量拼出的动态显示必须保留完整语义来源和准确消费位置，不直接翻键或程序片段。若同一容器多个成员需要共同写入，申请联合范围，避免并发任务互相覆盖整个包。

## 原生回写与覆盖结案

先无改动往返，再对一页完整正文及一个真正显示属性做短中文样例。对含 \`_\` 的行同时核对原文和中文经过目标 parser 的结果；检索输出文件里出现中文不是充分验证。ASAR、NW.js ZIP 继续走相应原生组装，比较成员集合与非目标成员，不能把松散目录和原 EXE 并列放置就宣称游戏会加载新文字。

\`validate_adapter\` 通过后 \`submit_recipe\`，查看 remainingCoverage；分类决定仍需当前 ID/hash、来源读取和用途理由。分别报告场景、插件、动态 HTML/JS、图片、字体和排版的范围，静态语法或归档读回不等于实机运行。未完成的候选留给下一轮，已验证成果和暂停记录继续复用。` },
];
