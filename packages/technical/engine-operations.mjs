import rpgmaker_mv from './engine-guides/rpgmaker-mv.mjs';
import rpgmaker_mz from './engine-guides/rpgmaker-mz.mjs';
import rpgmaker_xp from './engine-guides/rpgmaker-xp.mjs';
import rpgmaker_vx from './engine-guides/rpgmaker-vx.mjs';
import rpgmaker_vx_ace from './engine-guides/rpgmaker-vx-ace.mjs';
import rpgmaker_2000 from './engine-guides/rpgmaker-2000.mjs';
import rpgmaker_2003 from './engine-guides/rpgmaker-2003.mjs';
import wolf from './engine-guides/wolf.mjs';
import renpy from './engine-guides/renpy.mjs';
import kag from './engine-guides/kag.mjs';
import tyrano from './engine-guides/tyrano.mjs';
import unity from './engine-guides/unity.mjs';
import godot from './engine-guides/godot.mjs';
import pgmm from './engine-guides/pgmm.mjs';
import sgb from './engine-guides/sgb.mjs';
import bakin from './engine-guides/bakin.mjs';

const version = 'pinhao-engine-operations-17';
const manuals = new Map([
  ["rpgmaker-mv", "rpgmaker", ["MV","RPG Maker MV"], rpgmaker_mv],
  ["rpgmaker-mz", "rpgmaker", ["MZ","RPG Maker MZ"], rpgmaker_mz],
  ["rpgmaker-xp", "rgss", ["XP","RPG Maker XP"], rpgmaker_xp],
  ["rpgmaker-vx", "rgss", ["VX","RPG Maker VX"], rpgmaker_vx],
  ["rpgmaker-vx-ace", "rgss", ["VX Ace","RPG Maker VX Ace"], rpgmaker_vx_ace],
  ["rpgmaker-2000", "lcf", ["RPG Maker 2000","2000"], rpgmaker_2000],
  ["rpgmaker-2003", "lcf", ["RPG Maker 2003","2003"], rpgmaker_2003],
  ["wolf", "wolf", ["WOLF","WOLF RPG Editor"], wolf],
  ["renpy", "renpy", ["Ren'Py","Ren’Py"], renpy],
  ["kag", "kag", ["KiriKiri/KAG","KAG"], kag],
  ["tyrano", "tyrano", ["TyranoScript","Tyrano"], tyrano],
  ["unity", "unity", ["Unity"], unity],
  ["godot", "godot", ["Godot"], godot],
  ["pgmm", "pgmm", ["Pixel Game Maker MV","PGMM"], pgmm],
  ["sgb", "sgb", ["SMILE GAME BUILDER","SGB"], sgb],
  ["bakin", "bakin", ["RPG Developer Bakin","Bakin"], bakin],
].flatMap(([id, family, aliases, render]) => aliases.map(alias => [alias, { id, family, render }])));

/** Select one manual without narrowing the Agent's registered capabilities. */
export function engineOperations(engine = '', tools) {
  const registered = tools === undefined ? undefined : new Set(tools.map(item => typeof item === 'string' ? item : item.name));
  const has = name => registered === undefined || registered.has(name);
  const manual = manuals.get(engine);
  const ambiguousLcf = engine === 'RPG Maker 2000/2003';
  const sections = [{
  "id": "evidence",
  "title": "从当前证据选择下一步",
  "text": "inspect_context 列出当前引擎、分工、已有文字和可信工具；executionContext给出本任务sourceDir/workDir。受管脚本用PINHAO_SOURCE_DIR/PINHAO_WORK_DIR定位独立技术输入和工作输出，assignment.files相对于sourceDir，不猜cwd内存在source目录。list_files/read_resource/search_files 的 source 根只读查看完整游戏资源，未必已复制到脚本sourceDir；需要额外文件供脚本或配方使用时先调用copy_source_files。工具必须改写输入时，只把所需资源复制到workDir再执行，所有修改与重建输出留在workDir或指定outputDir，原版与存档保持原样。inspect_units 核对已有稳定定位；文件、脚本与工具输出提供事实。文字的 file/locator 可以是工作台虚拟回写定位（如__unity_text__），不保证是 source 中的物理文件；原生文字优先用 native_inspect 读取，实际载体以 context.carrier 等工具提供的路径为准，不反复用 read_resource 读取不存在的虚拟路径。证据编号 evidenceId 用 read_evidence 分页补读，不是资源内容的 evidenceHash。按实际缺口选择工具或编写适配器。"
}];
  sections[0].text += ' 本次仅装配当前引擎手册；指南是调查起点，不是固定流程或权限白名单。工具是否可用及参数以本任务实际目录为准，缺少工具时仍可研究、编写适配器或在项目授权后执行脚本，不伪造已安装能力。';
  sections[0].text += ' 操作速记：read_evidence.limit至多12、length至多2000，pointer用空串或以/开头的实际字段路径，不填裸字段名，不能套用文件清单的页长；search_files.limit至多100，必须显式content:false查路径或content:true查正文，缺省按字面量匹配，只有matchMode:regex才解释正则；relativePath可限定文件或目录，按nextCall或nextOffset续扫；list_files默认一层目录，recursive:true才递归。run_workspace省略cwd就是工作根，不填点号或绝对路径；子目录才填真实相对目录。脚本从PINHAO_SOURCE_DIR取输入、PINHAO_WORK_DIR存输出。';
  if (has('native_extract')) sections.push({
  "id": "native",
  "title": "复用现有原生能力",
  "text": "native_probe 查看当前识别与能力；native_extract 建立或复用原生工作台，native_inspect 分页查看文字及定位。native_roundtrip 验证无改动回写。协调任务通过 native_accept 接入已验证工作台，独立资源任务将本资源的字段决定或配方交回协调器。已有可靠提取定位继续复用。"
});
  if (manual) sections.push(...manual.render(has));
  else if (ambiguousLcf) sections.push({ id: 'lcf-unconfirmed', title: 'LCF版本尚未区分', text: `当前只识别为RPG Maker 2000/2003，不能声称已确定某一代。先复用LCF原生工作台与已登记编解码器，核对RPG_RT.ldb、.lmt、.lmu和运行器版本证据；lcfEngine只是当前codec配置，不单独证明游戏版本。2000与2003的事件与数据库解释不可凭名称互换，不为选择手册改写原资源，不把已接受文字清空重来。
两代共用的调查仍可继续：已有native_inspect与inspect_units核对数据库、地图/公共/战斗事件、系统用语的完整消息和选择定位。原生投影JSON位于工作台登记的额外来源，read_resource使用返回的sourceIndex；ENOENT先核对读取根，不反复导出或把投影JSON当原游戏文件。没有标准RGSS脚本槽，不生成Ruby脚本冒充运行时补丁。剩余图片式菜单、运行时组句和外部插件按真实消费者调查，可使用通用工具与自编适配器。
当前源代码页由明确配置或EasyRPG设置取得，缺省932；目标路径缺省936是转换策略，不证明原RPG_RT能显示中文。XML是UTF-8也不能据此把LCF原件整体改成UTF-8。严格编码失败、控制符或原生模式差异须保留日志，纠正具体来源与codec，不放宽校验反复烧请求。
先核对原样交付字节与原生语义重导出，再做少量真实目标字符改文并重新导出原LCF，检查控制符、分支及非目标字段；只改JSON投影不是原生回写成功。配方经验证接回，字体、实际运行器与保存读档另行实机记录，不能拿另一运行器可打开代替原版兼容。` });
  else sections.push({ id: 'unrecognized-engine', title: '引擎未匹配专用手册', text: '尚无与当前引擎标签匹配的专用手册。先查看native_probe与真实资源格式，不套用名称相近引擎的回写规则；沿实际缺口使用当前工具、公开资料和自编适配器，未知保留为未知。' });
  if (has('native_unpack')) sections.push({
  "id": "archives",
  "title": "归档与成员",
  "text": "native_unpack 接收归档相对路径及可省略的格式，返回 work 根下的成员目录与成员证据。native_repack 使用该成员目录、输出相对路径、格式及原归档相对路径；成熟工具核对成员读回。用这些输出继续调查或编写适配器，不重复猜测已登记工具的参数。"
});
  sections.push({
  "id": "verification",
  "title": "配方与完成证据",
  "text": "目标是玩家运行游戏时可见的文字，不是编辑器、制作工具说明或开发文档；实际消费者决定用途，混合资源只处理真实显示部分。先用 inspect_coverage 查看当前缺口。reviewKind:resource-file是整份资源的待审证据，须用read_resource按sourceIndex完整读取，可分页；只有nonDisplayAllowed为true且证据表明没有未接入的玩家文字时，才用record_coverage_decisions提交non-display及用途依据。资源display只确认有文字，不算提取完成；已有少量定位也不代表整份文件覆盖。资源boundReferenceAllowed为true时，须通读并核对全部玩家文字已由现有定位覆盖，才提交bound-reference及依据；不传unitIds，主机绑定当前定位集合，不搬运长ID清单。仍有漏提或用途不明则继续调查。unknownClusters结合实际来源用同一工具判定display/non-display；表达式已由现有单元完整覆盖时用bound-reference和unitIds，无语言文字时用non-linguistic。这些分类出口不用创建空提取器。真正漏提的dynamicCandidates用display-id交给write_text_adapter。调查确认的普通脚本文字尚无候选时，用write_literal_adapter的selections:[{file,text,reason,occurrence?}]，text只填原文字句，不带源码外层引号，宿主负责语法定位；多处同文需明确0起occurrence，不计注释。JSON字段使用已有display-id或精确pointer适配器，不走本工具。主机生成准确定位，不必手写六个方法；其它格式与复杂逻辑仍用write_adapter或受管脚本。新适配器经validate_adapter返回结构、无改动往返和改文重提结果，读取具体差异修复后submit_recipe。inspect_coverage的nextPage是全局下一页调用；read_evidence只能补读某次工具的本页快照。需要读关联资源可调查整个副本，联合写入通过request_scope_change申请。结构检查、文字覆盖与游戏实机结果各自记录；一次工具成功不等于全部资源或运行验收完成。"
});
  return { version, engine, family: manual?.family ?? (ambiguousLcf ? 'lcf' : 'native'),
    manualId: manual?.id ?? (ambiguousLcf ? 'lcf-unconfirmed' : 'unrecognized-engine'), sections };
}

export const renderEngineOperations = guide => guide.sections.map(section => `${section.title}：${section.text}`).join('\n');

export function engineOperationsReference(guide, sectionId) {
  const section = sectionId === undefined ? undefined : guide.sections.find(item => item.id === sectionId);
  if (sectionId !== undefined && !section) throw new Error(`请选择操作指南中的章节编号：${guide.sections.map(item => item.id).join('、')}`);
  return { version: guide.version, engine: guide.engine, family: guide.family, manualId: guide.manualId, source: 'system-instructions',
    sections: guide.sections.map(({ id, title }) => ({ id, title })),
    readSection: { tool: 'inspect_context', parameter: 'guideSection' }, ...(section ? { section } : {}) };
}
