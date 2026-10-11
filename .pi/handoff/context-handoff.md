# Pi 1.0.4 runtime 现代化执行交接（Subagent-Driven）

## 授权、规则与当前停止边界

用户明确回复 **“Subagent-Driven，同意 append”**，授权执行 `docs/plans/2026-10-10-pi104-runtime-modernization.md`，M07 三 profile 的 `systemPromptMode: append` 同时获批。首轮计划 reviewer 已完成并由主 inline 修订，修订版未再审，用户直接授权执行。**后续 review（含成果 review）每轮仍需用户明确授权，无次数上限。**不要因修订/执行自动再派 reviewer。

主只编排、技术决策、验收和 inline 改计划；production 修改由 child 实施。计划开始后持续按 DAG ready-set 推进，不能无active task停等用户，除明确阻塞。默认禁止TDD及读取任何TDD/writing-skills；不新增case，只同步既有fixture/断言，短纯测试和最终静态检查。禁止真实Host/CLI/RPC/TUI/PTY/provider/model/MCP/paid canary/init/full integration、依赖安装、hotreload、真实settings/auth/models/session/authority读取。禁止宽扫用户目录/var/.pi/sessions、reset/restore/stash/commit/push/raw worktree。

所有任务当前在同一dirty工作区（不worktree），精确WritePaths隔离。Node最低>=22.19.0；本机26.8.1仅实际版本，不额外固定26。Pi四核心1.0.4，pi-subagents0.75.0。HEAD/origin基线05a150de61c7c8665b921a365a92eda177bef864，之后未再次提交，index仍空。

## M00基线（权威）

- `docs/plans/records/2026-10-10-runtime-modernization/baseline.json`
- Arena **`/tmp/pi104-modernization-1XMAot`**，副本 `taskbefore/<repo-relative-path>`。覆盖60唯一路径（52已存在/8计划新建）及其它dirty保护；不能把git diff对HEAD全部归本轮。
- M00 run a4903550-aa8c-4bd5-8329-ee2d5c2060da 已accept。根tsconfig新增9个include（3个未有领域glob+6个未有精确入口，已有compact入口不重复），compilerOptions和旧include保持。最终tsc留M12，M00没跑。
- 旧通知断言任务110/110日志尚在，但.exit当M00读取已缺失，不能说独立验证exit。新M05B membrane实际91，不用旧110冒充。
- 原8dirty保护：handoff、runtime-membrane/title-registry/compact-rendering、两subagent测试、notification decision、现代化计划。后续合法tasks增量会扩大dirty，不能误判越界。

## DAG与当前任务状态

14可派发节点：M00–M12的13数字领域中M05拆A/B。
`M00 → M01/M02/M05A/M05B/M06/M07/M10/M11`
`M02 → M03/M09; M03 → M04; M05A → M08; 全部13前置 → M12`
Wave不是屏障，依赖满足应立即派所有写冲突兼容ready任务。M03/M04 bash-entry串联，M02/M09 doctor串联，M05B dispatch与M06入口不同路径。

### 已完成并主核对（checkbox已更新）

- **M00** baseline/TS覆盖。
- **M01** run1957a373-890c-4067-8007-5e11e7d0dbb0，4paths删除reminder链，tool_call逐字保留；unit9+26=35 pass、exit0，日志 `/tmp/pi104-m01-unit-logs/{security-gates-extension,shell-policy}.log/.exit`。shell旧reminder case删1（27→26），无新增case。范围外`test/joint-upgrade-feature.test.mjs`仍消费已删handler+要求TDD提醒，主曾拒绝该child越界改它，记录遗留过期断言；不为其恢复production reminder。M12需明确限制或主另行小scope决策，不能擅改。
- **M05A** run5fa3fb39-a5c2-4e50-b992-41d59d05990e，9paths；memory标签/S/G+类型、patch新result.ts成功schema/structuredContent/错误无结构、context snapshot schema；unit22=11/6/5 pass、exit0，`arena/m05a-unit.log/.exit`（实际exit文件名`m05a-unit.log.exit`）。未直接验证patch入口/codemode，TS待M12。主已读diff，M08可消费。
- **M06** 原c548db3d...过载失败，提前resume successor **a93b010a-6cf8-4bf2-90c4-516c7d2cc63c**后已完成，旧session同5fe5eecc.../run-0。6paths新tool-renderers工厂/typed ToolRenderers/native fallback/entry/message分离/modeTUI，snapshot安全边界保持；native13/footer45全pass，`arena/m06-{native-conversation,custom-footer}.log/.exit`（实际.exit文本`exit=0`）。主已读工厂/diff/log，TS待M12。
- **M07** rund3704e3c-bd51-48d7-9593-17563018fb7e，三profileappend/短角色body/GLOBAL组合流程和偶发失败resume指导，models/tools/inheritance/thinking不变，SHARED没改。既有test2total/pass1/todo1/exit0，不能说2pass。主已readGLOBAL和diff/最终报告。未做模型行为验证。
- **M08** run2d59b47e-15b2-4548-ba0d-62e02a18375a，3paths；公共queue依赖注入生产入口，add/delete/nonmove update完整RMW在queue；move不排队保持旧业务语义；deps可选保2参旧API，生产唯一调用方始终注入。unit14/14 exit0，`arena/m08-apply-patch.log`及`m08-apply-patch.log.exit`，主已读diff/log。
- **M11** rune14e83c5-2c1f-46bc-aa7f-bec67392901e，唯一文档public-boundaries.md（172行），主全文读取接受。不改代码、不运行测试。文档的行号会随M06等变动漂移，以源码名/契约为准。delivered仍阻塞/未实现。

### 源码/初测已完成，但主验收发现合同缺口，当前active follow-up

1. **M02最终run ec12df93-51b7-40c6-a992-e9a4bfab2c44 已完成并主接受**（delegate，原同一持久化session f2917755.../run-0）
   原7aa3caf8...流中断→68e1da41...同错→b538bf14...7/1过期schedulerfixture改后未重跑，harness拒绝→b231337d...补验8/8 exit0。主发现三项计划内缺口，resume ec12...已闭合并8/8最终接受：
   - mergeSchedulerEntry对string source原样clone，导致合法已有scheduler字符串无法收敛四资源空数组，check也只isRecord而误过；规范string为{source,...资源空}，同source去重，check识别string/重复需要ensure。
   - probeDirectory仅stat，mode000目录可stat却不可读；用access(R_OK)与stat同事实，ENOENT/ENOTDIR为缺失，其它错误保cause写前拒绝；ensure/Doctor一致。
   - 现ensure测试只改scheduler单断言，没在原8case中覆盖hideThinking缺失补默认/显式false保留/非法拒绝、skills selector合并/冲突、无r2c模板本机存在仍条件挂载。要求补到既有case（不加case）然后contact申请runner，保旧7/1和8/8日志不覆盖。
   仅M02五paths，不改计划/真实settings。主已全文read当前index/test并读最终日志：`arena/m02-ensure-unit-final-ec12df93.log` / `.log.exit`，8/8、exit0、101.282ms，最终fixture已冻结，source未再改。scheduler string归一/check重复、access(R_OK)、hideThinking/skills/r2c无template条件断言已闭合，未测真实chmod权限/Host，列限制。M02八checkbox已x，unit-runner释放。

### 当前新的ready任务已并行启动

- **M03 delegate 3d214e49-5f1a-4d9c-8d37-59629976a283 已完成主接受**：七WritePaths实际变六，renderer.ts与M00byte同；新index纯registerToolRenderer撤native注册/activation、保Skillprivatepatch唯一owner/Symbol，bashdisplay从执行剥离。日志 `/tmp/pi104-modernization-1XMAot/m03-33fc3f25/{extension,renderer,error-visibility}.log/.exit` 主全部读：3+21+47=71pass/0fail/all.exit0；delta-and-hashes.json主核对当前hash。未真实Host/工具execute/视觉/tsc。M03七checkbox全x。
- **M04 delegate1280204d-0e2c-4410-829f-53ca592ad686已完成主接受**：主全文read当前3改动源码/test、unit.log/exit0、delta-and-hashes四SHA均matched。12/12（7+5）/0skip/786.597ms，arena `/tmp/pi104-modernization-1XMAot/m04-bd5cc168/`。实现初始化空options不读Settings、每execute真实ctx stricttrust取配置、publicspawnHook先组合再overridevalidatedcwd，原ctx/env/signal保，fakeops直接覆盖最终backend/truststorage。policytest未变。task-before副本由child编辑后补建（已明示，src/test前sha来自M00，bashentry由M03完整before重构hashmatched），不是实际预先副本，记录流程偏差但没恢复production。五checkbox全x，tsc待M12。
- **M09 executor334d7125-3d49-447b-a570-10ae3b307747已完成主接受**：主read最终skills2fixture/Doctor最小diff及所有日志，skills2/2、Doctor positivepattern26/26/.exit0，scoped原生发现/项目其它scope边界闭合，case数不增、无facade/sync保留。偏差：首negativepattern未排除last真实repoTypeBoxcase实际27/27，**inspectConfiguration真repo读settings属越界，HOME隔离不能说没读userstate**。保m09-doctor.attempt1-pattern-not-effective.log/.exit，后26有效；不复跑/不生产fallback，M12必须记录。M09checkbox全x。
- **M12 executor67ac3708-e593-4e34-a56e-3a5502aa8fa1 active**，四WritePathsacceptance.md/两README/jointfeaturefixture，只fixtures/docs不prod。独占unit-runner：已一次listFilesOnly/rootnoEmit exit0覆盖入口，enhancednoEmit exit1全部11处新tool-renderers unknownargs/property/hasOwn。日志 `/tmp/pi104-m12-acceptance/logs/m12-{listfilesonly,root-noemit,enhanced-noemit}.log`，source错误集中M06。requestbbbd9d6a-773e-4651-bbc1-990426174e8f主已reply成功：继续独立compact19一次若未跑、README/fixture/docs，静态failed不可GO，释放runner后等主通知fix，再仅enhanced一次补验，root无变化不重跑。
- **M06类型owner f1f0f414-155c-4138-8fa5-aaf0a4bcd5ce完成主accept**：单文件 +11/-4局部isRecord unknownguard，无asany，after11f5bbdec18173d0d0555a64fbff97284a351a7eb5ff17950cd488de8fbebc32主hashmatched/diffread。M12已自动看到fix并补enhancednoEmit-recheck.log exit0，主read日志确认。
- M12原67ac3708...完成四files但主未最终accept，主已resume同旧session successor **cacd34ee-284d-44d9-979b-1b6e06a63042 active**：授权仅一次已有nativeconversation13 post-typefix puretest（当前唯一unit-runner），不重跑tsc/root/listfiles/compact；纠正acceptance§7‘M09越界未执行’为实际执行27/27禁case，README globalinstall误导改唯一本仓init/physicalhost、supervisor误写scheduler/steerdelivered定义/modelonlystructuredchannel误例、shellfollowuppending。四paths不扩，docs结束后释放runner，等shell实结果主再给最小docs闭合。当前M12source已覆盖root/listfiles/enhanced全部exit0，UI/模型/真流程仍未验证。
- **M09入口闭环追加 executor3f3117d4-3076-4cd2-8b18-0551a7575298 active**，唯一两新WritePaths scripts/pi-shell.zsh/test/pi-shell.test.mjs主inline加M09，修普通helper隐式--no-skills→无flag、pi-lite显式保--no-skills。当前shell flag阻止原生discovery是计划目标内真实入口缺口，不静态假称集合生效。先单独before/hash，不改M00baseline，existingfakephysicalCLI测试先contact申请runner，M12 native13释放后批准。no真实Host/CLI/模型/TDD/newcase，保持ownerenv/tools/trust，用户explicitflag原样。
2. **M05B follow-up 2dfc6804-6191-437a-ba4d-5229d3340fa3 已完成并主接受**（executor，同原858b73f3...session623389bc...）
   初版本4productionmetadata/两tests，只新增原有case断言，membrane91/scheduler21 exit0，`arena/m05b-membrane.log`/`m05b-scheduler.log`。主验收发现2处：
   - supervisor guideline把writeReply提交说成child已送达，改为本侧提交≠child收到/消费/理解，不加authority。
   - scheduler metadata.promptGuidelines覆盖了上游S/G，应先保持definition.promptGuidelines再追加本仓create/delete规则；既有case补upstreamguideline断言（不加case）。完成后contact请求两个pure测试必要一次（tsc留M12）。
   主已直接read纠正后supervisor/scheduler metadata和m05b-fix两log，membrane91/91、scheduler21/21，报告exit0；未发现独立.exit文件，真实exit须最终引用ownedcommand result（不只用日志tail）。两checkbox已x，M05B全部完成，不运行真实流程。
3. **M10 follow-up 81cae1c9-ad33-4db0-b1a7-3168d4fa6dc5 已完成并主接受**（同原a1b96ab9...session4dd4e60d...）
   初实现三paths提取controller/status聚合/generation/cleanup，parser/tail5pass0exit，watch6秒timer不执行。主发现RPC setStatus会发extension_ui_request，follow-up入口已补ctx.mode非tui时cleanup/return，不绑定watch/bus。主直接read入口、三个hash与报告全匹配：src index 3e4569c7…，entry25ecde77…，test6370d215…；复用原5纯测试，不新增/重跑/真实RPC。M10全部checkbox已x。

### 独立只读诊断active（不阻塞DAG）

**331934ba-0bd2-4963-9053-70f6bff971df executor 已完成**，报告 `/tmp/pi104-rpc-session-capability-failure-provenance.md` 主已全文读取及断言源码复核。
用户其它会话spawn报 `CAPABILITY_NEGOTIATION_FAILED ... missing: rpc:v1/session`，要求现代化后处理bug候选。主已沉淀 `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`（主文档，范围外明确用户授权记录待办，不改DAG）。来源尚未证实：候选upstream context未就绪/ready前段失败，或worktree originRoot与主启动子目录cwd不等；本轮assert/ping逻辑未变，没证据当中间态忽略。报告过强‘排除所有中间态’/‘恰好一个predicate失败’主已纠正：OR复合标签可多项同时失败，缺其它会话实际版本/首error/cwd事实不能绝对排除一切加载状态。只补非敏感现场证据再分类，不预防fallback、不现在修。

**独立调查227b62d5-a946-413a-9566-a15f2f92e445 executor已完成**，报告 `/tmp/pi104-supervisor-reply-required-provenance.md`主全文read并复核control-plane源码/tests/旧bugdoc。核心：upstream reply清nativepending，但本仓commitqueued保durablepending，消费仅terminal对账所以midrunsteer可长时间拒绝；测试有预期但不证明product无bug。主纠正报告‘全不是bug/肯定不会永久锁/用户已接受queuedonly/同构test证生产’过强措辞，沉淀 `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`，门禁本身正常、M07现象可解释、其它NOT_PENDING来源仍未知。不盲interrupt/resume绕门禁，延迟attention不当权威；本轮无controlgate改动，不修、不阻塞DAG。

## 新增用户只读问题：两处 subagent 目录

- **74bb1280-6f80-487c-ab8e-f539598dd0a4 executor 已完成**，报告 `/tmp/pi-subagent-local-directories-current-writers.md` 主全文已读。两目录仅metadata，当前0.75标准artifactDir=project写`.pi/subagents/artifacts`，最新mtime匹配本轮多个runID且当前task文件增长；`.pi-subagents`为0.47迁目录前旧世代，未发现当前标准writer，历史artifact最新8/26。退役debugtrace在新目录、旧rootfixture来源只是签名/日期候选，不据此确证无用/历史实际版本。当前project产物无内建retention；不自动清理，旧目录可能旧resume/audit引用。报告对config读取/某些docs仅分段阅读与派发要求有偏差，不能宣称全部遵循，不再扩大读取。本轮所有只读调查均返回，不阻塞M12。
- 用户明确授权调查 `.pi-subagents/` 与 `.pi/subagents/` 是否现runtime仍写/历史遗留。只精确两个目录的无内容metadata（不follow symlink/读transcript/session/result/authority），写自有tmp批量脚本统计type/size/mtime/runID对应，结合当前0.75 artifact/config/writer源码定位。禁止删除/清理/真实settings/其它.pi/var/sessions扫描、Host/model/test，不能仅mtime旧就判没用。
- 本任务不阻塞modernization。新的 action:list 回执仍为父runtime缓存旧profilefrontmatter（delegate还replace/TDD描述），不据此回退M07已授权磁盘append；fresh Host后才加载新配置，本轮不热重载。

## unit-runner与supervisor处理（重要）

容量1包含所有Node测试+tsc。代码可并行；当前follow-up仅M02/M05B需要测试，M10完成无需资源。**unit-runner空闲，所有生产writer/测试已结束**。M09shellowner3f3117d4-3076-4cd2-8b18-0551a7575298已完成主验source/hash/diff/log：scriptsSHA67642179…/testd878f3df…，`/tmp/pi104-m09-shell-close-lxj4iz/logs/pi-shell-unit.log/.exit`13/13exit0/7999.573ms，正向pattern排裸pi非bypass（14existing仅13run），仅假CLI不真实Host。M09追加checkbox已x。**M12 successor c86e2e99-3824-40a3-b05b-0918af7039b1已完成，主读最终acceptance/README/hash/native13/13 post-typefix，根/增强/listFiles全部exit0，计划M00–M12全部checkbox已x，现代化在授权范围内收口接受**；仍明确真实runtime Skill发现需fresh shell/Host，jointfixture只syntax未运行，M07/M10报告证据非独立exit，M05B无.exit等限制。无commit/freshHost/三TODO未实施，不自动成果review。之前主调度偏差不重测。

attention通知往往在reply成功后延迟到达。**reply已成功且pending空不意味childpaused/failed，不要立刻resume，不要重复status作为等待。**主曾多次多余pending/steer/status/resume、还误再resume c548旧run被live a93...session owner拒绝；owner门禁正确，不创建另一个session并发writer。仅真正blocked/failed需诊断一次，已回复后无新阻塞就继续独立工作/结束turn。

supervisor replyTo必须精确抄：曾4e962e26误写4e962f26，SUPERVISOR_REQUEST_NOT_PENDING不是runtime故障。批准测试需真实log/exit不能把queued回执当child已消费。完成消息标题仍经常stale（同agent串旧title），**以Retention-managed目录runID/正文实际报告映射任务**，不以通知title归因。

## 后续主应做

1. 收到M02/M05B/M10完成后读真实diff/log与合同，不只看harness‘satisfied’。M02完成立即派M03+M09并行，M03完成立即M04。
2. 全部13前驱产物accept后派M12（only acceptance.md+两README）。最终tsc root/enhanced/listFilesOnly统一一次，在unit-runner空闲且全部writer结束时做，失败按owner最小修后重新必要check，不全矩阵。M12不能偷修production；主另派精确owner。主执行中发现joint-upgrade-feature直接import M09待删scanner且调用M01已删handler，不能留下必炸import。**主已inline纳入M12额外WritePath test/joint-upgrade-feature.test.mjs**（现有case数不增，只同步两个被删消费者，不恢复facade；不运行该file真实工具/CLI/provider流程，仅静态/语法核对且标未验证）。M12开始前单独冻结该非敏感文件副本补充到arena，不覆盖M00baseline。此前M01child拒越界仍正确。
3. 当前plancheckbox M00/M01/M02/M03/M04/M05A/M05B/M06/M07/M08/M09/M10/M11完整x，仅M12未完成。新增TS尚未tsc不能最终称全绿。
4. 独立RPC诊断若bug写非敏感TODO/issue记录，用户明确完成modernization后再修；不得现在加入任务。若中间态需证据才能忽略。

## 统一后续 TODO 已落盘

用户问“之前遗留三项记todo了吗”，主已承认此前分散，不假称已有统一表；现新建 `docs/todos/2026-10-10-runtime-followups.md`：系统空闲通知、纯dispatch回执triggerTurn选择性关闭、heartbeat/orphan清理覆盖三条全部未勾选，不纳当前DAG/不自动执行。附两独立RPC/supervisor bugs文档链接，明确三项暂缓与provenance前提，不把全child心跳当事实。此文档用户明确要求记录，作为M00后额外授权docs需M12保护，不判任务越界。

## 保留背景：前序升级与其它结论

- F0–F6试用六项修复已完成/pushed，不重复执行。counts87/26/new47+reg80/90/15；F6 current176/min新57+pattern48，两Node静态4unique5calls历史偏差已记录。T3关闭，T5只renderer错误可见性，不修provider。
- AGENTS_GLOBAL仅父/main runtime注入，SHARED完全角色中立；根禁止MCP，Exa迁移取消凭据未读/迁/轮换。hideThinkingBlock=true模板+本机已改0600，enabledModels未动。共享template移除r2c但本机脚本条件挂载。
- title/list/reply/style前序dirty保：原message透传、title只稳定runID/官方asyncDirUUIDlookup，不按agent猜；resume newrun继承旧title；list显示Available agents+name/description，完整frontmatter仍模型。工具原生三态色块，runtime回执dim无框，requests强调，reply绿卡完整正文，下方本侧提交dimreceipt不宣称消费。
- `/tmp/pi-main-child-physical-host-unification.md`：标准Node+rootphysicaldist/cli.js/SDK同源四peer1.0.4；current主argv被process.title改写只有原生fd/env等佐证，不夸模块实证；旧全局/opt/homebrew/bin/pi npm0.87.1仍可绕用（用户问卸载但未确认操作）。
- `/tmp/pi-managed-worktree-integration-queue-current.md`：repositoryId每仓durableFIFO最多1inflight，rebase+merge--ff-only，child publication allowed queue/receipt/proof/released成功门禁，父integrate拒绝；1.0.4真实多child未验证。
- `/tmp/pi-heartbeat-parent-death-orphan-cleanup-current.md`：静态15s续60slease、5swatchdog，完整绑定managed/coding mainSIGKILL约45–65s只SIGTERM runner；generic/绑定失败无保护、独立bash后代不清理，无真实kill实验。不能继续用‘全child均heartbeat清理’作已证事实。未修，独立后续。
- `/tmp/pi-reviewer-tools-supervisor-boundary.md`：tools有效allowlist，intercom bridge先追加contact_supervisor再计算allowlist，prompt-runtime注册model-only非requiredextension旁路；ceiling可再约束，非安全沙箱。
- `docs/decisions/2026-10-10-idle-system-notification.md`：用户确认agent_settled+各已登记run status不活跃即通知（paused/终态都不活跃），不等成功/proof/workspace/消费；唯一tool登记+实时status，不依赖本地计数。实现暂缓，heartbeat原假设经审计发现限制待后续验证。macOSosascript可发但常驻受系统设置。
- 同decision记录纯派发receipt可只关triggerTurn，消息仍入context/toast/投递ACK，不全局抑制真结果/失败/批量；上游报告‘必须入会话/leafID首次出现’被主纠正（本仓Started已给childID）。只是方向，未实施。
