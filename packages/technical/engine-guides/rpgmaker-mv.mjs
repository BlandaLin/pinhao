export default () => [
  { id: "rpgmaker-mv", title: "RPG Maker MV 技术操作手册", text: `## 识别与载体

MV 使用 JavaScript，常见入口是 \`index.html\`、\`js/rpg_core.js\` 与 \`data/System.json\`；发布目录也可能把游戏放在 \`www\` 下。先用 \`inspect_context\` 和已登记的 \`native_probe\` 核对实际根目录、版本与已有工作台，不凭 EXE 名称判断。只有打包入口时，调查清单和原生工具的实际展开结果，不整款复制后再找文字。

主要正文在 \`data/Map*.json\` 地图事件、\`CommonEvents.json\` 公共事件、\`Troops.json\` 战斗事件，以及人物、物品、技能等数据库和 \`System.json\` 用语。消息通常由 101 后的连续 401 行组成；滚动文字为 105/405。保留完整消息、选择分支和稳定定位，不把换行拆成互不相关的句子。地图 \`displayName\` 与编辑器名称、角色显示名与图片文件名要分开。

## 先复用原生能力

已有工作台先用 \`inspect_units\` 或登记的 \`native_inspect\` 核对，不再编写第二套标准 JSON 提取器。可信原生工具经 \`run_tool\` 调用，名称和参数照 \`inspect_context.tools.trusted\`：\`native_probe\`、\`native_extract\`、\`native_roundtrip\` 无参数；\`native_inspect\` 按文件、偏移和返回游标分页。\`native_accept\` 属整项目协调接入，资源任务提交自己的定位或配方，不越过协调器认领全项目完成。

## 调查剩余显示文字

从 \`inspect_coverage\` 的真实缺口出发，读取 \`js/plugins.js\` 中启用的插件和实际参数，再搜索消费者：参数最终进入消息、窗口绘字还是文件加载、条件判断？插件源码的 \`@text\`、\`@desc\`、\`@help\` 通常服务制作界面，不是玩家正文；\`note\` 也可能是脚本规则，必须沿读取和显示链判断。

MV 的 356 插件命令通常把 \`parameters[0]\` 的命令串按插件约定解析；命令名不是正文，整串也不能翻。追踪 \`pluginCommand\` 覆写和真正显示的参数。355/655 脚本、独立语言文件及运行时拼接同理：找到完整句与变量边界，保留命令、键、表达式及资源引用。不能因为字符串包含自然语言就提交为显示字段。

Map 事件 \`name\` 不是 Actors 角色显示名；自开关名、按键名、图片文件名都保留。脚本或插件命令的整个 \`parameters\` 字符串不是一句话，未知 \`note\` 和插件参数须核对实际消费者。

## 施工与反馈

\`list_files\`、\`search_files\`、\`read_resource\` 的 source 根只读。脚本需要输入才用 \`copy_source_files\` 复制具体文件；运行和输出放本任务工作目录。可用 \`write_workspace_file\`、\`run_workspace\` 开发必要解析，持有 \`runId\` 后用 \`wait_run\`、\`read_run\` 读取同一进程，不反复启动。权限和工具选择不因本手册而缩减。

已有 display ID 的精确候选（包括 JSON）直接用 \`write_text_adapter\`；没有候选的 JSON 字段再用精确 pointer 编写适配器。普通 JS 字面量可用 \`write_literal_adapter\`，只传原文字句，不把 ID、哈希或外层源码引号交错使用。按 \`selections[i]\`、参数字段、来源不符等真实错误修正对应项；旧证据失效时重读当前来源，不猜新编号。

356 命令容器的缺口会列在 \`expressionCandidates\` 并带 \`embedded\`。查清消费者后，可用 \`write_embedded_text_adapter\` 的 \`selections:[{file,pointer,text,reason}]\` 保存参数内完整显示正文；\`text\` 是当前原文，\`reason\` 说明真正显示的依据。外侧字节保留不代表参数含义必然不变：单参数正文不能随意加入空格；只有实际消费者按 join 读取正文时才允许改变词数。宿主核对当前解析器、启用插件与有限消费者映射后晚绑定表示契约，实际译文每次构建、合并仍重验。缺少依据时保留候选，按明确缺口追踪独立正文或真实编码协议，不删空格、加引号或反复重译来凑通过。可先提交已查明的一批；每批仍须 \`validate_adapter\` 和 \`submit_recipe\`，非该容器继续使用实际格式配方。

## 验收与边界

先原样往返，再以少量中文做 \`validate_adapter\`、改文重提及差异核对，通过后 \`submit_recipe\`。保护控制符、伤害公式、按键、资源 ID 和事件逻辑。只加一条定位不等于整文件覆盖；有允许条件且完整读取的资源才可用 \`record_coverage_decisions\` 说明非显示或已有定位覆盖，不能写空适配器结案。

分别报告标准字段、插件和图片等未处理来源。实机检查标题、插件窗口、对白、选择分支、字体与保存读档；原版和原存档不改。原生提取成功不保证所有插件兼容，结构通过也不等于运行验证。` },
];
