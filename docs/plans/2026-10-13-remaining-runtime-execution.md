# 遗留 Runtime 能力统一执行计划

> **给执行 agent：** 必须逐任务执行本计划，以 `- [ ]` 跟踪。用户选择执行方式前不得实施；本次额外 reviewer 已完成，修订后不自动再次 review。

**目标：** 完成受控 session 准入加固、统一三类后台活动展示、scheduler 即时刷新、纯派发回执选择性不唤醒、可见空闲系统通知和隔离父死 heartbeat 验收。RPC/supervisor 的未证实个案单列证据阻塞，不冒充生产修复。

**架构：** 本仓 session-owner 保护受控 interactive launcher/extension，不修改上游，不宣称覆盖直接 CLI/独立 SDK。enhanced package 是唯一 footer/Alt+O owner；根 feature 提供 presenter；idle 在 package 的派发 owner 内登记 ID，按现有 RPC status 查询，不共享 footer 的有限 history。通知、展示和 heartbeat 各有独立验收，不造第二调度器、sender、authority 或 daemon。

**技术栈：** Node >=22.19.0 原生 TypeScript；Pi 1.0.4；pi-subagents 0.75.0；scheduler 0.1.9；Node test、fake provider、隔离实际 Pi 进程、macOS osascript。

## 已确定决策与全局约束

- 不修改上游、node_modules 源码、vendor，不维护依赖 fork/patch，不自动提工单。
- session owner 只保护本仓 launcher 注入的 interactive extension；直接物理 CLI、无扩展 SDK、RPC/JSON/print 不在此保证。不为复制 session、hardlink、NFS、跨机器扩范围。
- 启动 reservation 已实现，不重复造锁。运行期 resume 目标原子占用须先经 S1g 验证合法 target；new/fork 的新 ID 不存在于 before 事件，不伪造该时点的目标身份。ownership 冲突取消须发生在旧 session teardown 前。
- 未取得目标并不释放旧 owner；reload/tree 不释放；ESRCH-only 回收、EPERM/坏记录 fail closed、只释放自身ownerId+PID。已有 registry guard 陈旧人工处理，不新增盲删除。
- scheduler store/lock 并发修复不在本批；受控准入不被宣称覆盖所有绕过入口。实例查询成功不保证跨Host最新视图。
- 正常独立 Host 和 reload/new/resume/fork 是 footer 范围；人为同进程多Host共享bus unsupported。token保护本地闭包/注册，事件无generation则不凭空读该字段；合法同session任务reload后的完成仍应接收。
- 所有TUI摘要、ANSI/control清理、截断、换行仅在renderer，raw messages/results/events/details不改。scheduler现有安全膜/模型侧预算保持原合同，不因显示取消。
- 通知必须实际可见：agent_settled且当前主会话登记subagent全部不活跃，paused/终态算不活跃；running/queued/start/resume/unknown/error不发送；不等待workspace、ACK、任务成功或消费回执。
- 用户授权隔离测试主Host SIGKILL→观察child自退出。只kill当前fixture父PID，绝不kill本会话/真实业务/未证明身份进程；不补杀child后冒称通过。未退出时保留现场并申请后续清理，不放任未追踪残留。
- 上述真实验收是本轮新授权，仅覆盖I4/H2；`2026-10-11-runtime-followups.md` 的禁止真实实验条款仅描述历史调查阶段，不覆盖新隔离验收。其余任务不顺带启动真实Host/网络/通知。
- 不使用TDD/RED/相关skill；实现后补合同测试。数据来源先分类：合法public链才认production；fixture异常只修fixture；未知fail closed。
- 不读真实settings/models/auth/credential、完整session或authority正文。自生成fixture可读并标fixture，日志只记录允许字段。不stash/reset/clean、不提交/push；原dirty现场保护。

## 执行门禁及任务终态

设计不确定的工作先做有限 exploration gate：输出精确函数签名、身份/生命周期、样例、写路径和验证命令，父层inline核对冻结后才派发coding。门禁不是让实现者临时猜接口，且不会自动反复调查。

每项终态为 `implemented | verified | closed-unconfirmed | blocked-upstream | blocked-evidence | blocked-environment | not-applicable`，记录 `taskId/status/evidenceLinks/commands(exitCode)/unverified/nextAction`。blocked可使DAG交付记录收口，但绝不计为功能完成；特别I通知、session竞态和Q唤醒不得用关闭记录替代已实现。若gate不可行，本分支保留blocked，其他独立分支继续；Z0报告partial并请求解除具体阻塞。

## DAG / Deps

```text
B 基线
├─ S1g session目标合同 ─ S1a registry事务 ─ S1b lifecycle ─ S1v回归 ─┐
├─ F0 事件/加载合同 ────────────────> F2b subagent ─────────────┤
├─ F4g刷新合同 ────────────────────> F4a ─ F4b ────────────────┤
├─ F1协议/包出口 ──────────────────┬─ F2a迁移 ─ F2a-v ─ F2b ───┤
│                                  ├─ F3 bash观察 ──────────────┤
│                                  ├─ F4a ─ F4b ────────────────┤
│                                  └─ F5a布局 ─ F5b详情 ────────┤
│                                                               v
│                                              F2b-v后 F6接线 ─ F7验收
├─ I1登记/status合同 ─ I2纯controller ─ I3派发接线 ─ I4可见验收
├─ Q1 selector/options合同 ─ Q2接入 ─ Q3通知回归
├─ H1实验harness ─ H2实际SIGKILL
├─ R1 RPC字段证据 ─ R2处置记录
└─ V1 supervisor字段证据 ─ V2处置记录

S1v / F7 / I4 / Q3 / H2 / R2 / V2 ─ Z 最终账本
```

F1不依赖F0（协议可独立验收）；F2b消费F0与F2a-v的迁移回归产物。F4g只消费SDK/adapter事实，与F1并行；F4a等F4g与F1，F4b等F4a。I3与Q2同写dispatch/membrane时用独立worktree或串行publish，不伪造功能依赖。

## Waves 与资源

- Wave 0：B。
- Wave 1：S1g、F0、F1、F4g、I1、Q1、H1、R1、V1（B后ready）。
- Wave 2：S1a、F2a、F3、F4a、F5a、I2、Q2、H2、R2、V2（各前驱完成即派）。
- Wave 3：S1b、F2a-v、F4b、F5b、I3、Q3。
- Wave 4：S1v、F2b、I4。
- Wave 5：F6。
- Wave 6：F7。
- Wave 7：Z。

关键路径：B→F1→F2a/F4a/F5a→各source/detail→F6→F7→Z；I/Q/S接口闭合可能另成关键路径，不承诺固定150min。每次派发<=30min预计组织预算；I3/H1超预算先拆fixture/Host接线验证，不打包实现+真实实验。Wave不是屏障。

Resources：静态阅读可并行；`unit-runner`容量1覆盖tsc和纯Node单元/fake-TUI回归；真实Host harness（虽由node --test启动）只占独立`visible-host`容量1，可与不写同文件的unit回归并行，Host任务不同时重复执行tsc/全仓回归；manifest/lock/tsconfig由F1单writer；同文件并发隔离worktree；`visible-host`覆盖I4/H1p/H2/F7视觉部分；`session-registry-fixture`各任务独立临时根。禁止未经审计运行npm test或all-integration；.integration.mjs必须显式调用。

## 通用任务结构

下列WritePaths均仓库相对精确路径，Create/Modify在Files中注明；Test指实施后验证。每任务都执行 `git diff --check`，保存真实exit，不用管道隐藏失败。静态gate只做精确文档/source核对，不运行业务。共同停止条件：发现敏感数据、越路径、上游修改需要或fixture污染，停止并contact_supervisor。

### B：新执行基线

**Deps：** none。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-remaining-runtime-baseline.json`。
**Consumes：** git HEAD/index/status和package metadata。已知计划输入五条：三份原文档、`docs/plans/2026-10-13-remaining-runtime-execution.md`、`docs/plans/records/2026-10-13-legacy-plan-review.md`；另有本次review结果若父层保存，须在派发合同精确声明，不能宽泛忽略docs dirty。
**Produces / 验收：** HEAD、版本、index、脱敏路径分类、上述输入状态、资源授权投影；历史baseline/acceptance不覆盖，不要求删除计划dirty。
- [ ] 查status/index/HEAD及Node/Pi/subagents/scheduler metadata，未知dirty上报。
- [ ] 写JSON并执行 `node -e 'JSON.parse(require("fs").readFileSync("docs/plans/records/2026-10-13-remaining-runtime-baseline.json","utf8"))'`，预期exit0。

### S1g：受控 resume 目标准入合同（只读gate）

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-session-switch-contract.md`；Read `src/session-owner/{contract,registry,lifecycle,extension}.ts`、SDK `agent-session-runtime.js`、before-switch types、现有session-owner tests。
**Produces：** `reserveSwitchTarget({store,ownerId,pid,source,target}):Promise<{decision:'reserved'|'blocked';reservationId?:string;reason?:string}>`、`commitSwitchTarget`、`abortSwitchTarget`的冻结签名/字段/调用顺序，只有可行字段才写实现资格。
**方法：** resume事件的targetSessionFile先规范化并仅有界读取fixture/header身份，不用SessionManager.open探测；guard内验证自身source与所有live records，再同时保留source+pending target。重复同owner target可幂等；另一owner同PID仍冲突。new/fork无目标ID不能声称前置claim，保持新ID语义与源占用。普通既存header可验证的resume进入原子reservation；外部import的destination尚未存在且before事件不提供source header/ID，须显式cancel并单列blocked-upstream，不因该特殊路径阻塞可实施的resume、不宣称import完成。拒绝说明区分目标身份不可验证与另owner占用。重点核实after-before取消/打开失败如何rollback pending：无公开结果hook则保留source+pending fail closed，明确重试自身同target/退出后恢复，不虚构自动rollback。
- [ ] 给出事件字段/首个mutation时点/所有合法identity函数的精确证据。
- [ ] 列所有before-handler取消和open失败分支，冻结可支持矩阵与测试。
**停止：** 无法原子保留source+target或事件缺目标则blocked-upstream；不把list→check当CAS，不修改上游，父层修订资格。该blocked不能记“session独占已完成”。

### S1a：registry目标事务

**Deps：** S1g冻结可实施。**Resources：** unit-runner。
**WritePaths / Files：** Modify `src/session-owner/registry.ts`、`src/session-owner/index.ts`；Test Modify `test/session-owner-registry.test.mjs`。
**接口：** 消费已核实 `docs/plans/records/2026-10-13-session-switch-contract.md` §3–4的精确 `SwitchIdentity/SwitchTarget/SwitchReservation`、reserveSwitchTarget/commitSwitchTarget/abortSwitchTarget API及v1 optional reservation schema。新字段缺席代表legacy null、畸形不fallback；reserved同时占source+target，committed/aborted receipt仅幂等不占资源。复用private guard，validate+publish同临界区，startup session-id也识别pending target cwd/id；不新造guard死锁回收。原update省略字段保留live reservation且不可一般update覆盖。
- [ ] 实现自身owner校验、target冲突、幂等token、commit/abort，仅改自身记录。
- [ ] 实现后覆盖两owner争同target、same PID异nonce、自身重入、旧tokencommit/abort、ESRCH/EPERM/坏记录。
**命令 / 验收：** `node --test test/session-owner-registry.test.mjs`、`npm run typecheck:root` exit0。未知record不能写覆盖。

### S1b：lifecycle绑定

**Deps：** S1a。**Resources：** unit-runner。
**WritePaths / Files：** Modify `src/session-owner/lifecycle.ts`、`src/session-owner/extension.ts`、`docs/session-owner.md`；Test Modify `test/session-owner-extension.integration.mjs`、`test/session-owner-contract.test.mjs`。
**接口：** 消费S1g核实记录§2/4/6：目标首行由public bounded reader验证（16KiB、canonical path/header cwd/id），不能调用SessionManager.open探测或私有全文件parser。beforeSwitch显式 `{cancel:true}`不是throw取消；shutdown transitional保留source+pending，session_start从持久plain receipt取得输入并同guard重新验证commit；reload保留pending，quit只自身。无公开结果hook不自动abort，commit失败请求有序shutdown，不靠session_start返回cancel伪称提前拒绝。new/fork按新ID后置commit；external import缺可验证target header显式cancel并记录unsupported（上游缺字段），不扩全入口。
- [ ] 替换现有list/check，保留source owner及guard故障fail closed。
- [ ] 验证冲突取消旧session不动，先claim后open调用顺序、reload、quit、cancel/open失败残留限制。
**命令：** `node --test test/session-owner-contract.test.mjs test/session-owner-extension.integration.mjs`，root typecheck。
**停止：** event无法完成commit/abort合同回S1g，不靠session_start伪报提前拒绝。

### S1v：受控入口回归

**Deps：** S1b。**Resources：** unit-runner、隔离session-registry-fixture。
**WritePaths / Files：** Modify `test/session-owner-wrapper.test.mjs`、`test/session-owner-runtime.integration.mjs`（实际存在，仅读确认后修改）；Create `docs/plans/records/2026-10-13-session-owner-acceptance.md`。CLI脚本无需求不改。
- [ ] 执行 `node --test test/session-owner-registry.test.mjs test/session-owner-wrapper.test.mjs test/session-owner-extension.integration.mjs`。
- [ ] 审计现有PTY fixture隔离后显式执行 `node --test test/session-owner-runtime.integration.mjs`，不读用户配置，使用临时HOME/sessionDir/registry。
**验收：** -c/-r/--session/session-id/fork已有startup矩阵、runtime双resume目标竞争、reload、自退出；现有同目标race不可验证时明确blocked，不谎称全局。

### F0：单Host事件与加载事实

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-background-activity-ownership.md`；Readfooter实际订阅、SDK resource-loader公开发现逻辑、pi-shell导出agentDir，不读settings。
**Produces：** 同Host当前session事件接受表、缺sessionId拒绝、旧闭包退订、reload已有任务继续观察；local generation仅闭包元数据。确认受控PI_CODING_AGENT_DIR/pi/extensions自动发现新root入口；禁用extensions则仅explicit package standalone，不悄改settings。
- [ ] 完整核查SDK docs/extensions.md、tui.md、rpc-extension-ui.md及相关examples、actual discovery源码。
- [ ] 冻结加载顺序/退订表；如目录发现不成立则blocked-environment，请父层决定显式入口注入，不写last-wins。

### F1：协议、package export和类型覆盖

**Deps：** B。**Resources：** manifest-writer、unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/tui/background-activity.ts`、`packages/pi-subagents-enhanced/src/tui/index.ts`、`src/background-activity/index.ts`、`test/background-activity-registry.test.mjs`；Modify `packages/pi-subagents-enhanced/package.json`、根`package.json`、`package-lock.json`、`tsconfig.json`。
**接口：** 详细ActivitySource/Registry/HostScope/factory签名消费footer子计划公共协议。根只 `import ... from 'pi-subagents-enhanced/tui/background-activity'`，package exports指src/tui/index.ts，根依赖 `file:packages/pi-subagents-enhanced`；不得根深引package src。本地dependency接入使用npm正规安装，仅官方registry，不能手改node_modules源码；若依赖解析需联网/未授权升级停止，保持pinned版本。
- [ ] 实现协议/registry与export，只导出已创建模块。
- [ ] 增root tsconfig include `src/background-activity/**/*.ts`、`pi/extensions/background-activity.ts`、heartbeat fixture由后续任务独立typecheck不预export不存在源码。
- [ ] 实现后测available/stale/unavailable、旧dispose、新注册幂等、raw引用；`node --test test/background-activity-registry.test.mjs`、`npm run typecheck`。
**验收：** 根bare package export与isolated package消费均解析；无根反依赖、独立package可standalone。锁文件只允许本地依赖接入差异，不升级其它包。

### F2a：机械迁移

**Deps：** F1。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`；Modify `packages/pi-subagents-enhanced/extensions/custom-footer.ts`、`test/custom-footer-subagents.test.mjs`。
**接口：** `createFooterRuntime(pi,dependencies)`保留现状，entry只SDK/TUI注入与唯一Alt+O注册，runtime唯一setFooter，不添加root presenter。
- [ ] 迁移实际entry职责，不改poll/native trusted/draft；运行 `node --test test/custom-footer-subagents.test.mjs test/subagent-native-conversation.test.mjs`、package typecheck。
**停止：** 迁移要改浏览器状态语义时停止，避免机械迁移变重写。

### F2a-v：迁移调用方同步与独立验证

**Deps：** F2a代码交付。**Resources：** unit-runner。
**WritePaths / Files：** Modify `test/custom-footer-input.integration.test.mjs`；其余F2a三个文件仅读，需生产修复返回F2a。
**来源与方法：** 迁移将named display/input helper从entry移至package footer-runtime并改为TUI依赖注入；该测试仍import entry，属于本次机械迁移遗漏的调用方接线，不保留entry re-export facade、不延至最终F7、不删输入断言。全文核caller新签名，精确改import和deps参数；若还有scope外caller则先上报父层扩精确测试范围，不隐式compat。
- [ ] 实现后运行 `node --test test/custom-footer-input.integration.test.mjs test/custom-footer-subagents.test.mjs test/subagent-native-conversation.test.mjs`、package typecheck、diff check。
**验收：** Esc/draft/导航/controller既有行为保持，此阶段尚未采用统一详情新交互产品行为；没有production兼容。F2b只有F2a-v通过后才派发。

### F2b：subagent provider

**Deps：** F0、F2a-v（消费已完成迁移和调用方回归）。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts`、`test/subagent-activity-provider.test.mjs`；Modify package `src/tui/index.ts`、`src/tui/footer-runtime.ts`。
**接口：** `createSubagentActivitySource({browser,renderDetail,subscribe}):ActivitySource`，snapshot纯投影、detail仍package trusted native读；根不直接读取session。
- [ ] 按F0验证session与闭包token，manager弱引用/session plain roster；合法reload相同session完成不能被虚构generation拦掉。
- [ ] `node --test test/subagent-activity-provider.test.mjs test/subagent-session-browser.test.mjs test/pi-subagents-browser-adapter.test.mjs test/subagent-native-conversation.test.mjs`、package typecheck。
**验收：** root/leaf不重复、unknown不成功、recent20、旧闭包失效、fresh恢复限制保留，不宣称shared bus多Host。

### F2b-v：subagent provider 的旧fixture同步与验证

**Deps：** F2b代码交付。**Resources：** unit-runner。
**WritePaths / Files：** Modify `test/custom-footer-subagents.test.mjs`；F2b四个文件仅读，有production缺陷返回其owner。
**方法与验收：** 旧fake manager缺getSessionId、事件缺sessionId属于非production合法身份，只修fixture为真实manager/session一致的UUID/file双形态；旧global symbol直接存取改为同manager同session reload保留、其它manager/session不串的行为断言。纯显示/trusted/native/draft/input等原验收保留，不加productionfallback、不按预测写已运行失败。显式执行 `node --test test/subagent-activity-provider.test.mjs test/custom-footer-subagents.test.mjs test/subagent-session-browser.test.mjs test/pi-subagents-browser-adapter.test.mjs test/subagent-native-conversation.test.mjs`、package typecheck。F6等待该验证而非仅F2b源码。

### F3：bash观察source

**Deps：** F1。**Resources：** unit-runner。
**WritePaths / Files：** Modify `src/bash-async/contracts.ts`、`src/bash-async/controller.ts`、`src/bash-async/index.ts`、`pi/extensions/bash-cwd.ts`；Create `test/bash-async-activity.test.mjs`。
**接口：** controller `subscribe(()=>void):()=>void`；public `createBashAsyncActivitySource(controller,deps):ActivitySource`。唯一jobs Map，listener独立try/catch，无send/cancel语义修改。
- [ ] jobs.set/delete/archive/reset/branch/shutdown收束invalidate；active无streaming，terminal原content+typed delivery。
- [ ] `node --test test/bash-async.test.mjs test/bash-async-activity.test.mjs`、root typecheck；验证UI退订不abort、accepted不是消费ACK、raw引用未变。

### F4g：scheduler owner/observer合同gate

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-scheduler-observer-contract.md`；Read adapter、SDK createToolContext、upstream tools.js/index.d.ts。
**Produces：** `SchedulerRefreshOwner={manager:object;sessionId:string;epoch:number}`；工具execute进入时、await原调用之前捕获owner，校验manager/id为当前，hook传该token而不是late tool ctx重新捕获新epoch；timer固定当代token；完成后token三字段全等才发布，shutdown先epoch失效再清缓存。只读observer为 `{snapshot,subscribe,detail(taskId)}`，detail内部capture token并受控get，source不拼token。mutator在flight期间完成需置同代补刷标记，flight收束后合并一次重读，不drop实际变更、不新增timer，shutdown丢弃旧代标记。
- [ ] 核对公开ctx.sessionManager/getSessionId身份与reload事实；失败blocked-upstream，不删安全门。
- [ ] 冻结`SchedulerActivityRecord` status为 `pending|success|error|running`（正常summary缺状态返回pending），get结果公开 `AgentToolResult<unknown>`。
**验收：** 合同有fresh ctx/同manager正例、原操作late完成后不能发布新epoch、不同session反例、畸形JSON与No scheduled tasks分开。

### F4a：刷新owner与typed observer

**Deps：** F4g、F1。**Resources：** unit-runner。
**WritePaths / Files：** Modify `src/task-scheduler/adapter.ts`、`test/task-scheduler-adapter.test.mjs`；Create `src/task-scheduler/index.ts`。
- [ ] 实现F4g capture-before-await token与单飞/同代合并补刷，mutator完成不能因旧list在途而丢弃刷新，保留initial/30秒唯一timer。
- [ ] raw text JSON解析前作大小/text/details安全校验及scan，不把boundedResult截断结果反解析；缓存仅id/name/type/schedule/enabled/lastStatus/nextRunAt/runCount，不保存prompt。metadata超限/扫描异常stale或unavailable，不把正常pending当坏fixture；renderer清ANSI不写回raw。
- [ ] capture受控scheduler_get wrapper供detail调用，原有模型侧结果和RPC status不变。
**命令 / 验收：** `node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs`、root typecheck；fresh ctx、late epoch、pending、空/坏JSON、secret refusal。

### F4b：scheduler source

**Deps：** F4a。**Resources：** unit-runner。
**WritePaths / Files：** Create `src/task-scheduler/activity-source.ts`、`test/task-scheduler-activity.test.mjs`；Modify `src/task-scheduler/index.ts`、`pi/extensions/task-scheduler.ts`。
**接口：** `createSchedulerActivitySource(observer):ActivitySource`读取adapter typed cache；detail仅受控get；TUI publisher不新timer。
- [ ] status语义：pending等待触发、running仅观察到投递、success上次投递成功不是业务完成；enabled不代表运行。
- [ ] `node --test test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs`、root typecheck。
**停止：** 需要raw store/实时status注入则超范围，不扩大上游facade。

### F5a：纯布局

**Deps：** F1。**Resources：** unit-runner。
**WritePaths / Files：** Create `src/background-activity/layout.ts`、`test/background-activity-layout.test.mjs`。
**接口：** footer子计划 `renderActivityRows` 与 `ActivityGeometry`；visibleWidth，类型/状态分列，主行预算terminalRows-6，详情固定reserve4。
- [ ] 三类各两项、CJK/emoji/ANSI、width0/1、窄高、summary+Alt+O可达验收；`node --test test/background-activity-layout.test.mjs`、root typecheck。

### F5b：详情壳与presenter

**Deps：** F5a。**Resources：** fake-tui、unit-runner。
**WritePaths / Files：** Create `src/background-activity/detail-controller.ts`、`src/background-activity/presenter.ts`、`test/background-activity-details.test.mjs`；Modify `src/background-activity/index.ts`。
**接口：** `createActivityPresenter(bindings,deps):MountedActivityView`不调用setFooter；detail key/source handle/session token/request epoch严格匹配；x/source invalidate/theme重新请求detail，晚回dispose，scroll anchor保留。
- [ ] 静态margin.bottom=4，不依赖options函数动态更新；`bodyRows=terminalRows-4`已经预留overlay下方详情footer最多3行+separator，不能再扣同一footer。overlay内部公共标题占用可仅扣其实际行；根自有viewport支持bodyRows0，不改package已有viewport。
- [ ] state为closed/open/loading/too-small：terminalRows<=4不挂overlay，draft/editor不切换；打开中变小保留可关闭输入，不反复remount；恢复后用户可重开。
- [ ] Alt+O/Esc只关闭不传播editor；navigation repeat/release、wheel、unknown吞掉；`node --test test/background-activity-details.test.mjs`、root typecheck。

### F6：唯一owner握手

**Deps：** F2b-v、F3、F4b、F5b、F0。**Resources：** unit-runner。
**WritePaths / Files：** Create `pi/extensions/background-activity.ts`、`test/background-activity-runtime.integration.mjs`；Modify `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`、`packages/pi-subagents-enhanced/extensions/custom-footer.ts`、`src/background-activity/index.ts`。
**接口：** package runtime通过现有 `pi.events.on(channel,handler)`取得unsubscribe，emit ready/request/register；协议在package出口，根entry只提供factory。shutdown token先失效再逐个unsubscribe、owner-close；同registrationId幂等，旧unregister不删新handle。setFooter与Alt+O只由package entry/runtime拥有；shortcut无unregister须按generation闭包委托当前view。
- [ ] owner-first/publisher-first、同IDready、多source、presenter替换/fallback、旧ctx/late poll/detail、RPC零terminal调用。
- [ ] `node --test test/background-activity-runtime.integration.mjs test/custom-footer-subagents.test.mjs test/pi-subagents-enhanced-package.test.mjs`、`npm run typecheck`。
**停止：** 发现discovery未加载返回F0，不读settings临时修改、不得第二setFooter。

### F6-package：同步公开出口的 package 校验器

**Deps：** F1 manifest export已实现。**Resources：** static-evidence；最终package测试与F6共享unit-runner串行。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/scripts/verify-package.ts`。
**方法 / 验收：** 硬编码expectedExports仅新增已声明的 `./tui/background-activity` 精确出口，并按脚本现有规则纳入实际已创建TUI公开模块tarball必备路径。不放宽escape/upstream-drift/canonical-export防线，不任意接受manifest；F6完成后显式package tests及verify:package验证，不重造library在scripts目录。

### F7：footer验收与文档索引

**Deps：** F6。**Resources：** unit-runner、visible-host（视觉单独执行）。
**WritePaths / Files：** Create `docs/architecture/background-activity-display.md`、`docs/plans/records/2026-10-13-footer-acceptance.md`；Modify `test/custom-footer-input.integration.test.mjs`、`test/custom-footer-fullscreen.integration.test.mjs`、`packages/pi-subagents-enhanced/README.md`、根`README.md`（只新增用户入口/exports链接）。
- [ ] 显式 `node --test test/background-activity-runtime.integration.mjs test/custom-footer-input.integration.test.mjs test/custom-footer-fullscreen.integration.test.mjs`、package verify/typecheck。
- [ ] 在隔离Host用同I4 deterministic provider/fixture展示三类，只读导航/窄宽/draft；不自动创建真实用户任务；当前用户Host仅允许用户手工观察。
**验收：** fake不替代视觉；文档链接/export和unsupported矩阵明确，不新增恢复引擎。

### I1：idle接点探索冻结

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-idle-notification-contract.md`；Read dispatch `extension.ts` coding/generic成功返回、executeControl resume、entry `subagent-runtime.ts`已有rpc变量、SDK agent_settled/input/session生命周期、upstream rpc status。
**Produces：** exact owner及DI：在package typed tool execute开始调用`onActivityStart(ctx)`得到token，成功handle `details.runId` 和 resume `details.runId??details.asyncId`登记；workflow root/leaf来自spawnWorkflowLeaf已获真实binding须完整登记（不是只盯一个leaf）。callbacks不抛到执行路径，登记失败使coverage unknown阻止通知，不stop合法child。`readRunStatus(runId):Promise<unknown>`由已有rpc.status({id:runId})注入，不能控制面helper running布尔复用。
- [ ] 冻结status actual返回精确id/state候选、details与asyncSnapshot冲突拒绝、unknown/未返回不能终态；active operation计数只作为通知候选invalidate，不替代status权威。
- [ ] 冻结manager/session下plain ID集合跨reload保留、不同session替换不继承；fresh resume不能证明完整历史集合时coverage unknown而非默认为空。
- [ ] 给出事件与producer先后/定期查询禁止/last-settled一次性标识，以及private上下文不保留。
**停止：** 不能证明完整ID/owner/status则blocked-evidence，I3不实施；必须报告通知功能未完成，不用closed-green代替目标。

### I2：纯idle controller与系统notifier

**Deps：** I1冻结。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/idle-notification/controller.ts`、`packages/pi-subagents-enhanced/src/idle-notification/status.ts`、`packages/pi-subagents-enhanced/src/idle-notification/notifier.ts`、`packages/pi-subagents-enhanced/src/idle-notification/index.ts`、`test/idle-notification.test.mjs`、`test/idle-notification-status.test.mjs`。
**接口：** gate必须冻结 `createIdleNotificationController({readRunStatus,notify})` 的 `bindSession({manager,sessionId,knownRunIds,coverage})`、`beginActivity()`、`recordRun(token,runId)`、`markCoverageUnknown(token)`、`settled({token,isIdle,hasPendingMessages})`、`dispose()`：session reset/跨reload集合、token与candidate序号区分；当前仅列候选接口，不能在I1未冻结时编码。notifier `sendMacOSIdleNotification():Promise<{exitCode:number}>`用execFile('/usr/bin/osascript',固定参数)，不用shell、不拼prompt。
- [ ] 状态矩阵与late-query新活动invalidate，一次候选只一次发送；固定标题 `Pi`、正文 `主会话已空闲，子代理均不活跃。`；notify错误隔离且可观察，不自动重发。
- [ ] `node --test test/idle-notification.test.mjs test/idle-notification-status.test.mjs`、package typecheck。
**验收：** paused/终态可通知，queued/start/resume/unknown/error/冲突不发，coverage未证实不发；不动runtimeFromStatus。

### I3：派发和Host接线

**Deps：** I2。**Resources：** unit-runner；与Q2 dispatch写冲突隔离。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`docs/decisions/2026-10-10-idle-system-notification.md`；Create `test/idle-notification-runtime.integration.mjs`。
**接口：** 全部observer由已有entry创建并DI给typed executor；owner同package，不新建root idle extension、不改root tsconfig。coding/generic回执在现有成功返回975/1110附近，resume1250附近；collector root与leaf完整集合由I1确认后登记。agent_settled消费controller，仅TUI主Host非child；before_agent_start/input/dispatch/resume/shutdown invalidate；reload保留plain IDs但旧callback失效。
- [ ] 异常登记mark unknown不吞spawn错误、不改变raw result；新dispatch开始先invalidate再await。
- [ ] 显式 `node --test test/idle-notification-runtime.integration.mjs test/subagent-runtime-membrane.test.mjs`、package typecheck；只真实SDK+fake provider，不发真实通知。
**停止：** coverage/API不成立回I1，不创建第二active-count authority。

### I4：真实通知可见性

**Deps：** I3。**Resources：** visible-host。
**WritePaths / Files：** Create `test/fixtures/idle-visible-provider.ts`、`test/idle-notification-visible.integration.mjs`、`docs/plans/records/2026-10-13-idle-notification-acceptance.md`。
- [ ] 临时HOME/agentDir/sessionDir/Git repo，physical Pi1.0.4+现有entry+deterministic local provider，无网络凭据；合法typed无写任务，dispatcher返回全部ID再settled。
- [ ] `PI_RUNTIME_IDLE_VISIBLE=1 node --test test/idle-notification-visible.integration.mjs`；事件日志证明确发一次，用户现场确认桌面可见。不通过则blocked-environment，不只认osascript exit0。
**记录字段：** fixtureRoot、version、sessionId/runIds、settledAt、notifyAttemptAt/exitCode、visualConfirmation(user/observable evidence)、permissionStatus、rawUnmodified、residualProcesses。固定文本，无系统设置变更；缺可视终端请求安排现场，不用fake补绿。

### Q1：receipt与options接点gate

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-trigger-turn-contract.md`；Read upstream notify.js/buildCompletionDetails/sendCompletion、本仓runtime-membrane/extension/bootstrap。
**事实：**当前上游sendCompletion发送message仅customType/content/display，没有稳定dispatch-only结构details。membrane有sendMessage代理，但代理不等于知道原result；仅标题、文本parser或child数不能证明无新增结果。
- [ ] 有限核对本仓是否可在真实发送前合法关联稳定结构result和精确同一个send，不读取私有文件/global、不修改上游、不借TUI反推。
- [ ] 若不存在，明确blocked-upstream且保留现有triggerTurn；Q2不派，Q3只记未实施。不能为完成清单扩大上游路线。
**验收：** contract列pass-through fixture、单条/混合/失败/需决策正反例和字段缺失fail-closed；找不到接点不是功能完成。

### Q2：只改options的合法selector（条件coding）

**Deps：** Q1冻结可实施，否则not-applicable而Q分支仍blocked-upstream。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/subagent-dispatch/dispatch-receipt-policy.ts`、`test/dispatch-receipt-trigger-turn.test.mjs`；Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`。
**接口：** `shouldSuppressDispatchWake(message,provenReceipt):boolean`只能消费Q1确定的可信关联，缺字段false；原sender仍唯一调用sendMessage，options浅复制仅triggerTurn:false，不改message object。
- [ ] 依Q1实施，不新增未验证文本regex。
- [ ] `node --test test/dispatch-receipt-trigger-turn.test.mjs test/subagent-runtime-membrane.test.mjs`、package typecheck。
**停止：** 需要新sender/上游metadata/读取raw artifacts时blocked-upstream，不以membrane便利为授权。

### Q3：通知投递回归记录

**Deps：** Q2实施或Q1阻塞记录。**Resources：** unit-runner（实施时）。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-trigger-turn-acceptance.md`；Modify `test/subagent-completion-notification.integration.mjs`（仅Q2已实现时）。
- [ ] 若实施，审计隔离fake-provider启动后显式 `node --test test/subagent-completion-notification.integration.mjs`，single/batch/actionable/send-failure不回退。
- [ ] 若blocked，记录上游限制、未运行、消息/options保持原语义；不得报告不唤醒功能已完成。

### H1：隔离heartbeat harness准备

**Deps：** B。**Resources：** unit-runner；不执行SIGKILL。
**WritePaths / Files：** Create `test/fixtures/heartbeat-parent-host.ts`、`test/fixtures/heartbeat-provider.ts`、`test/heartbeat-parent-death.integration.mjs`、`docs/plans/records/2026-10-13-heartbeat-experiment.md`。
**启动：** fixture父进程由 `process.execPath` 运行本repo physical Pi dist/cli.js（路径由test/helpers/pi-runtime公开helper解析），显式 `--mode rpc --no-extensions -e <fakeProvider> -e <repo subagent-runtime entry>`，独立临时HOME/PI_CODING_AGENT_DIR/SESSION_DIR/WORKSPACE_DIR/registry与临时Git repo。fake provider在父回合通过合法subagent tool派发coding、worktree:true任务，writePaths为临时Git仓中的精确 `probe.txt`，acceptance要求不修改任何文件；fixture仓先创建最小合法commit以支持managed allocation。当前worktree:false coding不会注册authorized principal/lease，不能作为本实验前提。child provider在本地异步barrier停住，不访问网络/业务/shell后代。managed workspace全在fixture根及独立coordinator scope，无真实仓common-dir共享；处置只用受支持runtime workspace API，不raw git worktree删除；有残留则保留根并申请精准清理。父Host为实际Pi进程，leaf为实际detached Node runner内嵌Pi AgentSession；runnerPid与childPid可相同，workflow root控制器可等parentPid，不虚构第三个OS进程，也不另起无关CLI child替代真实派发。
**隔离例外：** Root Broker `shortRoot()` 固定使用 `/tmp/pi-root-subagent-${uid}`，无公开路径注入。允许在该目录仅使用本次随机rootSessionId对应的精确hashed socket/grant namespace；不得枚举、读取或清理其它root资源。其余HOME/agentDir/Git/state/registry仍独立临时根，验收记录精确fixture-owned路径，不声称全部state位于fixtureRoot。不能证明namespace独占或发现碰撞立即停止；不改production为测试增加路径fallback。

**就绪：** 同repo PID birth公共helper捕获父/runner/child身份，公开spawn handle绑定runId/asyncDir；读取仅fixture的public状态投影与root-owner lease观察（不读authority正文）。若没有公开lease projection，增加tests-only injected诊断边界并记录fixture证据，不能改production给假的ACK。
- [ ] harness `--prepare-only` 以无kill模式验证binding/lease就绪及父子进程树：`PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs`。
- [ ] 生成ready JSON：fixtureRoot、parentPid/birth、runnerPid/birth、childPid/birth、runId/rootSessionId/ownerGeneration、leaseReceivedAt/lastRenewedAt/expiresAt、bound/acknowledged、toolExit。任何缺项不进入H2。
- [ ] fixture TS静态检查显式 `node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck test/fixtures/heartbeat-parent-host.ts test/fixtures/heartbeat-provider.ts`。
**停止：** 无法合法hold child/证明binding或lease、触发真实模型、子进程出fixture根则blocked-environment/证据；不临时改child/watchdog逻辑。

### H1-key：required-child 注册身份最小修复

**Deps：** H1p失败现场及 `docs/bugs/2026-10-14-required-child-session-identity.md` 已分类1的完整生成链。**Resources：** unit-runner；不启动真实Host。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`test/subagent-runtime-membrane.test.mjs`。
**方法：** 仅required-child注册块的key改为公开manager.getSessionId()；保留非空/幂等守卫、注册数组、dispose配对，不改lifecycleSessionIdentity其它用法，不双键注册/requireForAllRunners/fallback。实现后用合法SessionManager公有形态的持久与inMemory fixture检查public required registry lookup，id与file不等，清理自身fixture注册，不假生成ACK/lease。
**验收：** `node --test test/subagent-runtime-membrane.test.mjs`、package typecheck；然后H1p另任务重跑，真实lease/ACK证明不被unit替代。原hb-vhjjea保留，无pid残留，不削弱provider/readiness。

### H2：实际父死验收（不修production）

**Deps：** H1准备通过。**Resources：** visible-host、heartbeat-fixture，不能与I4并发。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-heartbeat-acceptance.md`；Run既有H1 harness，仅读测试fixture。
- [ ] `PI_RUNTIME_HEARTBEAT_PARENT_KILL=1 node --test test/heartbeat-parent-death.integration.mjs`；kill前校验parent PID birth仍相同、fixture parent是本harness直接spawn且非当前Host；仅SIGKILL父PID，不kill group/child。
- [ ] 从killAt起观察到已记录expiresAt+15s，最大90s；90s上限只是harness fail判定，不production超时保证。process-exit/birth身份消失佐证child自行退出，不以pid存在性单独判复用；45–65s仅历史预测，实际latency记录。
- [ ] FAIL先写现场，child残留不自动补杀、不删临时根；contact_supervisor申请精确fixture清理。正常prepare-only尚未kill父可正常dispose并确认fixture树结束；H2成功确认全部被测身份结束后才清临时资源。
**记录：** above ready字段、killAt、parentExit、childExitAt/exitSignal、latencyMs、terminationReason可得性、observedUntil、birthRecheck、childSupplementaryKill:false、remainingFixturePids、cleanupDisposition。managed/coding通过不外推generic/binding-failed/detached/bash descendants。

### R1：RPC字段增量

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-rpc-provenance.md`；Read入库RPC bug/历史rpc-provenance.json及assertSpawnCapabilities源码，不读真实session。
- [ ] 对已有code/stage/missingCapabilities、version/cwd/root/worktree字段投影逐项known/unknown、首偏离分类；无样本blocked-evidence，向用户只申请字段。
**验收：** 静态事实不冒充个案，无fallback；Markdown路径审计/diff check，不运行真实RPC。

### R2：RPC处置

**Deps：** R1。**Resources：** static-evidence。
**WritePaths / Files：** Modify `docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`；Create `docs/plans/records/2026-10-13-rpc-disposition.md`。
- [ ] 写terminal status/证据/未验证范围；有明确生产缺陷时父层先补精确patch任务并申请超出计划路径，不在本任务修代码。

### V1：supervisor消费字段增量

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-supervisor-provenance.md`；Read对应入库bug/历史JSON/control plane/consumption公开源码。
- [ ] 只核精确requestId/runId/replyTo/index/时间与可信consumption事实；pending空/attention/提交回执不够，无证据blocked-evidence。

### V2：supervisor处置

**Deps：** V1。**Resources：** static-evidence。
**WritePaths / Files：** Modify `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`；Create `docs/plans/records/2026-10-13-supervisor-disposition.md`。
- [ ] 记录submitted/queued/delivered/consumed/gate-open来源；证实消费但拒绝时另列精确修复资格，不以文案便利放宽gate。

### Z：总验收与交付

**Deps：** S1v、F7、I4、Q3、H2、R2、V2均有终态证据（blocked不算功能完成）。**Resources：** unit-runner。
**WritePaths / Files：** Create `docs/plans/records/2026-10-13-remaining-runtime-acceptance.md`；Modify `docs/todos/2026-10-10-runtime-followups.md`、`docs/plans/records/2026-10-13-legacy-plan-review.md`仅追加本批状态/链接。
- [ ] 显式focused tests按任务命令汇总，`npm run typecheck`、`git diff --check`；npm test/all-integration在本批禁止自动运行，若用户要求全仓先独立风险审计。
- [ ] 分类失败为既有production/fixture/权限环境/未知，不能预称全仓green。.integration.mjs显式命令不能靠npm glob。
- [ ] 文档链接审计root/package README、架构、session-owner、decision/todo，每项记录changed/not-needed；不扩大文档写路径。
- [ ] 完成表必须分功能implemented、真实verified、blocked/unconfirmed；idle可见和heartbeat实际进程证据不能用fake替代。blocked I/Q/S时整体partial，申请具体解除而非“全部做完”。
- [ ] 清资源/遗留PID/fixture/unknown锁明确交代；不自动commit/push，不自动成果review。

## 自检与交接

本计划覆盖三份遗留文档的真实待办；现状架构合同不是重复实施DAG，历史T0–T11不重跑；footer详细协议/视觉合同从其子计划消费，若冲突本统一计划及用户最新决策优先。独立reviewer本轮指出的问题按gate/精确路径/现场schema修订，未重新派发自动review。计划阶段仅编辑文档、不执行任何实现。

选择：Subagent-Driven / Inline / 用户明确再review。产品范围没有新的待决策项；技术gate失败会在执行中提出具体事实，而不会自行扩上游或取消可见通知目标。
