# 紧急交接：Pi 试用修复 Subagent-Driven（F1/F4验收完成，F2新run刚完成待验收）

> 当前紧急快照。用户要求立即write handoff。最新通知：F2接续run `655e8fa7-a328-4a2a-95fa-074544b43345` completed、no output，通知标题错为F1；必须按runId读自有输出/状态投影，不能据标题判断。计划尚未完成，收到完成通知后必须立即续推DAG，不能所有任务结束后停等用户。

## 目标与授权

用户选择 **Subagent-Driven** 执行统一计划：
`docs/plans/2026-10-08-pi-production-trial-fixes.md`。
六项：T1 agent列表空、T2默认模型丢有序候选、T4成功completion不可见、T5折叠工具错误不可见、T6历史root/leaf重复、T7builtin替代警告。

- T3用户认为可能误报且发现subagent中可显示，暂关闭不修。
- T5 **只修TUI错误可见性**，provider/重试/网络/代理/上游断流不属于本仓，不追查、不改。
- 主agent只编排/技术决策/验收diff、回复child、亲写计划状态；production实现/行为测试派subagent，不inline修代码。
- DAG：F0 → F1/F2/F3/F4/F5（路径独立，可编码并行、共享TUI验证串行）→ F6。
- 计划修改只能main inline；子任务不改计划checkbox。
- 不能每子任务询问用户，依赖满足立即派发。无独立工作且有active child可结束turn，自动completion/decision唤醒；不得sleep/status/pending轮询等待。

## 约束

- TDD Skill绝对路径 `/Users/leshi.zhy/.agents/skills/test-driven-development/SKILL.md`，参考同目录 `writing-good-tests.md`。main已加载，每实现child必先read。
- 六项中文bug provenance已经存在：`docs/bugs/2026-10-08-pi-1.0.2-production-trial-issues.md`，根因report `docs/investigations/2026-10-08-pi-production-trial-root-causes.md`；无需每child新增bugdoc，不能因其WritePaths禁docs而停。
- **显示只能renderer，原message/content/display/details/toolResult/structuredContent/event/session不能为显示改写。**不新增completion sender/authority，native消息仍唯一触发模型。
- 不改上游/深私有factory/vendor/万能resolver，不恢复Goal/auto-continuation/ended-childautoresume，不扩大权限。
- 新prod .ts、Node>=22.19、中文新增注释、tsc覆盖。
- 不读auth/models/credentials/真实sessions/state；本机settings仅临时脚本间接读/内部比对/定点resources变更，enabledModels+所有其他字段不变，不打印正文。
- 不安装/升级依赖/global switch/commit/push/reset/restore/stash/工单，不hotreload/终止既有用户Host。
- 不全量主suite/36integration/60秒lease/五paidchild；单聚焦command<=60秒，正确RED/GREEN和必要静态检查，F6一次聚焦集合。不要重复宽审/整套升级门禁。
- bash cwd参数历史不可靠，正文显式`cd /Users/leshi.zhy/pi-config`；**禁止find ..、宽范围grep用户/var/.pi/session**。只指定源码paths。
- 每dispatch需完整task、writePaths、acceptance criteria；代码工作无worktree（当前main大量uncommitteddirty不得commit使worktree继承），paths分owner。
- workflowdispatchreceipt只是launch不是child完成；通知title过期，按runId。

## 仓库、实际依赖、保护基线

Main `/Users/leshi.zhy/pi-config`，main，HEAD `6a80920e26ce6757b360c062ef6813a4d799288d`，大量升级dirty已存在，不能丢。
唯一代码rollback tag `pi-config-0.87.1` 不含dirty/runtime/凭据；不要自动回滚。
实际root四core **1.0.2**、enhanced `pi-subagents 0.75.0`已装；四peer realpath绑定root physical Host。
Host `/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent`，entry dist/cli.js。
旧global0.87.1和既有Host保留，不终止/升级；current source不意味着旧进程加载了新代码。
Node：
- current `/opt/homebrew/Cellar/node/26.8.1/bin/node`
- minimum `/tmp/pi-100-upgrade.Nxvr1T/artifacts/node-v22.19.0-darwin-arm64/bin/node`

F0 **accepted** run `fd13a2e6-ef38-4209-a824-8a6109b794f2`。
基线 `docs/plans/records/2026-10-08-pi-trial-fixes/baseline.json`：31 WritePaths，29保护（6新null），staging[]，versions/peers匹配；main29hash核对0偏差。
Arena `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou`。
Before副本 `<arena>/baseline-files/<repo-relative path>`，只非敏感声明文件（不settings/session/auth）。验收用其diff，**git diff含先前升级dirty不能直接归本轮**。
临时账本 `<arena>/evidence/dispatch-ledger.json` 已旧，需更新，不poll其等待。
每child自有F1/F2/F3/F4/F5子HOME/agent/XDG/evidence，测试env-i、explicitmainHost/offline/telemetryoff不inheritrealcreds/live markers。
F0早期错误find..扫描user，owned scan被main精确SIGTERM取消，baseline有scanIncident。不要复刻。baseline dirtyPaths首行因strip格式丢点/状态位，不表示真的stage（git实际空）。

## 已验收任务

### F1 T1/T2 accepted

原run `a7b9662a-5d3d-44b0-9334-cded187042a9`，58/58。
Main验收发现自制frontmatter parser不符计划，补派run **`a7dc46ec-8c67-455e-a083-e24acdc800b1`**，已complete **87/87**。
最终证据 `/tmp/arenaF1-followup-7Iaqgd/evidence/{f1-red.log,f1-final.log,f1-hashes.json}`；RED51tests19fail为CRLF/类型语义失败，GREEN87tests87pass0fail；main已读日志并5最终hash匹配。
实现：公开SDK parseFrontmatter底层（导入alias hostParseFrontmatter），固定repository三个profile元数据models/model/tools/thinking；BOMCRLF/YAML/空非法models/model/tools failclosed；list可信admission不需要filePath，不伪造路径，metadata不是actualmodel；省略profile模型选首可用qualified进入generic/coding leaf.model sourceagent-default，requestedModel仅explicit，no-profiledefault，次位/全缺零spawn/explicit/virtual/blocked/providererror不再次spawn测试；工具description已同步。
Paths：
- enhanced src/compat/pi-subagents-0.75.ts
- enhanced src/subagent-dispatch/extension.ts
- test/pi-subagents-compat.test.mjs
- test/subagent-model-selection.integration.mjs（快速内存RPC）
- test/subagent-dispatch-extension.test.ts（未必要改动）
Plan F1全x（最新87/87追加）。早前main误称scripts/probes/pi-subagents-compat.ts是F1越界，已查自有events无写，实际为之前升级dirty，不得恢复它。
小留意：tools数组拆逗号并filter空；目前计划合同满足已有合法形式，不预防扩容fallback。F6类型check可能发现额外入口问题，按owned owner修。

### F4 T6 accepted

run **`da6df870-ad43-4ab7-9815-1c17a60c4d74`** complete、**90/90**（0.872秒）。
证据 `<arena>/F4/evidence/`：environment.json、red-baseline.log、red-footer.log、red-trim.log（21terminal两个正确RED）、green-three-files.log、changed-hashes.json。main已核对5finalsha当前一致。
Paths：enhanced src/tui/session-browser.ts、extensions/custom-footer.ts、test/subagent-session-browser.test.mjs、test/custom-footer-subagents.test.mjs、新fixture trial-browser-lifecycle.json。
实现：runMode/parentWorkflowRunId/workflowKey/facadeLeafRunId只显示metadata；confirmedFacades双向parent/key/session/agent/single匹配，canonical snapshot隐藏root对应step、不改leaf实际状态；serialize raw children；footer persist raw、trackedRuns仍poll隐藏root发现后续steps；selection迁canonical；trimRuns用confirmed关系组件全组淘汰/active-selected保护，exit重新20预算，无永久墓碑。
早期测试未env-i解析global报theme错误，已纠正并恢复owned prod基线重RED→GREEN，这些旧结果废弃不当GREEN。F4计划全x。

## 剩余任务及运行状态（最新必须按ID）

### F2 T4 completion UI **completed，实际报告已核对26/26，待最终diff验收**

原run `13c4af1a-deb3-4a2b-a41d-82242ff9c55a` 长期active但测试走错路径。mainexplicitinterrupt后paused observed，再explicitresume，**接续run `655e8fa7-a328-4a2a-95fa-074544b43345`** 刚收到completed/nooutput通知。通知标题错成F1，实际它是F2。

Paths5个：
- 新 enhanced src/tui/completion-notices.ts
- enhanced extensions/subagent-runtime.ts
- enhanced src/tui/compact-rendering.ts
- 新 test/subagent-completion-notices.test.mjs
- test/subagent-compact-rendering.test.mjs

已落盘observer用公开pi.on message_end→mode:tui hidden subagent-notify→ctx.ui.notify(info)，WeakMap sessionManager/WeakSet message dedup、dispose listeners，不send/append不改raw。main尚未accept：必须检查runtime接线、正确真实测试和formatter。

纠正指令已发给新run（steer9bf303d0...送达）：
1. **不能mode.init()**，它startterminal/startup资源，fake写0断言矛盾；只InteractiveMode constructor+subscribeToAgent+session.bindExtensions(mode:tui/uiContext)。
2. **必须sendCustomMessage(original,{triggerTurn:true})** 走真实AgentSession `_runAgentPrompt→agent-loop→extension message_end`，syntheticprovider无联网；triggerTurn:false idle只_appendCustomMessage/public_emit不触发extension hook。不能manualemitMessageEnd伪造GREEN。
3. 断言一次custom persist/display:false/rawcontent/details不变、syntheticassistant回合1不额外；visible原卡不双显、非TUI不notify、生命周期释放。
4. runtime没有dispose；cleanup mode.unsubscribe/footer.dispose/renderer.stop+h.close。
5. formatter真实upstream消息**无details.mode/counts**，实际firstline `Background task completed: **workflow** (dispatch complete; 1 child running or uncollected)`；不得要求原数据新增fields，需renderer读取明确firstline表达receipt不✓child业务完成。

前序wrongtest保留现场，不拿它完成T4。完成后应释放TUIpermit；现在completed说明可以核对owned测试进程并授权新F3（资源依赖非DAG）。

### F3 T5 **已新派接续，真实TUI许可现归F3**

原run **`909639f7-d8b4-4c8d-be9e-c181358edc37`**，main明确允许blocked/待续结束后task通知failed（不是prod故障）。无active F3 child。
Paths6个：src/compact-tools/renderer.ts、pi/extensions/compact-tools.ts、tsconfig.json（唯一owner）、test/compact-tools-renderer.test.mjs、test/compact-tools-extension.test.mjs、新test/compact-tools-error-visibility.test.mjs。

流程偏差：初fake test未env-i+在真实componentRED前提前renderer实现。main核对后要求撤销自身行为，renderer/entry已恢复F0hash（renderer cb4aaa7f83779dd759a075deaf0fc82e16a3eaa7afd91c2dbe9ca0b365a5eea6、entry e221e0...），禁止gitresetrestore；测试保留。
tsconfig仅增加指定include（compact入口、ensure入口），静态coverage豁免，不F3runtsc。
preparation `<arena>/F3/evidence/preparation.md`、临时runner `<arena>/F3/run-focused.sh`，47真实componenttests+existingfile各1test准备，正确实际RED/GREEN未跑。pureenv baseline20/20、skillerror20pass1fail仅准备证据，初不隔离日志废弃。

**已执行：**main读取F2新run655e8fa7的最终acceptance报告（26/26）、原生triggerTurn:true纠正命令与progress_update明确释放许可，并确认F2runner不再alive。已新派F3 continuation **run `0192a576-bb84-4d03-a1c9-5df1099d71ed`**，明确授予当前真实TUI独占许可，完整6paths/acceptance/TDD/环境/禁止边界已给；从existing47tests准确RED→最小shared+Host双层errorGREEN→五文件聚焦。 context.isError优先/directresult兼容、readSKILL错误不吞、edit/write不done、中文ANSI窄宽度4lines/invalidate/successerror切换/rawdeepEqual。正确RED前保持rendererbaseline。No execute/provider/retry/真实network，env-i mainHost，每cmd60s，progressupdate释放给F5。

F3历史许可UUID均只reply排队不授权：19b56db7...、c03b40c9...、7e548d35...（被main错误reply“保持阻塞”其实唤醒导致child反复ask）、79368b1d...最终明确allowedblockedend。以后资源排队**不要立刻回复只是排队，保持pending直到许可ready**；或如child无法真正等待允许blockedend后新派，不能忙等loop。Controlsteer遇SUPERVISOR_REPLY_REQUIRED不要声称发送成功。

### F5 T7 **pure部分complete，待真实owner-loading+本机resources**

原run `20c2ec76-0c33-4dd3-bbf8-693fd8c42fc2` provider `Upstream response stream was interrupted`失败，未落盘。
重派pure run **`a1462d7e-fe84-41d1-ac98-8be19c82e68b`** complete/nooutput通知，但owned output-0.log末尾有acceptance-report；main已读取：**6 ensurepass，1 owner scaffold skipped**，不能接纳完整F5。
Paths5个：pi/settings.template.json、scripts/ensure-pi-settings.ts、test/ensure-pi-settings.test.mjs、新test/mcp-policy-owner-loading.test.mjs、pi/settings.json（仅临时脚本间接resources）。
已落盘template两个builtinexclude+ensure/check sharedexact相反+/-检测code SETTINGS_RESOURCE_OVERRIDE_CONFLICT/field/selector在mkdirwrite之前、pureJSONtests。owner-loading文件目前只有skippedscaffold。
本机settings没改（旧hash eb009b...是私有config不用报告正文），资源仍未生效。

过程偏差：该child误跑npx tsc（explicitfileTS5112、rootpass），计划说F6统一check；未来直接node localtypescript不npx/安装。未有实际install证据，不能宣称偷偷安装但也不能仅childclaim说没有。puretest命令报告可能未完整env-i，后续按正确safeenv重做聚焦/保存logs，F6统一。

**F3验证释放后新派F5ownerfollowup**，补公开DefaultResourceLoader真实policy+builtin factory owner加载RED/GREEN：main模板已GREEN，RED用F0模板副本在临时synthetic配置实际加载复现warnings，不回滚main或手写diagnostics；fresh/persistent-openresume errorwarning0、唯一tool/command、无configMCPconn0、allowedstdio/denied0/modelonly边界，no skip。safe本机config操作临时脚本间接只mergeextensions/defaultTools、预比对所有其它enabledModelsunchanged、冲突前置阻塞，不改externalproject/CLI相反override、不secretoutput。还需已有both-token/check、template自相反/check、defaultToolsselector真实场景等计划边界。

## 下一阶段 F6（尚未派）

F1/F4accepted，F2刚complete待验收，F3/F5未闭合，所以F6不能现在派。子任务全部完成后必须派F6验收，不问用户。

F6 allowed docs只问题清单、根因report、records/acceptance.md；**plan仍main更新**（尽管计划F6WritePaths列plan，globalmainonly）。必要补修只能另owner明确paths，不给验收child偷偷prod修。
F6一次currentNode计划8file聚焦集合，minimum只新3tests+F1/F4实际新名字pattern（现在测试英文字名，计划中文pattern未必命中，需调整到actualnames，不把0tests当pass）。once tsc listFilesOnly精确覆盖pi/extensions/compact-tools.ts与scripts/ensure-pi-settings.ts，再两Node root/enhanced noEmit各一次，不重复pack/fulltests；TUI短验证复用F2/F3新tests，不duplicate额外smoke。
声明文件对F0before保护，非owned/allowedhash保持、staging不变、settings非resources字段内部相等，自有tmpTUI/network资源关闭，用户Host不动。freshHost生效不hotreload、不commit。

## 计划review背景

一次readonlyreview run2456b0df-a46d-4d43-b6e0-c250383a0be6：整体可行需调整，0Critical/3Important/2Minor。main已全部采纳，无第二review：
- F3独占tsconfig補2prodinclude+F6真实listFilescoverage。
- F5ensure/check长期精确冲突保护，不只是人工safeonceMerge。
- F4关系组件whole淘汰/active-selected保护/21pressure。
- F0从WritePaths全集汇总新null+F6docs。
- F4真实rootagentworkflow→reviewerstep→leaf。
record `/tmp/pi-102-subagents075.ye2_0hoh/evidence/trial-fix-plan-review.json` 已completed（历史证据，不等于修复完成）。

## 历史不要误归因

前序升级代码合回/本地npmci/peerbind已完成，无commit/global；本轮不重做升级。历史双Node主1035/1034pass/1todo、typed36、actualsupervisor17、pi-lite等不替代本轮验收。完整mainintegration被用户嫌耗时停在23/36file204pass，不得恢复大矩阵。
主agent此前曾将已有gitdirty当F1scopeviolation、将F2pause通知旧title当F3状态，已按events/runId纠正；验收以F0snapshots+runId，不以title或HEADdiff猜。本轮主agent尚未inline改production，只文档与子任务调度/精确owned错误scan取消。

## F2正式接受与当前DAG（覆盖前述待验收）

F2接续655e8fa7...accepted；main实际读取raw正确RED/GREEN26/26，测试无mode.init/manualemit、3native sends→3synthetic provider/assistantturn、session一次custom/displayfalse/rawcontentdetails不变；runtime observer进extraDisposables、formatter实际firstline无detailsmode需求。planF2五x，hash/证据在arena/evidence/F2-main-acceptance.json。所有fake scaffold缺listenerTypeError不单独当RED，实际InteractiveMode缺正文为准确RED。

现在F1accepted87/F2accepted26/F4accepted90。**唯一active coding F3 run0192a576-bb84-4d03-a1c9-5df1099d71ed**，明确独占真实TUIpermit，WritePaths6、原47测试/先准确RED再GREEN，max60秒，无tsc/fulltests/provider。F5owner-loading/本机resources待F3释放后立即新派（pure6passed但1skip不算完成）；F6待剩2任务完成。ledger已更新真实状态，不poll它等child。主agent仍只docs/验收，未inlineprod改动。

## F3正式接受与F5owner加载已派发（最新）

run0192a576...completed（无inlineout但ownedoutput有完整acceptancereport）；main核对47/47真实组件correctRED->GREEN、五文件80/80/1.47s，F3final6hash精确匹配current，共享renderercontextisError+Hostwrapper/skill错误放行、40/100列/4physicalline/invalidate/状态switch/rawunchanged。tsconfig两入口只include，staticF6未做。planF3五x，arena/evidence/F3-main-acceptance.json记hash/log。F3明确progress_update释放TUI许可。

**唯一active coding task F5 continuationrun `1ec6607d-e070-49a2-8269-c2ba70f4b966`** 已派完整coding合同5paths，现在独占loader/TUIstdio许可。补F0template真实warningRED(临时copy不能rollbackmain)/currentGREEN/freshsyntheticresume/0connection唯一owner/codemode阳性；补ensure相反精确selector含hyphen/已有both/check/template自身check/normalmerge；本机settings间接仅resources原子merge、其他includingenabledModels内部deepEqual，不secretbody。最大60s四shortfiles，不tsc/npx/install/Git/fulltests。

现在F0–F4均accepted；F5待complete验收后立即派F6（docsowner不改plan，main更新）。ledgerpermit已F5，F6stillwaiting。不用pending/status轮询等待，有独立mainacceptance可读diff，否则endturn activeF5保持。

## F5最新真实加载结果与portable测试补齐（覆盖前述active1ec）

F5 continuation **1ec6607d-e070-49a2-8269-c2ba70f4b966 completed**，main读ownedoutput末尾acceptancereport：ensure8/8+ownerloading3+jointpolicy3+modelonly1合计15/15/0skip/1.70s。root currenttemplate ownerwarning0/syntheticresume owner1/无configconn等。main核对4代码hash与report一致。pi/settings.json未被child回写，本机nonsecretresources本来已有全部-builtin:toolsearch/llama/codemode/mcp和+codemode/-tool_search；其余enabledModelsPresenttrue，不能声称本任务改了整份config。未输出config正文。

main验收发现owner-test mandatorypath硬编码arenaF0template、currenttemplate写成literal，不可移植且缺currenttemplatemutationguard。因此**F5未finalaccepted，planF5仍未全x**，已立即派短测试补齐run **2330e195-b9d8-44c9-b748-4885cc6b5169** executor显式Astra，allowed只`test/ensure-pi-settings.test.mjs`和`test/mcp-policy-owner-loading.test.mjs`，明确当前独占loader/stdio许可，无其它implementationactive。要求旧行为对照literal独立测试资源选择、current加载真实pi/settings.template.json资源字段（不packages/bootstrap），无任何tmpbaselinemandatory、fresh/公开syntheticresume bind真实sessionstart+codemode纯text阳性/零MCPconfigconn、cleanup、ensure补真实codemode及hyphen/both/check/template相反/check，两文件+joint短回归一轮env-i，不tsc/npx/fulltests/安装，所有prod/settings不改。完成后验收F5并立即派F6，不问用户确认。

**外部并行变更必须保留：**当前ensure-pi-settings.ts/test新增r2cAdapterDir与missing-adapter清理逻辑、settings.template及main settings也有外部资源更新。main查两个F5run events：F5只加exactresourceconflict/修hyphenregex/ensuretests，未写r2cAdapter功能。该功能是其他会话并行工作，不归本计划，不机械rollback到F0。新的portablechild已明确保留r2c逻辑/测试不reset。F6static与changedfile保护需区分外部追加diff和本轮ownership，不能因同WritePathhash变而抹他人工作。F5report无diff不等于全周期settings没外部改，内部安全比对仅其自身处理期间。

当前active只有2330e195 portable补齐，F6尚未派。F1accepted87、F2accepted26、F3accepted80(47new)、F4accepted90。每任务plan状态main已x，仅F5/F6待执行验收。

## F5接受，F6已派发（当前唯一active）

F5 portablefollowup2330e195...completed，main读/tmp/f5-3a0bc04e.log 15/15/0fail/0skip/0.863s，owner-test读actualsharedtemplate/no/tmpmandatorybaseline旧对照literal，code/no settingschange。planF5五x，F5mainacceptancehash/log在arena/evidence/F5-main-acceptance.json。只有F5freshbind一次，syntheticresume恢复loader/SessionManager，网络MCP/provider不验证，不扩大为paidlane。

**F6 executor run `e1126ddc-8634-43c4-87bf-f3c2552e7a73` active**，完整coding合同只allowed3docs：问题清单/根因report/recordsacceptance.md，不能改plan/prod/test/settings/tsconfig。独占TUI/stdio许可，所有实现children结束。任务一次current8file聚焦集合+minnew3file与actualpatternF1/F4、once listFilesOnly覆盖compactensure、两Noderoot/enhancednoEmit、diff/baseline/protectedhash/externalsource/privatesettingsresourcesreadonly/safety/staging/resources，中文交付limits。明确错误需need_decision不得偷修prod。recordrun/permitF6在ledger。

精确证据输入：F1followup87 /tmp/arenaF1-followup-7Iaqgd/evidence/f1-final.log/hash；F2correct26 arena/F2/evidence/green-final.log；F3true47+reg80 arena/F3/evidence/f3-regression.log/6hash；F4correct90 arena/F4/evidence/green-three-files.log/5hash；F5correct15 /tmp/f5-3a0bc04e.log(最新测试修维护另reporthash)。F6不得重pack/fullmatrix/reinstall/hotreload。实际并行r2c变化保持不归本计划，不能因此rollback或宣称全保护hash未变。settings现在targetresources已有，不本轮整包回写。

main后续收到F6needdecision若noEmit报ownedtype错误，派声明owner微修（完整RED/provenance或static豁免），不inlineprod、不无限重复验收；若外部unsupported数据按gate分类不加防御。F6通过后main读log/count/hash/docs，更新planF6五x/ledgercompleted、最终报告六问题与freshHost/未commit/不paid/upstreamoutscope/T3closed。不询问用户是否继续每任务。

## F6首轮验收查出漏跑，最小补齐active（覆盖前述GO）

F6首轮e1126ddc...completed reportGO，main已读logs/docs/source+docsha9+3全部matched/staging空/whitespace0。**不能直接accept**：mincmd将globalpattern用于6files，`f6-min-pattern.log`三newfile `1..0`/ok文件占位，51pass中只有48actualpatterncase+3空占位，completion/errorvisibility/owner newcases并未执行。static第一cmd listFilesOnly后currentrootnoemit确为exit0/wall0.8，又loopcurrentrootnoemit ->**4uniqueNode/config全pass但5invocations/currentroot2**，须记录预算偏差，不能声称4calls。listFilesOnly1419lines含末人工entriesline=1418sourcepaths。bugdoc仍首部只plan未实施/各未修复与结尾GO冲突。

立即派唯一active **1ec02236-1662-4bc6-ba7a-354c7c907cd9** executorAstra：只一次minNode无pattern跑新增3files（预期54但actual为准），不重跑current176/F1F4pattern/types。只3docsWritePaths，纠正各currentstatus/历史现场时态、minimum48+3empty/noemit5unique4/listcount、summary/log/docsha。失败needdecision不修prod。独占F6最小验证许可；no install/fulltests/hotreload/model/userHost。其余已全部结束。

main已inline修计划F6minimum两个cmd明确分离，保留实际执行偏差说明。F6五checkbox仍未x，F0-F5完成。completion通知correlate真实runid，receipt不result。收到1ec02236final后main读new3logactualcount/summary/3hash及docs状态确认，不再追加任何test；通过markF6五x/ledgercomplete/许可null、交付六修复/Node26current176、Node22newN与48actualpattern、static4unique5calls/freshHost/no paid/T3closed/T5upstreamoutscope/无commit。不要claim旧minimum51代表newcases。

## F6验证齐备，仅doc整合active（不再跑测试）

补验run1ec02236completed57newcases/0fail/0skip/7.494s，此run曾首次错误envPI_TEST_CODING_AGENT_ROOT传repo导致三个import-onlyfail，后正确physicalroot57通过；无代码改，分类2手工testenv非法，禁止为它加productionbranch。它未遵守权威arena而find/tmp-maxdepth3错用/tmp/pi-100-upgrade.Nxvr1T/artifacts/arena/evidence，覆盖自身首次失败log。main已按明确路径复制成功f6-min-new3files.log/.exit到权威arena/evidence，从ownedtoolresult提取保存firstdiagnostic f6-min-new3files-invalid-env-diagnostic.json（不是丢失失败后伪全pass）；报告processdeviations在summary，无需再测试或宽搜。外部arena新3dochash与main全部matched，currentcode9sha仍same。

**准确F6：current176actual；minF1F4pattern48actual+3emptyplaceholder(old51)，new3files独立57actual**；static4unique5invocations/currentroot2，list1418paths+1summaryline1419total。最新权威f6-summary已main更正，旧外部summary不权威。planF6步骤1–4x，5pendingdocs，F0–F5全x。

三doc最新仍acceptance错arena路径/少F1-F5接受loglink/shouldwritehash，rootcause结尾还有51actualpattern矛盾。因此唯一active doc-only delegate **2641e0e0-c562-4938-99c9-c749b4a4d28e** Astra，only3docWritePaths，禁止任何bash/test/typecheck，精确整合正确arena/evidence、176/57/48+3、1418+1、4unique5calls、F1-F5各RED/GREEN记录/limits，保siximplemented/T3closed/T5displayonly/freshHost/no paid/外部r2c/index。主agent不要因此再派验证。ownedstdio许可已经释放，无排队实现。

收到2641e0e0结果后main读三个doc确认counter事实、hash按current生成到arena/evidence/f6-doc-hashes.log和F6-main-acceptance.json，markplan步骤5x并写completedtail、ledgerF6accepted/permitNone、handofffinal。然后直接用户交付六项修复/current176/min57+48/两Nodecompileall4组合/freshstart，不提旧51为验收、不承诺upstream原因/旧Host热更新，无commit。已无生产修复缺口，不要再衍生review/testcost。

## 最终收尾：生产试用六项修复计划完成（本节权威）

**F0–F6全x、ledgercompleted，无activechild/测试资源/排队，无用户阻塞。**F1–F5分别87/26/80（新47）/90/15接受；F6currentNode26.8.1一次8file176实际病例、minimumNode22.19.0新增3file57实际病例+F1F4pattern48实际病例。旧minimum聚合51=48实际+3空文件占位不得冒充新增完整验证。两Noderoot/enhanced4unique组合类型均通过，共5次noEmit/currentroot重复一次；list1418pathlines+1manualsummary=1419total，两个入口实际覆盖。no fullmatrix/paid/hotreload/commit。

F6doc-only run2641e0e0结束但harness拒绝commandsRun[]（任务禁任何bash），非代码/测试fail。main读3docs，纠正原报告F2/F3职责错配、日志名称不完整，并作为报告整合接受；没有为凑harness格式继续跑命令。最新三docsha在arena/evidence/f6-doc-hashes.log，mainacceptance在F6-main-acceptance.json，f6-summary statusGO-main-accepted记录doc-runtimefail与mainaccept原因。9sourcehash全部与current相同、Gitstaging空、doc/plan whitespacepass。

权威arena/evidence=/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou/evidence，已归集minnew57log/.exit，不用外部candidatearena为证据入口。首次补验错误env importonly3fail分类2，ownedtoolresultdiagnostic保留，prod未改；globalpattern漏跑/重复rootstatic/错误arena/tmp扫描等process偏差均记录，不隐藏、不扩成newprod。旧日志与其他dirty都保留。

交付文档docs/plans/records/2026-10-08-pi-trial-fixes/acceptance.md包含六项、F1F5实际RED/GREEN、正确Nodecounts/static/limits；bug/rootcause六状态一致。T3按用户意见暂闭；T5只修错误展示不解决上游断流；completion提示实时UI非sessionpersist新副本。本机资源字段已目标无需整包回写，enabledModels/外部r2c/notours配置实现不动。**用户需fresh启动Host才生效**；旧Host未动、globalPi未切、未安装/commit/push/paid生产canary。本计划已完成，不再派子任务、全suite、第二review或旧升级doc收尾；后续如新用户需求单独处理。

## 2026-10-09 最新：共享规范/list 已验收，steer 历史查找仍在查

本节覆盖此前TDD强制/1.0.2候选/AGENTS_APPEND默认注入等旧判断。**默认禁止TDD和任何TDD类skill**（用户已改规则），不读writing-skills/TDD，不新增测试，用户明确授权单项补测试/TDD才例外。调研/实施默认subagent；书面计划主only，目前新任务无书面计划。只运行用户允许短纯单测+新增TS所需静态检查，不真实Host/PTY/MCP/provider/模型canary/全量集成，不安装/热载/commit/index/reset。

### 当前安装与init现场
四Pi核心已1.0.4，增强dev peers1.0.4、pi-subagents0.75.0不变。升级run44b01894与init常量补af480d0c已结束：158个挑选非MCP单测通过，init纯假命令fixture1通过；themefixture失败曾被排除，不能说全unit通过。**chord/pi-codemode/pi-mcp/pi-telemetry caret解析为1.1.0**，非纯1.0.4闭包，不再当稳定目标已证明。用户实际跑init多错尚未给log；只读诊断d5fac3c5完成，init尾部有fullnpmtest/Doctorphysicalprobe/runtimeintegration，之前unitgreen不证明init。PI_VERSION/PI_PACKAGE实际unused，rootnpmci由lock决定；此前说常量导致重装旧版已纠正。无现场log不能归因，只请求第一error/末summary，不自动重跑init/修配置。

### agent list已验收
实现run34faa86f结束，compat0.75保rawfrontmattermetadata(unknownfields/types/false/scalartools)深clone，dispatchlistcontentJSON[{name,frontmatter}]同时details保持原fields+metadata，不含body/fakepaths；无RPC/modelcatalog/spawn。曾有4旧wholeobjectdeepEqual fail，收尾run3e7458a0只test/pi-subagents-compat.test.mjs加2metadataexpectedliteral+titleupdate，**29/29**日志/tmp/dispatch-8531707b/run.log，main读diff与实际count接受，没新增tests/TDD。code尚须freshHostlive生效，当前tools可能旧nameonly。

### agent正文与context
ecde9b05正文TDD清理已accepted：delegate/executorbody删TDD，reviewer原无未改，3frontmatterbyte相同（/tmp/dispatch-00e433a6 before），**delegate frontmatterdescription仍含TDD用户仅授权body，所以没改**。e0b29b82源码追踪已结束：实际selectedagentbody在system，generic task user原task，codingtask userDispatchContract，task不覆盖system；上游再discover按childcwd/projectoverride或settings不同不能保证所选body为本仓profile。delegateprojecttrue/globalfalse，exec/reviewinheritfalse，不能可靠拿pi/AGENTS。用户拒child直接globalinherit。正文reviewer原ad648258overload，重派b4f35bab(Sol)已完成三body建议，**用户只要求分析未确认采用，没有写新的300-600字rolebody**。适合body：delegate复杂归因/方案+实现，exec确定性契约实现，review只读真实产物/严重性路径证据建议；shared通用，task本次paths/docs/acceptance。未经明确采用别自动改profiles。

### AGENTS_SHARED规范与接线已验收
文档run496f5362先拆4docs，用户指出shared不应rolejudge后纠正run6f587735两docs结束，main读final/sharedrolewordzero/安全义务保全+hash。旧pi/AGENTS_APPEND.md删除、新pi/AGENTS_SHARED.md**角色中立**，没有主/subagent分支；主pi/AGENTS.md保dispatch/DAG/reviewer逐次批准/用户工单决策（注意之后实际派reviewer须userexplicit，不可自动一轮review）；rootAGENTS仅导航+provenance“精确RED”改“精确复现证据”，工程规范仍all适用。源码runb0846492已结束accepted：src/agents-append/index.ts删除无facade→src/agents-shared/index.ts；newpi/extensions/agents-shared.ts为自动main+requiredchild绑定；可靠childenv显式传scope，shared正文同源、child另runtimeblock(no nesteddelegate/needdecision/contact/工单确认)，不让模型自己判role；不打开inheritGlobal，不加tools/activeTools权限。默认sharedpath锚feature所属root，不随worktreecwd漂移。input每轮read一次snapshot，beforeagentstartappendtag去重；session_start读取成功才ACK，childrequired startup失败用既有Hosterrorcollector，main缺文件为扩展错误+后续inputhandled门禁，不宣称所有providercontinue硬阻断。same-session required registration数组appendshared，registration顶层requireForAllRunners保持默认（per-entry被API拒绝，顶层true会同时改变旧owner/queue义务）；**仅本生产detachedRPC nativechild保证加载，external/foregroundlegacy不扩大保证**。
验收：existingorderedmodels **4/4**、membrane **91/91**、root/enhancedtsc通过(rootscope变更后再check所以2次root)，没有真实startup验证；temp纯factoryhook与APIshapeprobe通过，earlyprobe import/重复path/Darwinrealpath错均只fixture修正，无prod兼容。main已直接读源码/ACK权威文件与result投影，不重复tests。runtime9?finalhash: sharedfile582c2c2344cc5331310c90fe5cfa08176e8b78d50a4fd340205dd788488829f1；feature8e337dcc1d93416fc286676f251ef66478843c5de9d9e94de05d936bbb00eb2c；bindingd53342b47b76036cf9ba664a5d5710ba08f631f3acb3a4715909c3195abd165d；enhancedmainb2330411dcd925d425d3aa2863d1633f5363a4c25c423bff1292a197acea1121；dispatch41f6c9c653029c9b310cf2abe97889f34afc8a1856ae2c4df09a6cda17c2441e；tsconfigc6fe15f411fd63ca37896a666f6800d69ddb07325af91b60f90cc434d5e4379e。staging空/whitespacepass，nohotreload，用户尚未为此restart。

### 模型fallback取消
只读65e75843完成：多models只是startuporderedcatalog，upstream0.75已移除fallbackModels，postspawnprovider失败不能catchspawn重派。user明确“先不支持modelfallback”，**不实施、不自动换模/重派**，后续不同error自己roledecision即可。

### Steer证据与当前唯一active历史查找任务
用户已明确授权targetsession及相关historymeta读取，不其他session/body。targetdelegate **e0b29b82-394f-4f70-952d-bbcdbdbe4430**，root0fc3c5f4-7d5b-45a7-8610-7ec3d3739e68，keytyped-654a6dd2-dd78-4b2e-9b85-3c7e5bf1a577，dispatchtitle“追踪 tool 内容与 agent.md 正文进入 child 上下文的形式”。steerrequestfd8f2b3e-4410-42f5-937c-79071f0cbfbf。
授权exactsession /Users/leshi.zhy/pi-config/var/sessions/2026-10-03T05-50-45-905Z_01a10050-9e91-7461-901b-068420357d64/0f19d968-1edf-40f1-82a4-204a2625965e/run-0/session.jsonl。entry505db537 parent72be0d01 UTC06:18:25.903(本地14:18:25),user普通消息无display/customType，1029chars sha2568c4d59b2ed24fa1706776e9a2454373deca3e68daf8ce9205da778dad3d8baf2含完整steerwrapper+AGENTS新问题，主已independentscript验证。delivered06:18:25.902,queued10.378s前。persist证明收到，不凭nativeflag证明模型正确执行。57c482fc证据report中“工具造假”无独立支持不能传播当事实，只有自读entry支持。
用户入口Option+O；d7f9142d只读进一步证明onactivebranch、nativeUserMarkdown无截断；fallbackrenderer仅一行可能英文wrapper占据中文被slice。默认viewportautoFollow尾部、Home/PageUp/End有效，无searchjump。但未实际UIcapture/当前Host实例证据不能断言scroll或fallback就根因。先请求用户观察完整/英文单行/无msg。用户问title时main只给了dispatchtitle未验historiestitle，用户反馈**本会话历史无此title**，因此不能再要求按该title找。
**当前唯一活跃任务 `0d33f5ed-7192-4f6a-b7f8-d3e463c9444b` executor只读核对history**：实际rosterlabel、parentmembership、canonicalfacade/leaf、max20terminalbudget/eviction。只允许exacttargetartifacts+从statusmetadata定位exact父session并filterbrowsercustomentry/目标titlemeta；不dump父msgbody，不findsessionsdirs。它新spawn会影响terminalbudget必须在report标snapshot时点，不猜先前user一定无项。不能为了验证修TUI/restorehistory/re发steer/更新realsettings，也不新test。收到结果main读相关投影/实际label或removed证据，给用户确切可找label或确认已被historyevict，不将新任务通知staletitle当actualtitle。所有已派coding已finishedaccepted，不再启动review/newtests，共享已完成，无implementationpending。

异步通知经常挂旧title，**始终以runId关联**。workflowreceipt只有launch不result，no睡/pollstatus等完成。只有明确用户诊断/介入才一次status；后续无独立工作即可endturn，不重复十次“回执已收”。

## 2026-10-09 最新补充：GLOBAL/MCP禁令验收，两个任务仍active

GLOBAL迁名runb99ed1fe-790f-4986-becf-c25eb57e7f18已完成：pi/AGENTS.md删除→pi/AGENTS_GLOBAL.md；newsrc/agents-global/index.ts+pi/extensions/agents-global.ts，bindingchildguard前return（不读/不注GLOBAL），maininput/read/独立systemtag；tsconfig仅两个include。main读源码/rootnavdiff+静态hash接受，rootnoEmit一次passed日志/tmp/agents-global-before/tsc-root.log。用户不要文档自判role，原首段仍role说明因此补runa128c397-9ba0-4ce1-a81e-d5d5b69bd8e0已complete只首段一行替换（before/tmp/dispatch-8d65a8a7/AGENTS_GLOBAL.before.md），main读完整报告/hash确认accept：GLOBALfinalsha f19e8f186d45230231471ec69bed5cda350d26a1fc84ee06dcea0171715a1fc3；globalfeature69148a024f11752d5853e59bcaab11e1c691f982039082ea8f759369c9212557；globalbindinge608114b8a3c953dd192cf0f90113f990b17465d403b43b5186624cc3f442d2f；tsconfig6625be0f2026f519c29ee0d17dbff7028df8f2251278f0f6a9369e69ab2a21db。SHARED/source/entry三sha与此前相同。GLOBALtext无角色适用判断，subagent客观对象词保留。no freshHost/hotreload，旧Host尚用已加载代码，新生效需restart。

**Exa MCP迁移取消**：用户先要skill→MCP+迁cred，主请求计划user明确不要直做，但未派实施/未写配置或读cred；用户随后暂停并要求根AGENTS禁MCP。最终run902bdb40-d6a5-47d8-b66a-07a034a4624a仅根AGENTS新增+4行“外部工具接入规范”已main读taskbeforediff与sha接受。最终根AGENTSsha e1e5569b20d710303c0c01715bb4d37fa2d6f008709612972d4e65c78e8061bd；before/tmp/AGENTS.root.before-mcp-ban.md。**禁止MCP接入/注册/直call/server，所有外部能力走skillwrapper非MCP CLI/SDK/HTTP，不可把MCPclient藏skill**。本次只新增规范，不清除已有mcp-policy代码/配置；Exa保持旧skill/Python，不迁/读/轮换凭据。不能继续旧MCP任务。

### 当前两个active编码任务，无其它实施待验收
1 **a1466187-382a-4ffa-89f6-44f7c5c347e3** executor：用户已贴init报错（全局旧Pi theme okhsl不支持、requiredsharedfixture缺入口、旧版本1.0.2断言、缺PI_TEST_HOSTenv、旧TDD断言、runToolCall/outputSchema/disposition/session失败可能Host混用）。only17个test/helperpaths，productioncode/config/install不改。任务集中helperdefaultrootphysicalmainSDK、syntheticagentDir补sharedentry、更新现有旧期望，不新增tests/TDD；只短pureunits，**禁init/Doctor/PTY/RPC/session/actualtool/hostprobe/MCP/integration/全量真实flows**。根公共API如修host后仍不符给needdecision不compatfallback。不claimallinitpassed，只unit/staticupdated vsnotverified分开。用户贴故障是test污染来源，不能以此前挑158pass忽略。这run还未result，不statuspoll等完成。
2 **e838774b-4685-4efd-8118-381223755041** executor：user要求supervisorreply冗余bodybox改confirmationreceipt，onlycompact-rendering.ts/增强主subagent-runtime.ts/test/subagent-compact-rendering.test.mjs现有期望。查真正subagent_supervisor_reply默认renderer覆盖，不只toolresult。**TUIonly不改native消息/session/details/display或deliverlogic，requests正文仍保留，不发第二notify**。后来user要求复用“派发完成，1个子任务仍运行或待收集”同样式，主steer87dcdc57-577e-4341-88ea-fd45ba14a6aa queued，补充是否consume/实现需final代码核对不能queued=done。文案“回复已提交/已送达”依据真实事实不能echo声称childconsume。现有unit19一次+root/enhancedtsc，noTDD/newtests/realreply/Hostflow。收到actualrunidreport验源码formatter+MessageRenderer+共享code先前delta保留/日志，不额外review。

### steer历史查找关闭只读调查
0d33f5ed-7192-4f6a-b7f8-d3e463c9444b已complete，Option+O roster是globalThis进程内存不落disk，RECENT_RUN_LIMIT20**rawterminalrun**而root+leaf各占1导致约10任务；canonical折叠不会还budget，整组最旧evict。目标e0b29b82原dispatchtitle确“追踪 tool 内容与 agent.md 正文进入 child 上下文的形式”，parent本会话meta确认，当前32run16组件31终局推oldtarget第4老被evict。但**未readlive内存**只是高置信推定，用户已告知不能绝对证明当前list。此前让用户按title找浪费时间已道歉，别再让在无record中盲找。exactchildsession文件与entry505db537steer保存（授权范围），不重发steer/恢复history/改limits。user尚未授权历史上限改。readtask报告的伪造tool指控无独立事实不传播。当前init有log归因可修test，不继续credential讨论。

## 2026-10-09 最新：init单测修复已接受，reply收尾active，违规扫描已精确取消

initfix **a1466187-382a-4ffa-89f6-44f7c5c347e3** 已完成/mainaccepted：6testpathsonly(taskbefore/tmp/init-fixture-fix-before/，main读逐filediff)、helpers/pi-runtime.mjs默认本仓rootSDK而非npmroot-global，显式envpin/显式globalreader注入仍支持，无root时fail不fallback；helpers/joint-upgrade-session.mjs新增sharedbinding真symlink保障requiredrealpath；compat/peerinstall用helper不joinundefined；hostprobeexpect1.0.4；revieweragent旧TDDassert改doesnotmatch、不恢复TDD。实际units helper10、profile/compat/peer32+1todo、errorvisibility47/footer45/nativeconversation13 -> **148total/147pass/0fail/1todo**。main核对events实际count/noextra execution接受。旧主题okhsl失败出自global0.87.1，不合法新版theme问题，不能再说simplefixturewrongcolors。真正RPC/session/ceiling/feature/Host-probe/process-fleet没有跑（禁realflows），仅修helper/expect并静态核验当前1.0.4exports，所以**不claiminit全过/全suite通过**。prod代码/config/depinstall/noTDD/newtests/index零改。

reply第一任务 **e838774b-4685-4efd-8118-381223755041** ended，main读源码：actual冗余是upstream registerEntryRenderer subagent_supervisor_reply（不是messageRenderer）；newcompactformatter原生writeReply成功之后appendEntry本侧提交日志 -> “回复已提交 · delegate · run8”，不拿queued说delivered；mainentry后注册覆盖同Map，复用派发完成receipt的messageBox(Box+Text)style，request正文保留、raw/session/details/display全不改。19unitpass，root/enhancedtsc无error，但cmd pipehead掩exit控制能力只是输出佐证。**不能finalaccept用户目标**，仍第二toolresult formatter完整输出messagebody。

当前唯一active收尾run **19fb846f-e8cf-4f7a-8cf2-7644a6a9c949** executor：只compactrender.ts/enhancedmainentry/existingcompacttestexpected，success toolresult须空只entry一confirmation，error/blocked/pending短状态保留，Hostcontext.isError补正确，不改实际内容。无新tests/TDD/realreply/Hostflow/安装/MCP/index。只existing19unit一次+enhancedstatic一次，真实exitcapture。main之前派此合同特别给了exact上游intercomnativejs路径。

**attention后诊断事件**：child违规 `find / -name native-supervisor-channel* -not -path */proc/*` 经rtk全盘扫描，call05f2df296ae54260904ba426 240s。main读owned events确认call未end，不等待poll，用ps元数据精确树 **runner63252 -> bash69559 -> rtk69567 -> /usr/bin/find69571**。首检查commandstring因rtk改args未匹配，没信号；第二据确切ancestor链再TERM **仅69571**（未动runner/userHost），随后精确进程诊断确认清理。已steerrequest197e9362-0f03-49e4-a146-1a13a85fba32要求禁止再宽搜、只given installednode_modules/pi-subagents/src/intercom/native-supervisor-channel.js和directimports收尾，报告执行范围偏差，不隐瞒、不修安全框架/扩大scope。**这个queued不是已消费，只有completionresult能验**。可处置错误命令不重启child或安装/terminatehost。继续任务不能无新result就finaldeclare通过，也别因已70kturn继续派更多诊断子任务。

GLOBAL/shared/list/rootMCPban全部已接受，body建议稿仍未采用(用户只问内容)，modelfallbackuser明确先不支持；ExaMCP迁移取消未read/movecredentials。后续19fbcomplete读production两路径delta/currentexistingtest19counts/statictrueexit确保第二正文去掉，必要一精准修scope别循环realflow。最后交付singleconfirmation/freshHost/nohotreload/index、更新handoff，不commit。

## 2026-10-09 reply展示最终接受，prompt可观测方法只读研究active

reply收尾run **19fb846f-e8cf-4f7a-8cf2-7644a6a9c949 completed/mainaccepted**。actualEntry已复用派发完成messageBox、回执“回复已提交 · agent · run8”，不展开原生回复bodybox；成功tool-result(renderer context.isError权威，details.replyTo非空)空显示避免第二完整正文；error/nonreply保文本且error色，unknownreply“回复状态未确认”中性。raw native reply/session/details/isError/display/RPC/control权威未改，无新增sender/notify/permission。19existingunits/0fail/0skip，enhancedtsc真实capturedexit0（root没再跑），main读source+taskbeforetwofilediff/currenthash/日志接受。testfile前后byte相等，没有新tests/TDD。最后sourcehash compactrender d8638a2ba538ba0d5ea90c799b38e0fa0670ae85bcd5f5265465299c2ebf8f99，mainentry5770ebedf5d7e42d74eecce83ab99c97414e7df4421722a70cc1438627331186，test07774d3f1586536a86f52b3d60878cb1e59989ad7d7d6040d19539c417b74a47。证据/tmp/supervisor-reply-final/report.md/unit.log/tsc-enhanced.log/beforehash/diffs。
残余：上游writeReply成功后appendEntry为trycatch日志，若Hostjournal损坏/append失败成功tool仍无displayreceipt；不是投递失败，不为罕见非已证prod数据追加compat。本轮只正常mainHostentry展示，不承诺所有childhistory也compact。缺少新formatter直接unit授权故只旧19相关case+静态合同，未真实HostUI重启验证。此前违规全盘find69571已精确取消，命令rtk/shell都exit，不用户Host操作。所有源码实现任务已结束，无activecoding。

**当前唯一active只读调研** af0dbdd0-f864-4710-a921-f9e285ca4afe executor：用户问怎么看GLOBAL/SHARED初始prompt输出记录、确保loading。查当前Pi1.0.4内置/debug/context/export/SDKgetSystemPrompt/before_provider_request最终payloadhook是否真支持，sessionjsonl是否保存system，以及main期待shared+global、childshared+runtimechildblock无global。禁止执行模型/Hostflows/newlogger/tests/TDD/真实payload/auth/settings/session读取；用户只问办法，未授权自动采全文日志。工具README/extensions/sdk文档完整read，sourcepublic精确read；结果提供可观测方法与安全默认metadata，完整systemprompt敏感需再授权local0600/ignore不打印APIheaders。不能发明CLIflag或叫用户查不含system的session文件。通知staletitle按actualrunId。收到研究完成后main给用户具体办法/必要是否要临时diagnostic入口，**不用为了此研究另跑model验证或安装**。

## 2026-10-09 最终状态：样式与 resume title 已接受，暂无活跃任务

本节覆盖前述active/不全统一/旧review批准口径。所有已派发编码和只读任务均已返回或失败后被明确接替完成；**暂无activechild/实现pending**。不再派新review/fullsuite/真实canary，不为已完成任务继续查询status等待。用户没有授权Gitcommit/push/globalinstall/模型请求/MCP，idx仍空，所有既有dirty保留。

### GLOBAL审阅流程及文档漂移已修
run3d22b18a-b86b-4cfc-b389-b9d4d722723a completed，main读任务前副本/tmp/dispatch-35ef623a/AGENTS_GLOBAL.before.md diff接受：新完整计划写完首轮reviewer**自动且只一次无需授权**，收到结果按意见inline修订，再问执行方式或继续review；后续每轮包括成果review均用户明确授权，**无次数上限**，修订不重置首轮，SubagentDriven不视review授权。此次只规范变更没有实际新计划/首轮review派发。模型qualified先profilecandidate整体API验证不能绕过全缺/guardfail，目录availability非provider活着；30min是task组织预算非runtime超时；skills不假设恒环境0且不自动全文注入，给确path要求read；resume非空新消息，stopped不可，未承诺原live进程续跑。
额外doc收尾0c501de4-e5f3-4db0-9344-016f3816f418 completed，仅Workspace节任务前后byte范围变，main读最后确认state分支/无常规父integrate，GLOBAL最终sha a74723534901543fd55525d5b35cd0dd20b8e67fdd47b3bc1c651471c35fc326，before/tmp/AGENTS_GLOBAL.dispatch-c1b2a90a.before。保dirty/rawgit禁令。doc示例是概念性工具返回state投影，不能把pendingdispose当新action（仍仅dispose）。codingchildqueue集成，released无操作，active选status实际disposition+token，preserved/cleanupdebt独立release，reserved/allocatingruntime处理。未真实工具试验。
工具描述6c7e8366-052e-4eae-acaa-2c3d127befd1 completed/main检查去掉两个description块后代码与taskbeforebyte相同(/tmp/pi-docdrift-before/)，改中文扁平args+模型门槛+worktreechildowns/control语义；schema/logic没变。workspace/tool.ts最终sha2810abfe67f023ca47d889efa45bc4d07485c966336bf081f768d5412585911d，dispatchdescription之后resume逻辑下条另改。注意workflow Started工具result中的workspaceNotice仍旧integrate文本(当时taskonlydescription未改rawtoolcontent)，用户授权的是说明修正，不为TUI擅改rawmessage；如后续要完整指令口径再单独用户scope，不伪称所有历史/rawmessage都统一。

### 最终样式用户批准已实现
用户明确①所有subagent关联主工具调用原生色块pending/success/error，②**runtime回执包括失败/暂停/停止**无框dim保图标，③supervisorneeddecision请求维持强调正文。此前e838/19fbaccepted replyBox方案被此最新规则覆盖。style审计88671fa4completed只读，实施 **05ebade8-fe01-4f4c-803c-ae95f06bc064 completed/mainaccepted**：主entryrenderSupervisorReplyEntry与renderCompletionNotification直接Textdim无Box，所有subagent-notify状态含workflowreceipt同样式；hiddencompletedobservercompletion-notices.ts原notify(info)/去重/display门控保持且该filebyte未改，workspacereminderdim不变。所有control/reply调用短callline恢复，interrupt/reply成功结果不再整卡empty；工具只Text原生Host状态背景，call+短result不正文回显。context.isError权威保spawn/resume/interrupt/status错误和errorfg，不把failed说resumed/interrupted；保先前steer目标runId/body。request强调Box/正文保，controlnotice历史隐藏策略与技术warning/childnativepreview不本次改，不宣称全部第三方告警样式统一。只3files(mainentry/compactformatter/existingcompactunit2expect+title修改)，无新case/noTDD/rawpayload/session/details/display/RPC权限不改。**19/19 unit，enhancedtsc0**证据/tmp/subagent-style-final(unit.log/tsc.log/taskbefore/diffs/hash)，main读真实diff/source+结果接受，无真实HostUI验证。最终mainentrysha6c1a2b9f4465e4abc275f6fe21d0ff7acc57ce7168e1b4bf8a5aaf973588384e、compactsha fd8cbc15ce95034a3ad6b4488c0348053f02eb1da97bdd62593573f0fa26bacd、unitsha3a574021ff416f0463c3b47badd7951a420b5f22080a1490a220593043262bbe。

### steer目标与 resume title
steerfix965004f3已accepted：formatter漏input.runId导致subagent未知， now inputid→inputrunId→replydetails，registry title/agent +结构metadatafallback、cachemissrunid/dirlabel/identityabsent明示unknown、errorrawtext不deliveryheader；19unit/enhancedtsc0；task过程违规find/Users和find/导致240s，main精确取消ownedfind87827(runrunner77052->shell87734->rtk87825)，之后指定upstreamexactpath；报告保执行偏差，未动userHost。style最终包上述context传递不覆盖此fix。
resume只读a5e0962ccompleted找到first缺口：0.75resume正常生成newrunid，原executeControl直通未延续displaytitle，新status/notify/selector恒miss。实施3f0f27f0(Astra)overloadfailed/main核对无write，不模型自动fallback；手工显式Sol接替 **13c8fa78-abfb-4d8e-b8b0-3bda125fc9ac completed/mainaccepted**。仅dispatch/extension.ts3处(pass闭包registry→successresume确定reply.details.runId/asyncId时oldfullinput.id/runIdtitle存在记newid，新id已有title不覆盖，失败/缺id/cachemiss无猜测)与中文bugdoc docs/bugs/2026-10-09-resume-display-title-mapping.md。rawrpcResult/content/details/实际恢复/权限/model策略均未改，title-registry.ts本身与tests没改。**37actualunits pass**=dispatch34+title3，2个deepimport上游characterization被明确excluded不计pass，即Node报告skip0不表示那2passed；enhancedtsc真正exit0，/tmp/resume-title-final unit.exit/typecheck.exit/logs/before/diffhash，main读source+日志真count/exit及descriptionbyte保持接受。最终dispatchsha304aa78a17c58c33a9810bfd708a7b3e70ad32b337de3dce4990b6af142bfff8；bugdocsha2c2de6bc3480fa640d8311e1dc7c129cf1cec1f1db25d7a21d398339bd7de011。限制：仅同进程已有旧fullidtitle→publicnewid，prefix/dir/no cache/重启LRU无法恢复；started先返回前短暂空title未假发event，内部自动恢复不此路径；无真实resume/Host验证，freshHost才新code。

### 用户当前问题结论/未做事项
- 用户看var/sessions system没有GLOBAL/SHARED内容：源码证明forcedsystembefore_agent_start只requesttransformprojection不persist完整text，session存sectionsdiff，无md不证未load也不证已load。prompt研究af0dbdd0completed：无/context，/debug仅TUI，export不是forcedfullprompt；ctx.getSystemPrompt在active run可含forced，但idle_runfinally清回base；before_provider_request.payload在projection/provideronPayload层HTTP前可观测最终体，格式providerdependent；上下游后续hook仍可能改payload。**没有新增logger/metadata记录/全文dump**，user仅问方法，真正全文日志需要明确授权local0600ignore不headers/token，不私读session。mainblockshared+global/nochild，childshared+childexecutionboundary/noglobal。
- ExaMCP迁移取消、root禁MCPskillwrapper已接受，MCP现存code未拆（user仅doc禁令），cred未读/迁/轮换。
- init真实用户日志的test污染6文件已修147pass0fail1todo但**整体init未经验证**，仅helper/mainphysicalroot/旧themeglobalmix/requiredsharedfixture/旧versionTDDexpect，不建议再自动跑初始化，没修其它unknown流程，sibling1.1.0闭包已知仍未调整，不承诺pure1.0.4稳定闭包。
- agentprofilebody只TDD清理已接受，rolebody建议稿未采用（user没明确落盘授权）；delegatefrontmatterdescription仍TDD文字（上次onlybody，不擅改metadata）。list完整frontmatter29unitpass，newtool描述/renderer/GLOBAL/shared生效**需freshHost**；未执行hotreload/新产品canary/commit。用户modelfallback已说先不支持，保持startup候选无providererrorfallback。
- OptionO旧steer任务e0b29b82 session存在entry505db537，普通user1029chars已authorisedread+主independent验证。历史只内存20rawterminalroot+leaf各算，target可能正常旧组件evict，不live内存不绝对断言；没有调historylimit或恢复数据。

最终没有任何活跃子任务，不需要再派review或重复单测。用户后续新需求另行处理，当前已经完成的代码报告按这些边界交付即可。

## 2026-10-09 最新用户纠正：绿色reply工具卡要完整正文，下面dim回执左边距对齐（active）

用户截图/pi-clipboard-3d7723db...png显示绿色reply工具卡与下面dimreceipt都简短，用户明确**工具调用卡不能精简：需要目标/完整reply正文**；runtime回执下面保持短dim，绿卡和receipt是不同动作。主已澄清nativeentry“回复已提交”目前本侧journal不是child消费ACK，不能把用户以为的“子收到确认”当协议事实，此scope只display不加ACK/改delivery。此前style05eb“工具replyshort”被此新要求覆盖，未改其它工具card/所有状态receipticon dim/requestBox规范。

**唯一active实现 run0d8b63f5-15a7-4ca5-b61e-80656c602484 executor（GLM-5.3-Flash）**：onlycompact-rendering.ts/subagent-runtime.ts，两file，成功replyformatter从结构details投影fullrunid/requestid/agent/现存titlelookup +原input.message完整不truncate，error保原error文本，nonreply不变；reply entry formatterdimreceipt本体不改。existing19unit+enhancedtsconce(no新tests/TDD/realflows/配置/安装/模型)。不能因为green card完整去复冗余大runtimeReplybox。
用户追加缩进：“回复已提交”与“派发完成...”不同；main已独立readHost1.0.4 showStatus:3101 ThemedText(dim,1,0)，entrycomponent无水平补padding，当前entryrendererText(dim,0,0)造成一列差。steerrequestc303b2e2-66cb-4241-a479-c29f00fae29c交唯一writer调整replyentry Text horizontalpadding1,vpadding0，无Box/手动正文空格；visiblecompletionreceipt如同padding1可一起，在两允许file内，workspace提醒不扩大。status一次diagnostic已delivered（需finalsource确认），不要queued=done。

### 此active run违规扫描诊断
用户attentioncall5ab94208a0224b539d070732 240s，main读owned events发现**find / -path /proc -prune -o -name native-supervisor-channel* 全盘扫描**（又把node_modules真实source误读为不存在packages/pi-subagents）。本次diagnostic时command已endexit0/wall242.4s/返回5pathlines，未打印不需要的路径；**不是此前两run被cancel无输出，这次不能声称无返回内容**。因此main没有发signals或中断runner/userHost。已发steer511fba23-2f9a-4542-9d9c-14a09f28ccaa要求停widefind/只确切source，事实上formatter改无需再查sender：给定packages/pi-subagents-enhanced/node_modules/pi-subagents/src/intercom/native-supervisor-channel.js即可；立即收敛改两rendererfiles/一次unit+static/实际process偏差如实report。当前beforecopy刚存/tmp/supervisor-reply-detail-final/，还没有validfinalacceptance。原stageempty/dirty保持；noMCPskilltool/newlogger/fullinit。

后续收到0d8b63f5complete（标题可能stale）：主readtaskbefore2diff+fullinput.message包含/visible目标数据、原nativeentryformatter未改且padding1、19pureunitsactual+enhancedtsctrueexit、不新增case/noIO，indexempty，才能接受绿卡full+下方dim同padding。若缺一项focusedcorrect但不要再次10页dispatch导致漂移，多数source两行已明确。完成后user需freshHost才cachedrenderer变，不hotreload/生成实际reply来证明。除了这active任务其余style/resumetitle/global/shared/rootMCPban/list/inithelper/doc漂移都已结束接受，不再派review/真实canary。用户body建议稿仍未采用，logger方法只给口头方案未实施，modelerrorfallback取消、ExaMCP迁移取消/凭据未动。

## 2026-10-09 最新最终：reply完整工具卡与回执缩进已接受，暂无active任务

run0d8b63f5-15a7-4ca5-b61e-80656c602484 completed/mainaccepted。用户截图纠正绿色reply工具调用卡不能精简，下面dimreceipt保留。主已读taskbeforetwofilediff/finalsource/hash：formatCompactSupervisorToolResult成功reply显示真实agent/已有titlelookup/完整Run与Reply to +**完整原input.message**，不裁字/不摘要；unknown非error仍显示正文并标状态未确认，error/nonreply保原result文本。call标题完整replyTo但不重复正文。投递/消息/details/session/display/权限均未改，下方nativeentry仍本侧“回复已提交”不是child消费ACK，原formatCompactSupervisorReply函数体byte-identical。

用户说replyreceipt与workflowreceipt缩进不齐：main先readHostshowStatus ThemedText(dim,1,0)vsentryText(dim,0,0)，明确steer补充被消费；renderSupervisorReplyEntry和visible renderCompletionNotification统一Text水平padding1/vpad0，无Box/硬加字符串空格，hiddencompletionobserver原ui.notify/info路径不变。其它toolnative色块/requestBox不改。freshHost才能加载newcachedrenderer，未热载或真实UI验证，不自动发reply来试。

最终acceptedsource compact-rendering.ts SHA69e689a65cad7b0de2a8fea5a3ef0f49f8aaf32b2784fc0d614ecc478e1b6103，增强mainentrySHA0b29de1046fcdeeee064f674704014ed03fa2f6acc68f869e995379c9111d40e。证据/tmp/supervisor-reply-detail-final/{taskbefore,diffs,after.sha256,test-run.log,tsc-run.log,main-acceptance.json}。existing19unitpass0fail/0skip，未增case，无reply专项unitcoverage，enhancedstatic返回成功；**过程偏差必须保真**：越界find/242.4s已end返5pathlines(此前已记录，不能说无输出)；子使用了禁止npx --no-install tsc日志有npm更新notice，未安装/升级依赖但不能声称严格离线localtsc；额外临时虚构formatter检查越出禁止新增probe约束，不计正式unitcoverage。mainaccept为源码/已有unit检查的有效结果，非对违规过程背书，不因这些问题扩fallback/新协议/安全框架。staging空/whitespacepass，原dirty均保，无提交/秘密操作。

当前所有已派发任务已结束，无实现pending或activechild。GLOBAL/shared/systemloading/listmetadata/docdrift/reviewerpolicy/newstyle/steertarget/resumetitle/inithelper均按前述边界接受，role正文建议未用户确认不落盘，model失败fallback暂不支持，ExaMCP迁移取消保持skill且root禁MCP，credential未读/迁移/rotate。用户问查看prompt只给公开before_provider_request方法，未新logger，不把var/sessions system缺md全文推未加载。整体init真实流程仍未验证(用户只单测)。后续新要求再处理，不重复单测/重新安装/全suite/业务canary/review。
