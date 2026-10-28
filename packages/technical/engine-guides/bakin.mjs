export default () => [
  { id: "bakin", title: "RPG Developer Bakin 技术适配操作手册", text: `## 识别发布布局和匹配 codec

先查看 \`inspect_context\`、\`native_probe\`。现行支持入口包括根下 data.rbpack、data/data.rbpack，或 data/common.dll 与 .rbr 的松散资源布局。Bakin 与 SMILE GAME BUILDER 共享部分 catalog 思路，但资源布局、记录版本和依赖必须按当前发布物核实，不能拿 .sgr、sgbpack 或另一游戏的 DLL 替换。它也不是 Unity 工程，不向它调用 Unity 类型树和资产组审阅流程。

原生依赖发布游戏自己的 common.dll 及匹配依赖，辅助程序以该程序集旁的目录加载 catalog，避免误递归用户工作树。核对 PE 位数、资源头和版本证据。现有解包结果与辅助编译缓存继续复用，不为了每一项文字重新展开 rbpack 或生成完整副本。

## 原生能处理与不能代表什么

原生将支持的 catalog 记录解码为虚拟 native-text JSON，保留原 .rbr、对象 GUID、字段路径与命令位置。已支持显示命令及现行规则认可的名称、说明、菜单等字段可进入工作台；公式、路径、GUID、变量与已知编辑器身份保护不变。每条仍需按完整语义保存，不能从名字像 text 就推断整个对象都可翻。

无改动重序列化检查是记录可写的前提。不支持的原记录会保留原件并形成 native_record_roundtrip_failed 等待办；某些 GameSettings 字段被列出，不代表该记录能够安全写回。普通字段扫描、原生记录通过和完整游戏覆盖是三件事，数量增加不是替代证明。

## 如何调查剩余资源

用 \`native_inspect\`、\`inspect_units\` 先核对已有定位，再读 \`inspect_coverage\` 的具体资源和失败细节。对 native-text 虚拟文件要沿 context 的真实载体定位，不反复在原游戏目录寻找同名 JSON。新记录可用现有受管脚本调查 managed 方法、读写契约与原始记录框架，优先复用匹配 codec；必要时 \`write_adapter\` 实现可验证补充，不以手工抄出文本替代原生回包。

对 shader、布局、资源说明等自然语言，追踪实际消费者：玩家运行界面、编辑器 inspector、预览或配置各自分开。不能用文件扩展名或所在目录统一排除，也不能把编辑控件标签当剧情。用途不明时继续读取，不因一次空查询就断言无文字。

## 工具选择与错误修复

\`inspect_coverage\` 的 kind 只用当前合同允许的资源 kind 或 \`resource-file\`；未知值会明确拒绝，不自创 records/dynamicCandidates 作为 kind。全局下一页按工具 nextPage 继续；\`read_evidence\` 只补读那一次结果快照，不会自动跨到新的全局资源页。

完整读过且查明非玩家显示的裸资源，可经 \`record_coverage_decisions\` 提交 id、evidenceHash、disposition、reason，不必写空适配器。参数必须用准确字段；evidenceId 不是 evidenceHash。错误会指出 decisions[i] 缺项、未知 ID 或陈旧证据，应按实际反馈改正。读过来源并不自动证明非显示，决定也不能吞掉未解决的精确候选、未知簇或原生失败。

## 原生回写与真实结案

无改动记录不能原样还原时，先调查具体失败的记录读写机制，不能放宽字节/结构校验。通过的记录先做少量中文改文，再用同 codec 读回原 .rbr 与记录身份，核对未改数据和归档成员。补充 JSON 的局部验证通过不等于 .rbr 已变化，单条显示定位更不表示整份资源完整。

明确候选可用 \`write_text_adapter\`，新配方经 \`validate_adapter\` 与 \`submit_recipe\`；按返回 remainingCoverage 继续。范围不足用 \`request_scope_change\`，原版只读，需写的输入才复制，独立任务并发不串行化。非显示分类只减少无效待办，不计作新增译文；保留尚未解码、不能回写、动态、图片及实机未验证项，不能以待办归零代替成品完整度。` },
];
