export default () => [
  { id: "sgb", title: "SMILE GAME BUILDER 技术适配操作手册", text: `## 区分 SGB、Bakin 与实际资源

先读 \`inspect_context\`、\`native_probe\`。SGB 常见载体为 data.sgbpack，或带 common.dll、sgb_rpgplayer.exe 和 .sgr 的松散发布目录。Bakin 的 .rbpack/.rbr 属另一条原生布局，不能只因同有 common.dll 就当同一版本。两者都不能按 Unity 的 sharedassets、MonoBehaviour 或 TypeTree 导出流程处理。

当前 SGB 路线读取其归档、.sgr 目录和发布游戏自带的 catalog codec。需要一套匹配的 common.dll 与依赖，并按实际 managed PE 位数准备现有辅助程序。不要从另一款游戏抄 DLL，不上传厂商程序集，不反复在全工程根递归搜索“也许能用”的同名库。

## 已有原生链能做什么

原生读取归档或松散资源，建立 catalog 文字视图，保留原始记录身份和文件关系。事件中的已支持 MESSAGE、CHOICES、DIALOGUE 等显示命令，以及被现行字段规则识别的名称、说明、菜单文字等形成稳定定位。每条具有 resource、item、field、command 等上下文；虚拟 native-text JSON 是编辑视图，不是游戏真正加载的 .sgr。

记录在进入可写范围前必须经过原样序列化检查。原生会保护已识别的公式、资源路径、GUID、变量和编辑器身份；字段名像 text/name 仍不是所有自定义类可翻的通行证。\`native_inspect\`/\`inspect_units\` 核对已有单元，先复用成功的原生工作台，勿重复把相同说明再作为“新增剧情”。

## 剩余如何实查

查看 \`inspect_coverage\` 的原生失败、未知资源和精确候选，再沿原生记录类型、命令参数与运行消费者追用途。可用 \`read_resource\`、\`search_files\` 阅读实际存在的视图、脚本和工具输出；不要把虚拟定位当 source 物理路径反复读取。目录层级、GUID、命令顺序和字段位置都要保留，不用文本排序或译文行号回拼。

需要研究新记录或插件时，通用脚本能力继续开放。通过 \`write_workspace_file\`、\`run_workspace\` 调查匹配 codec 或二进制记录，确有新可回写能力再用 \`write_adapter\` 纳入。原版只读，必要输入按需复制到 workDir；复用已解包结果和编译缓存，独立资源可并发，同一 .sgr 的修改通过现有范围机制合并，不让每个 Agent 另做一款游戏副本。

## 错误反馈与假线索

\`NATIVE_CODEC_MISSING\` 要先检查是否选择完整发布目录及唯一匹配 codec；\`Native catalog serialization failed\` 要看真实退出信息、工作目录和依赖。辅助程序需要正确的资源旁工作目录，不能把整个用户工程当 catalog 搜索根。无改动序列化不同或 unsupportedRecords 是未解决记录，不得忽略失败后将整资源标成完成。

名字、说明字段可能属于编辑器标签或资源身份，需结合实际用途，不可只凭自然语言字符。已有全部常见显示命令位置吻合，也不证明插件、自定义变量、图片文字和动态拼接完全覆盖。没有技术待办时不人为生成 API 调用；只有一个中文字段可回读也不是整游戏已经验证。

## 回写与结案

先做原样往返，再选少量完整对白、选项或真实显示字段作中文小样。回写必须经同一 codec 将虚拟文字位置重建为原生 .sgr，重新读回目标字段，并检查非目标记录、资源身份及未改载体。最终归档成员与布局也要核对；虚拟 JSON 中有中文不是成品证据。

生成配方经过 \`validate_adapter\` 与 \`submit_recipe\`；原生提取/接入用当前工具返回的主机结果与验证编号。明确说明已处理命令家族、仍失败记录和未查来源；资源用途决定使用当前 ID/hash、完整来源读取和理由，不用少数定位吞掉全文件。结构、中文读回、成品组装及真实游玩分别记录，\`runtimeVerified\` 未实际验证不得填真。` },
];
