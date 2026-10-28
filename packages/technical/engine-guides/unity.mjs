export default has => [
  { id: 'unity', title: 'Unity 操作手册：先查载体，再追显示', text: `先核对实际导出目录与资源，不把识别为Unity等同于一种固定对白格式。常见输入为*_Data下的SerializedFile、AssetBundle、StreamingAssets和托管程序集；TextAsset既可能保存正文，也可能只是配置或二进制包装。先读已有native_probe、native_inspect、manifest与覆盖证据，复用已经建立的原生工作台，不按组件组再拆一次完整游戏。
区分Mono与IL2CPP。Managed中的程序集可提供类定义和显示消费链；GameAssembly与元数据是另一条路线，不能把托管反编译或类型树恢复的成功推广为IL2CPP已支持。类型树被剥离时先读当前解析错误及已登记工具的恢复结果；已有程序集才能支撑的恢复不靠随意更改引擎版本号解决。没有可用恢复链时保留真实缺口，使用受管脚本调查或研究新适配器。
按资源分配调查：一项任务核对本资源与必要关联程序集，多任务共享输入与已验证结果；不要为每个组复制Data、生成全量JSON或反复创建原生工作台。只把实际需写的资源复制到工作输出，未改图片、音频和其他成员保留原样。字段组数量、对象数量和字符串数量都不是对白覆盖率。` },
  ...(has('native_review') ? [{ id: 'unity-native-review', title: 'Unity 组件字段审阅', text: `直接调用native_review({file?,groupRef?,offset?,limit?})，limit至多12。首次调用native_review({})，先不传groupRef；单文件assignment由主机补全file，显式file仍可读取关联资源。使用返回groups[].groupRef，不手填groupId、长hash或诊断编号。${has('native_review_decide') ? '用native_review_decide({decisions:[{groupRef,disposition,reason,fields?}]})提交，每批至多50组；decisions是结构化数组，不要JSON编码。主机绑定实际组身份和资源快照。' : '当前未登记native_review_decide，保留审阅证据，不宣称已提交原生决定。'}
coverage中带prefiltered标记的已结算无文本汇总不再提交；native_review返回status:no-text且仍在待审清单时，必须提交non-display才能结案，不填显示字段。确认无字符串的对象不值得让模型逐个猜测；未能恢复类型信息则不是已证明无文本。
inspect_coverage的diagnosticId、scriptIdentity均不是groupRef。旧引用失效时重新读取本组，不不断重试相同编号。record_coverage_decisions处理unknownClusters、reviewKind:resource-file及表达式，不接收原生组或字段路径；表达式完整覆盖用bound-reference和unitIds，无语言文字用non-linguistic。原生审阅与决定由同名结构化工具提供，run_tool不再转发这两项；其他已登记工具仍用run_tool。` }] : []),
  { id: 'unity-display-binding', title: '显示文字与逻辑标识分开处理', text: `先看字段实际用途，不以日文、字段名或结构往返通过代替显示证据。identity或用途未知时不改原值；mixed-use字段同时参与显示、存档、查找或条件逻辑，保留原值。工具提供安全显示消费点时，用fields:[{path,kind,displaySites:[siteRef]}]选择同一groupRef、同一字段且displayOnly:true的引用，覆盖相关安全显示分支；实际程序集和消费点hash由主机绑定，完整证据用read_evidence补读。
没有安全消费点时继续调查，不把mixed-use归成完全无显示，也不把直接翻译原字段作为解决方案。结合write_workspace_file与run_workspace调查实际加载、赋值及控件消费者；新格式可自行写适配器，不局限于既有字段选择工具。` },
  { id: 'unity-runtime-text', title: '运行时对白与完整句', text: `序列化实例没有正文，不代表运行时没有对白。检查Text/TMP的赋值者、TextAsset解析器、脚本数组、外部JSON/CSV及本地化表，追查完整句如何到达控件。文本键、资源名、动画名和反射成员名不因可读而可译。完整对白与动态名字拼接模板分别定位，拼接片段不得拆成独立对白。
打字机先取完整句再按Length/Substring显示；须调查完整句到显示的链，不在最终set_text盲目全文替换。原值参与长度、计时或逻辑时继续保留；若已返回displayOnly:true的presentation-slice消费点，使用同一字段path和displaySites/siteRef，主机只在已证start=0的UI前缀显示处映射，保留原Substring参数异常、原Length与计时逻辑。非零start、未知UI读回或尚未证明安全的分支继续调查。
提交前区分三件事：资源能读、文字有安全定位、中文能在实际运行显示。validate_adapter和原生决定回执核对结构、原样往返和改文重提；完整成品还需核对未修改成员、资源引用与字体。无游戏运行证据时runtime保持未验证；只显示菜单的成品不能冒充对白已完成，未知动态模板继续保留。` },
];
