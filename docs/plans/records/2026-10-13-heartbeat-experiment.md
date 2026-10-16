# H1 heartbeat harness 准备记录

## 当前状态与授权边界

**状态（最新，2026-10-14 H1p run4）：第四次真实 prepare-only 首次全绿——`env -u PI_RUNTIME_HEARTBEAT_PARENT_KILL PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs` 实际 **exit 0**，`tests 3 / pass 3 / fail 0 / skipped 0`（Host 用例 21266ms，全新 mkdtemp 根 `hb-b9YtbN`）。前三轮的三处修复逐调用核实现场生效：repo required-key（`extension.ts:1734` `getSessionId()`）→ required 三项 `["root-session-owner","integration-queue","agents-shared"]` + `omitted` 全 0 + child-runtime ACK ids 逐项匹配；fixture pre-title → `parent-started.hostBirth == registry.processBirthIdentity == ready.parentBirth`（`6ecfde86…`，与 pre-title `spawnBirth 920c7c…` 不同属预期，仅作历史诊断）；fixture/harness 跨 locale → parent probe 记录 `readLocale {LANG:"C",LC_ALL:"C"}`，harness 全部 9 处 ps 取样/比较（`:136/:187/:205/:217/:224/:229/:261/:262`）经既有公开 `{execFile}` 注入 C locale，`:187` registry 活体复核与 `:217` ready 时父活体复核均以真实数据通过。lease **renewalSequence=1**（同一 leaseId，`lastRenewedAt …083106 / expiresAt …143106`，窗内断言成立）、owner receipt（generation 1，runner 侧 birth 自校）、barrier entered、`toolExit:"success"`、managed worktree containment、`workflowPid==parentPid==37303` / `runnerPid==childPid==37438` 且同 birth 全部真实成立。prepare 正常收尾：写 `release-barrier` → child 自然结束（public process-terminal proof `exitCode 0 / signal null`，`resumeDisposition:"resumable"`）→ fake 父回合经 public `subagent_worktree` status/dispose → 台账 `managed-workspace-ledger.v2 state:"released"`、`disposition.action:"discard"`、`actionChallenge.allowed ["publish","discard","preserve","release"] used:true`、`cleanupDebt:null`、`integrationIntent/integrationReceipt:null`+`integrationHistory:[]`（child-owned 未被父 integrate）→ `stdin.end()` 父 orderly 退出 `{code:0, signal:null}` → `remaining(ready)` 实测 `[]` → `prepare-result.json {mode:"prepare-only", parentDeathExperiment:false, childSupplementaryKill:false, cleanupDisposition:"public-workspace-disposed; evidence-root-retained"}`。全程**未发任何信号**（唯一 kill 面 `:266` 在 `parentDeath` 内、被 `:255` 门禁 env 断言隔离，本轮从未进入）、未 raw `git worktree`、未 `rm` 任何 root；`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea` 仅存在性检查（三者均 EXISTS，未读、未复用、未删）。两项如实记录的观察（均归类**类别 2：fixture 数据不满足 production 契约**，production 零改动、未加兼容）：leaf run 终态 `state:"failed"`、`error:"Acceptance rejected: commands-run evidence missing from child report."`（上游 `pi-subagents@0.75.0 src/runs/shared/acceptance.js:1072` 要求 `commandsRun.length>0`，`requiredEvidenceForLevel("checked"):43-51` 含 commands-run，fixture `heartbeat-provider.ts:31-37 childReport()` 发 `commandsRun: []`）；以及其后 child runner 侧 `integration-lifecycle-advance-error reason:"workspace admission requires the authorized clean committed HEAD" retryable:true`（fail-closed，runner 仍 exit 0）。二者**不影响 prepare-only 判定**（harness 不断言 child 结算结果，ready 时 `status.state==="running"` 已断言通过），但**不得把 prepare-only 通过读成 child coding run 结算通过**；H2 亦不受影响（H2 在 ready 后立即 SIGKILL 父、从不写 release-barrier，child 永不提交报告）。**H1 prepare-only 通过，可进入 H2；H2 必须由父层另派独占 visible-host+heartbeat-fixture（不与 I4 并发），本 run 绝不切 env 执行 kill。**详见文末「H1p run4」章节。**

**历史状态（2026-10-14 H1p run3）：第三次真实 prepare-only 仍 exit 1，first divergence 再次前移——上一轮的 pre-title/post-title 修复已现场实证生效（`:177` hostBirth == registry.processBirthIdentity 以真实数据通过），本轮唯一失败点是 harness 跨 locale 的 birth 比较器：`test/heartbeat-parent-death.integration.mjs:178` 用**执笔 shell 的 locale（LANG=zh_CN.UTF-8）**捕获 `ps -ww -p PID -o lstart= -o command=`，去比对**fixture Host 内 C locale（`fixtureEnvironment` 固定 `LANG=C LC_ALL=C`）**捕获的 registry birth；同一活进程的 `lstart=` 在两种 locale 下字节不同（`Wed Oct 14 …` vs `三 10月/14 …`），sha256 必不同，`processBirthIdentityMatches` 因此返回 false。已用两级隔离机制探针（无 Pi Host、无 fixture、无网络、无信号）确定性复现：同一子进程 in-process C locale birth 与 harness 式跨 locale matches=false、注入 C locale execFile 后 matches=true。归类**类别 2：测试制造的非预期数据（harness 实际取样域错误）**；production 无缺陷、未修改（runner env 全链继承父 locale，无任何 LANG/LC_ALL override，production 的跨进程 birth 比较始终在同一 env 域内）。required 三项注入 + ACK + owner receipt + subscribe + **renewalSequence=1** + barrier + managed worktree + fixture 仓零修改本轮全部再次真实达成。按合同**不自动新 fixture 重试、不改代码、不发信号、不 rm**；新现场 `hb-iKUNgy` 与旧现场 `hb-fTmWES`/`hb-vhjjea` 全部保留，无进程残留。未进入 prepare dispose、未进入 H2，`parentDeathExperiment:false`，**prepare-only 未通过，不得当作父死 heartbeat 通过**。主管已裁决：确认类别 2，production 不改、不加 locale 归一化 fallback；harness-only 最小修复与全新 fixture run4 由父层另派（本 run 不重试、不越 writePaths）；`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea` 三 root 全部保留，run4 后按 public workspace status 的 `allowed_dispositions`/`action_token` 逐个处置；coordinator 跨 locale owner birth 作为独立潜在类别 3 另派只读 provenance。详见文末「H1p run3」章节。**

**历史状态（2026-10-14 H1p rerun）：H1-key 修复后重跑真实 prepare-only 仍 exit 1，但 first divergence 已前移——required 注入/ACK/lease renewalSequence=1/barrier/managed worktree 全部真实达成，唯一失败点是 harness 自身把「spawn 瞬间捕获的父 birth」与「production 在 `process.title` 改写后记录的 registry birth」直接相等断言（`test/heartbeat-parent-death.integration.mjs:167`，下一处 `:192` 同因）。已用隔离机制探针确定性证明 `process.title = APP_NAME`（physical SDK `dist/cli/setup.js:4`）会改写 `ps -o command=`，故归类**类别 2：测试制造的非预期数据（harness 实际入口错误）**，production 无缺陷、未修改。主管已裁决：本轮 writePaths 仅 record，**不修 harness、不重跑、不发信号、未授 cleanup**；harness 最小修复与 unit 验证、后续新 prepare 由父层另派。新现场 `hb-fTmWES` 与旧现场 `hb-vhjjea` 完整保留，无进程残留；未进入 prepare dispose，未进入 H2，`parentDeathExperiment:false`。详见文末「H1p rerun」章节。**

**历史状态（2026-10-14 首轮 H1）：H1 真实 prepare-only 已运行并失败——readiness 120s 超时，first divergence 为 child required 注入为空（根因候选：required registry 键/注册时点链，未决）；主管已裁决归类「来源尚未证实」并保留现场补受限 provenance，H1 重跑/H2 阻塞至 provenance 与修复验收。不是父死实验通过记录，也不是 prepare-only 通过记录。H1v 静态验证（类型检查与默认关闭单元测试）此前已通过；详见下文 H1 运行记录。该根因已由 `docs/bugs/2026-10-14-required-child-session-identity.md` 分类 1 并经 H1-key 修复，本轮 rerun 现场实证修复生效。**

本轮仅新增以下四条合同路径，不修改 production、统一计划或其它任务现场：

- `test/fixtures/heartbeat-parent-host.ts`
- `test/fixtures/heartbeat-provider.ts`
- `test/heartbeat-parent-death.integration.mjs`
- 本文

执行了三文件 `node --check`（解析、不运行脚本），均 exit 0；聚焦 `git diff --check` exit 0，`git diff --cached --name-only` 空。没有执行 tsc、Node test、prepare-only、真实 typed dispatch、通知、SIGKILL 或其它进程清理。未生成临时 Git 仓、commit、Host PID、ready/ACK/lease 运行产物；没有本任务创建的运行中 fixture 或待杀进程。未读真实 session/authority/settings/models/auth。未提交本仓 Git。

主管明确回复：F1 尚占用 `unit-runner`，本轮不授予 tsc/Node test；交付准备产物，由后续 H1v 验证，不 sleep/poll 等待。真实 prepare-only 另行明确授权；H2 独立执行。

## 已确认的测试前提修订

### worktree:false 不可作为本实验前提

静态证据：

1. `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 的 `executeCoding` 仅 `ir.worktree === true` 分配 workspace（818–821），`onBinding` 仅 `if (workspace)` 调用 `registerAuthorizedRun`（901–936）。
2. `codingWorkflowSpawnParams` 仅 worktree 分支注入 `pi-config.root/1`（359）。
3. `child-extensions/root-session-owner.ts` 的 `installRootSessionOwner` 在 rootSessionId/runId 双缺失时返回 disabled，无 client/lease 消费。
4. `root-broker-server.ts` 的 `registerFacadeRun` 只登记 facade，不创建 principal/lease；`registerAuthorizedRun` 才登记 durable owner/lease 与 root.subscribe principal。

归类：原实验构造前提与 production 路径矛盾，是 **测试 topology 问题**，不是证明了 production 心跳故障。已通过 `contact_supervisor` 停止并获明确决策，由父层 inline 修订统一计划为 **managed coding、worktree:true、writePaths:['probe.txt']、禁止改文件**。本任务未改 production；不外推 shared worktree:false 存在 heartbeat。

### 固定 broker namespace 例外

`root-broker-protocol.ts` 的 `shortRoot()` 硬编码 `/tmp/pi-root-subagent-${uid}`，不受 HOME/TMPDIR/stateRoot 控制。再次经主管确认，接受共享 uid 目录中的**本次随机 rootSessionId 精确 hashed namespace**，不虚称所有状态都在单一 fixtureRoot。

harness 使用 `heartbeat-${randomUUID()}`，启动前仅 lstat 精确 `brokerSocketPath(rootSessionId)` 确认不存在；出现冲突停止，不接管、不删共享目录。`launch.json` 记录随机 ID、精确 namespace、启动前不存在事实；实际 parent probe 通过 `rootBrokerRegistryEntry` 获取 endpoint/PID/birth，ready 校验与本次 spawn handle 完全一致。禁止枚举或读取其它 root 的 grant/socket/authority。

### 实际进程 topology

公开上游源码：

- `pi-subagents/src/runs/foreground/subagent-executor.js:5134` workflow root 的 async-started 明确 `pid: process.pid`，root 控制器在父 Host 内。
- `pi-subagents/src/runs/background/async-execution.js:1986` leaf async-started 的 pid 来自实际 detached `spawnResult.pid`，含 parentWorkflowRunId/workflowKey。
- `pi-subagents/src/runs/shared/child-session.js` 的 `createDefaultChildSessionFactory` 在 detached runner 内用 physical Host SDK `createAgentSession` 创建真实 child。

因此 **workflowPid=parentPid，runnerPid=childPid**，child 是 runner 内真实 Pi AgentSession，而非第三个 OS PID。主管已确认这是目标 production topology；harness 明确断言并记录，不虚构 PID。root/leaf 关系从公开 lifecycle event + handle 绑定，不以工具文字回执推断。

## 源码设计与字段来源

### 实际启动（待授权执行）

`fixture()` 使用 `test/helpers/pi-runtime.mjs::resolvePiCodingAgentRoot({env:{}})` 固定本仓 physical SDK，`process.execPath` 直接 spawn `dist/cli.js`，无 global CLI 回退、无 wrapper 父 PID：

- `--mode rpc --session-id <随机ID> --no-extensions`
- 显式加载 fake provider、本 repo `extensions/subagent-runtime.ts` 与 parent probe。
- `--offline --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve`。
- 显式 `--provider heartbeat-fixture --model heartbeat-fixture/local --thinking off --session-dir <fixture>`。

fixture 根先 realpath，避免 macOS `/var` 与 `/private/var` 导致错误 containment。环境从空白白名单构建，不展开 process.env。HOME/agentDir/sessionDir/state/TMPDIR/XDG 均独立；不继承 API key、token、真实 provider/model/subagent/session/env、Git authority。Git init/config/add/commit 仅新临时仓，禁全局 Git config；最小 commit 消息 `test(heartbeat): 增加隔离只读探针` 按已全文读取的 `skill-overrides/git-commit-convention/SKILL.md` 编写。此 commit 分支当前尚未执行。

三个 builtin agent profile 仅 fixture `agent/agents`，使用唯一 fake 模型、read 工具；共享 required child extension 链接同一 production `pi/extensions/agents-shared.ts`，不手写伪 ACK。Git common-dir 必须在 fixture 内，managed workspace 状态也在 fixture state，绝不从 live 仓启动 Host。

### 合法本地 barrier / 公共 lease 观察

父 fake stream 生成正常 `subagent` tool call，传 `heartbeatContract` 的完整 coding 字段；没有直接 RPC spawn/手工 lifecycle append。child fake stream 只在内存生成消息，进入 `timers/promises` 异步 barrier 等待 fixture `release-barrier`，响应 abort。无 shell、HTTP、真实模型或 detached bash 后代。

`heartbeat-provider.ts` 先注册事件观察，再由真实 `pi-config:root-owner-ready` 触发：

1. 使用运行时实际身份创建 `createRootBrokerClient`，要求 root.subscribe。
2. 经公开 `owner.read` 读取当前 owner receipt；实际 `captureProcessBirthIdentity(process.pid)` 必须匹配 receipt.processBirth。
3. 通过同一 principal 的公开 subscribe 收 `lease.updated`，只投影 leaseId/runId/generation/lastRenewedAt/expiresAt/renewalSequence；无 authority 文件读取。
4. 实际 `subagent:acknowledge-extension` 的 root-session-owner ACK 独立观察。未观察 ready/ACK/lease 不能由模型 marker 补足。
5. 至少观察 renewalSequence >= 1 才 ready，避免将初始 lease 误称续租证明。

这是诊断旁路，不替换、不包装 production watchdog，不新建 lease authority，不注入假的 ACK/lease。

### ready.json（全部是待实际捕获字段）

- fixtureRoot、parentPid/parentBirth/directSpawn。
- runnerPid/runnerBirth、childPid/childBirth、runnerContainsChildSession。
- workflowPid/workflowRunId/workflowAsyncDir，runId/asyncDir/dispatchCwd/workspaceId。
- rootSessionId/ownerGeneration、公开 registry 的 protocol/rootSessionId/endpoint/pid/processBirthIdentity。
- leaseId/leaseReceivedAt/lastRenewedAt/expiresAt/renewalSequence。
- bound/boundAt、acknowledged/ackAt、barrierAt、toolExit/toolExitAt、readyAt。
- startupOrder：parent-started、workflow-started、leaf lifecycle-start、owner-read、实际 ACK、barrier、lease 收到时间。

`assertReady` 缺任何关键项即拒绝；新增默认无 Host 的单元字段矩阵逐项删除字段及错误 ACK/bound/lease/目录/PID 正反例（H1v 已实际运行通过，见下）。校验父与 workflow 同 PID、runner 与 child 同 PID/birth、root/leaf 不同 runId、同 generation、时间单调/未过期、所有运行目录在 fixture 内。还把 fixture public `status.json` 的 runId/pid/running 与 lifecycle/handle 交叉核对；不读 session 正文或启动私有握手。

### H2 安全门禁与退出证据

默认两个 env 都缺时实际 Host 用例 skip；`PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1` 与 `PI_RUNTIME_HEARTBEAT_PARENT_KILL=1` 互斥。仅 H2 函数含一次 `f.host.kill('SIGKILL')`：发送前再次验证 ready 全字段、父 handle.pid 与 ready.parentPid 相等、非 harness 自身、父仍活同 birth、runner 仍活同 birth，并先写 before-sigkill.json。没有负 PID、kill group、runner/child 补杀或 finally kill。

观察期限 `min(killAt+90s, 已记录expiresAt+15s)`；90s 是 harness fail 上限，不是 production 超时保证。`identityEnded` 区分同 birth 仍活、birth 已变的 PID 复用和 ps 缺失事实。birth helper 抛错本身不足以宣称退出；另用精确 ps 缺失佐证，权限/解析未知 fail closed。

结果字段包括 killAt/parentExit/childExitAt/childIdentityEnd/latencyMs/observedUntil/birthRecheck/childSupplementaryKill:false/remainingFixturePids/cleanupDisposition。能取得 public processTerminal 则记录；watchdog 未公开 terminationReason 时明确 null，绝不猜为 authority_lease_expired 或伪造 exitSignal。

### 正常 dispose 与失败保留

prepare-only 不杀父，只释放本地 barrier。child 正常完成且实际身份结束后，由 fake 父回合调用 public `subagent_worktree status`，仅当 status.allowed_dispositions 含 discard 且给出 action_token 才 `dispose/discard`；已 released 无需强制处置。child-owned integration 不做父 integrate，不绕状态，不 raw git worktree 删除。

正常 parent 关闭 stdin 请求 CLI orderly shutdown，确认被测身份结束；记录 prepare-result 且 `parentDeathExperiment:false`。证据根一律保留，不 rm managed 目录或共享 broker 目录。

失败写 failure.json/parent-death-result.json，包含已知身份与残留、错误和精确 fixtureRoot；不补杀、不删除。测试失败后解除 harness 对管道/child handle 的引用以便报告失败；不是执行 cleanup，父尚活时 stdin EOF 属正常 disposal，不能算父死证明。实际执行者应携此记录 `contact_supervisor` 申请精确 fixture cleanup。

## SDK 文档与现有代码阅读

已全文读取 physical Pi `docs/sdk.md`、`custom-provider.md`、`extensions.md`、`cli-integration.md`、`cli.md`、`rpc.md`、`rpc-commands.md`、`json.md`；读取相关示例 `examples/rpc-client.ts`、`examples/sdk/12-full-control.ts`、`examples/extensions/custom-provider-anthropic/index.ts`。消费公开 provider stream/Extension API/RPC LF framing/shutdown 合同，不使用 MCP。

已读取统一计划 H1/H2、heartbeat provenance、`test/subagent-completion-notification.integration.mjs`、`test/helpers/pi-runtime.mjs`/`pi-host.mjs`、现有 deterministic provider、root-session-owner watchdog 与测试、公共 broker client/protocol/registry、workflow root/leaf collector、managed workspace tool 以及实际 upstream child session factory。未把旧 notification fixture 的宽松继承 env、timeout SIGTERM/SIGKILL 或 raw session 查询复制到本 harness。

## H1v 独立静态验证记录（2026-10-13，unit-runner 独占）

本轮仅改动 `test/fixtures/heartbeat-provider.ts` 两行（fixture2 类修正，见下）；production、统一计划与其它现场零改动。未执行 prepare-only、H2、真实 typed dispatch、通知、SIGKILL、fixture git commit 或网络。

### 实际命令与退出码（按执行顺序）

1. `node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck test/fixtures/heartbeat-parent-host.ts test/fixtures/heartbeat-provider.ts` → **exit 1（TS5112）**：tsc 7.0.2 在命令行显式文件模式下拒绝并拒绝加载 tsconfig，要求 `--ignoreConfig`；本轮未执行任何类型检查。
2. 计划命令 + `--ignoreConfig` → **exit 1**。诊断为两类：production transitives 在 tsc 7.0.2 默认 strict 系打开下的 TS7006/TS2322/TS18048/TS7053（contract-limits.ts、repo-path.ts、root-broker-protocol.ts、root-broker-server.ts），及一处真实 fixture 错误 `heartbeat-provider.ts(132) TS2322`。计划命令书写时默认 strict 关，与本仓 canonical profile（根 tsconfig `strict:false/noImplicitAny:false`）一致；production 文件在该 profile 下由 `cd packages/pi-subagents-enhanced && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`（**exit 0**）证明干净，非 fixture 回归。
3. 计划命令 + `--ignoreConfig --strict false` → **exit 1**，仅剩 `process-birth-identity.ts` 三处 TS2339 `Error.code` 与 fixture(132)。TS2339 为程序组成伪差：`src/subagent-dispatch/errors.ts` 的 `declare global { interface Error { code?... } }` 在 package 项目模式下参与全局增广，命令行文件模式程序不含该文件；production 本身无需修改。
4. fixture2 修正（仅 scope TS 对齐实际公共 SDK 类型，无生产 fallback、未删任何安全断言/no-op mock）：`heartbeat-provider.ts` 本地 `tool.arguments` 由 `Record<string, unknown>` 改为 `@earendil-works/pi-ai` 实际导出的公共类型 `JsonObject`（即 `ToolCall.arguments` 的真实类型），import 同步补 `type JsonObject`；所有实参（heartbeatContract、status/dispose 字面量）均为 JsonValue 兼容，运行时对象不变。stopReason `pending/toolUse/stop` 经 SDK d.ts 核验均合法，无需改。
5. 最终类型检查命令 → **exit 0**：

   ```sh
   node_modules/.bin/tsc --ignoreConfig --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck --strict false --types node test/fixtures/heartbeat-parent-host.ts test/fixtures/heartbeat-provider.ts packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts
   ```

   计划全部 flag 保留；harness 级对齐共四项：`--ignoreConfig`（TS7 显式文件模式必需）、`--strict false`（对齐根 tsconfig strict/noImplicitAny 关闭的 canonical profile）、`--types node`（对齐根 tsconfig `types:["node"]`）、将 production `errors.ts` 作为附加根文件纳入程序以恢复项目模式等效的 ambient Error 增广。语义仍为“fixture 文件按本仓编译 profile 对真实 SDK 类型检查”，未放宽到仓库标准之外；此偏离在此明确记录供父层复核。
6. `env -u PI_RUNTIME_HEARTBEAT_PREPARE_ONLY -u PI_RUNTIME_HEARTBEAT_PARENT_KILL node --test test/heartbeat-parent-death.integration.mjs` → **exit 0**：`tests 3 / pass 2 / fail 0 / skipped 1`。pass：harness 默认关闭/prepare-H2 互斥/env 白名单；readiness 字段矩阵逐 key 删除必抛。Host 用例以 `experimentMode({}) === "disabled"` 明确 SKIP（0.13ms），未 spawn 任何进程；两个门禁 env 经 `env -u` 显式移除而非继承现状。
7. 收尾核对：`git diff --check`（四 scope 文件）**exit 0**；`git diff --cached --name-only` 空；`ps` 无 hb- fixture 进程；三个 scope 源文件 `node --check` 全部 exit 0（含本轮修改后重验）。

诊断性临时文件（/tmp/tsgo-probe.ts、packages/pi-subagents-enhanced/scripts/__probe-error-code.ts）仅用于确认 tsc 7.0.2 默认差异与 ambient 增广来源，均已删除，无残留。

### 静态安全审计结论（本轮逐项核对）

- **env 白名单**：`fixtureEnvironment` 为固定字面量键集合，不展开 `process.env`；单元断言验证无 API_KEY/TOKEN/SECRET/PASSWORD/AUTHORIZATION 键、HOME/WORKSPACE_DIR 指向 fixture。
- **父 direct spawn + PID birth**：`spawn(process.execPath, [dist/cli.js …])` 无 wrapper 父；birth 在 launch.json 前以公共 helper 捕获；birth 失败写 bootstrap-failure.json 后 unref 保留现场，不杀。
- **kill 面唯一且双重门禁**：唯一 `f.host.kill("SIGKILL")` 在 `parentDeath` 内，前置 `process.env[KILL]==="1"` 断言、ready 全字段复核、kill 前 birth 复核与 before-sigkill.json 落盘；无负 PID、无进程组、无 child/runner 补杀、无 finally kill。本轮该分支未执行。
- **broker namespace**：仅 `lstat` 本次随机 rootSessionId 派生的精确 socket 路径；共享 `/tmp/pi-root-subagent-<uid>` 不枚举、不读其它 root；冲突即停。
- **readiness 必填字段逐行审计**：assertReady 六段断言对样本逐 key 模拟删除均必抛（`fixtureRoot` 删除经 `path.relative` 参数校验抛 TypeError；`readyAt` 删除经末行 `undefined >= 数值` false 必抛；boolean 删除经 `assert.equal` 必抛）；正反例矩阵（acknowledged/bound/directSpawn:false、renewalSequence:0、childPid 不等、dispatchCwd 越界、expiresAt 过期）均必抛。`runnerPid===childPid` 且同 birth、`workflowPid===parentPid` 为已确认的 production topology 断言（workflow root async-started 的 `pid: process.pid`、leaf 的 `pid: spawnResult.pid`，见 pi-subagents 源）。
- **lease observedTime skew**：`lastRenewedAt/expiresAt` 由 broker 续租时钟写入 push.data，child 侧 `observedAt` 为同机同钟收帧时刻，正常序恒 `lastRenewedAt <= observedAt`；断言 `lastRenewedAt <= leaseReceivedAt && expiresAt > leaseReceivedAt` 不误伤合法 skew（收帧更晚合法），租约窗 60s/续租 15s（HEARTBEAT_LEASE_MS/HEARTBEAT_RENEW_MS），正常投递延迟远小于窗长；未放宽该安全断言。
- **readOwnerReceipt envelope**：核实 broker `owner.read` 直接返回 `OwnerReceiptV1` receipt（含 processBirth/ownerGeneration，非 envelope 包装）；child 旁路仅消费公共 `createRootBrokerClient` + 公共 `lease.updated` push，未 deep mock owner 字段；`owner.processBirth !== birth` 校验路径真实成立。
- **未验证（留 prepare-only/H2）**：fake provider 实际加载顺序与 owner/ACK/lease 旁路真实触发、managed workspace 分配与 public dispose、status.json 交叉核对、续租序列 ≥1 的到达时序、runnerPid=childPid 拓扑运行时成立性。静态通过不构成父死实验通过。

## H1 真实 prepare-only 运行记录（2026-10-14，unit-runner+visible-host 独占授权）

**状态：H1 真实运行已执行并失败——readiness 120s 超时，非 prepare-only 通过，更不是父死实验通过记录（parentDeath 分支从未进入）。已 fail closed：不改 production、不继续真实实验、现场全保留，已上报申请分类决策与精确处置。**

### 实际命令与退出码

1. 重跑 H1v 最终类型检查（确认 F1 释放 unit 后无漂移）：`node_modules/.bin/tsc --ignoreConfig --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck --strict false --types node test/fixtures/heartbeat-parent-host.ts test/fixtures/heartbeat-provider.ts packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts` → **exit 0**。
2. 开跑前静态确认（不猜 flags）：`dist/cli/args.js` 逐一确认 `--mode/--session-id/--no-extensions/-e/--no-skills/--no-prompt-templates/--no-themes/--no-context-files/--no-mcp/--offline/--no-approve/--provider/--model/--thinking/--session-dir` 全部存在，`off` 在 VALID_THINKING_LEVELS、`rpc` 为合法 mode；`registerProvider(name, config)` 形状与 `ProviderConfig` d.ts 逐字段核对；事件先后（root-session-owner 先建 client 再 emit `pi-config:root-owner-ready`，随后 emit `subagent:acknowledge-extension`）、`readOwnerReceipt`/`brokerSocketPath`/async-started 字段（root `pid:process.pid`、leaf `pid:spawnResult.pid`、parentWorkflowRunId）、`subagent` result details（runId/asyncDir/workspace_id/dispatch_cwd）与 `subagent_worktree` status 字段（workspace_state/allowed_dispositions/action_token）逐项确认。env 无心跳门禁变量；`ps` 无 hb- 残留；四 scope 文件 untracked、无 staged。
3. 真实运行：`env -u PI_RUNTIME_HEARTBEAT_PARENT_KILL PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs` → **exit 1**：tests 3 / pass 2 / fail 1。Host 用例 120634ms 失败：`公开身份/ACK/lease readiness 超时；保留 fixture，禁止自动补杀`。

### 现场事实（fixtureRoot=/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-vhjjea，全保留、未 rm、未补杀）

- launch.json：parentPid **65435**（birth `d2698b6a0502960359c35d436ecc0baed34ce9974afb8a972c7cdff8ac599ba7`）、rootSessionId `heartbeat-3b45454d-bee2-4351-a2d8-43f4f35f9a85`、brokerNamespace `/tmp/pi-root-subagent-501/b70ea811e9403c4a7f371f36d59e4b4a67acb1e15c9599105664b2283466afff.sock`（启动前 lstat ENOENT 已确认）。stderr 仅 `Warning: No project session found with id …; creating a new session with that id.`
- parent-observations.jsonl（时间序）：parent-started（broker registry 正确：endpoint 同 namespace、pid=65435、birth `bc64a95bf41edd68a16f9ced0b8b13a1fb97591293d2a745b8d48680a73a72a6`，observedAt …43996）→ workflow started（runId `64cb23f7-02c7-4411-9417-a06ec0ac960d`，pid=65435=父，…44807）→ leaf started（runId `7fe18152-177f-4da3-a912-3b7c16f483bf`，pid=**65539**，agent executor，parentWorkflowRunId=64cb23f7，…44846）→ process-terminal（runner 65539 exit 0，proof state=observed，…45422）。
- child-65539.jsonl：**仅** child-session-started（cwd 在 fixture managed worktree 内）；无 owner/acknowledged/lease/barrier-entered/observation-error 任何记录。
- leaf asyncDir status.json：`state=failed`、`launchResolvedExtensions.required=[]`、`runtimeAcknowledgedExtensions=null`，步骤失败信息 `Error: 模型启动前未观察到实际 root-owner-ready`（fixture provider 的 fail-closed 门禁按设计触发）。runner.stderr.log/runner.stdout.log 均 0B。
- 进程收尾（未发任何信号）：runner 65539 自行 exit 0（public process-terminal proof）；父 Host 65435 在 harness 结束后经 stdin EOF 正常 orderly shutdown，broker socket 已随之移除（精确路径 lstat ENOENT 复核）。`ps` 双次确认 65435/65539/65418 均不存在，无残留 fixture 进程。`git diff --cached --name-only` 空。

### first divergence 与代码链（全部 file:line 实证）

1. 注册侧：enhanced 层在主 Host `session_start`（…43996，先于派发 …44807）以 `lifecycleSessionIdentity(ctx?.sessionManager)` 为 key 调 `registerRequiredChildExtensions`（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1733-1746`）；`lifecycleSessionIdentity`（同文件 263-268）优先取 `session.sessionFile`。
2. 持久会话下该 key 必为 session 文件路径：`SessionManager.create` → `newSession` 在 persist 下即设 `sessionFile`（`dist/core/session-manager.js:712-713`）；既有 `test/subagent-runtime-root-broker-startup.integration.mjs` 亦断言持久会话 `brokerLifecycleSessionId === getSessionFile` 且 `getSessionId ≠ getSessionFile`。
3. 查找侧：上游派发链全部以 session ID 字符串查 registry——`subagent-executor.js:3472`（`data.parentPiSessionId = ctx.sessionManager.getSessionId()`，见 7107/7149）、`:4743`（`ctx.sessionManager.getSessionId()`）、`async-execution.js:745/894`（`ctx.parentSessionId ?? ctx.currentSessionId`，其中 `asyncCtx.parentSessionId = data.parentPiSessionId` 为 ID 字符串、`currentSessionId = data.parentSessionId` 为文件路径，见 `subagent-executor.js:3027-3031`）。
4. 键不匹配 → `resolveRequiredChildExtensions` 返回 EMPTY → `toolPlan.requiredExtensions=[]` → `launchResolvedExtensions.required=[]` → root-session-owner/integration-queue/agents-shared 三项 required 注入全部未进 child。
5. child 无 root-session-owner → 无 `pi-config:root-owner-ready`/ACK/lease 事件 → fixture provider 在首轮流式请求即 fail-closed 抛错 → run failed → harness readiness 120s 超时。harness 按设计保留现场、不补杀、不清理。

### 分类（按缺陷数据来源分类门禁，未完成前 fail closed）

- fixture 未手工拼 projection、未绕过 public 入口：`--session-id/--session-dir/--mode rpc` 均为公开 CLI flags，typed `subagent` dispatch 为公开工具，持久会话身份由真实 SessionManager 权威产生；键分歧发生在两段 production 代码之间，非测试制造数据。
- 覆盖盲区：现有断言 required 注入的 `joint-upgrade-contact-supervisor.integration.mjs` 与 `subagent-completion-notification.integration.mjs` 均以 `--no-session` 启动（in-memory，sessionFile 未设 → 注册键退化为 sessionId 字符串 → 与查找键一致而通过）；「持久会话 + required-child」组合此前无任何测试覆盖。
- 未决因素（经主管修正，不作为同拓扑反证）：本记录执笔者自身 system prompt 含 `pi_child_execution_boundaries`（agents-shared child scope 的唯一注入通道就是同一 required registry），但**这不构成同拓扑反证**——真实主 Host 的初始注册时点可能尚无 sessionFile、会话可能后来才持久化；不得读取自身真实 session/state 去求证。需闭合的是：注册/查找两侧的**实际键值**与**注册时点**（session_start 时刻 sessionFile 是否已设）。
- **结论（主管已裁决）：归类「来源尚未证实」，先保留现场补受限 provenance，不立即生产修**。合法隔离持久会话 public 链的失败本身有效，不需要真实用户事故才算 production reachability；但根因候选是 **required registry key / 注册时点链**，不是 provider 自报缺 ready（后者只是 fixture 门禁按设计 fail-closed 的症状）。按门禁与任务合同：不改 production、不做预防性兼容、不继续真实实验（含 H2）。

### 主管决策（2026-10-14，本轮交付边界）

1. 先分类 3（来源尚未证实）保留现场补受限 provenance，不立即生产修；父层另派只读诊断（精确 fixture 白名单投影 + locked 代码 + 注册时点）再按证据决定最小修复；中文 bug 记录单独指定 scope。
2. 本轮仅把已得结果 / actual fixture identity / first divergence / 未证实因素完整追加本 record，然后交付并释放 unit+visible-host；**不再启动 Host、不改 harness/production、不申请全真实配置读、不读自身真实 session/state**。
3. hb-vhjjea **完整保留**：不 rm、不 raw worktree 删除；无残留 process 事实用 PID/birth + exit/ps 记录（见上文现场事实）；broker 仅自身 namespace 已移除，不扫其它 root。
4. H1 重跑/H2 继续阻塞，直到 provenance 与所需修复验收；此时正常结束不算心跳通过。

### Source provenance 分类（H1 运行轮）

- **本轮新增改动**：仅本文（记录层）；三个 harness/fixture 源文件零改动（H1v 状态原样，含重验 tsc exit 0）。
- **fixture 构造错误**：无——失败链不涉及 fixture 拼造数据；provider 门禁是按设计 fail-closed 的症状，不作为根因。
- **production**：required registry 键/注册时点链两段均为 production 代码；未修改；归类「来源尚未证实」，待父层只读诊断闭合实际键值与注册时点后再定最小修复。
- **未运行/未验证**：lease 就绪（renewalSequence≥1）、barrier 释放、public workspace dispose、正常释放后 remaining 核对、parentDeath 分支全部未到达。

### Source provenance 分类

- **fixture2（本轮已修）**：`test/fixtures/heartbeat-provider.ts` JsonObject 对齐实际公共 SDK 类型（2 行）。
- **harness 命令对齐（本轮记录，production 零改动）**：tsc 命令四项对齐（见第 5 条），理由与语义如上，供父层复核。
- **production**：`process-birth-identity.ts` 等 TS2339 为 ambient 增广程序组成伪差，非生产缺陷，未修改，不构成生产补丁需求。
- **未运行/未验证**：prepare-only、H2、真实 Host readiness、workspace dispose；后续须另行授权。

## H1p rerun（2026-10-14，H1-key 修复后真实 prepare-only）

**结果：命令 exit 1（fail-closed，未补杀、未删现场、未 retry）。H1-key 修复已现场实证生效：required 三项注入 + ACK + lease renewalSequence=1 + barrier + managed worktree 全部真实达成。本轮 first divergence 不再是 required 注入，而是 harness 自身的父 birth 比较入口错误（类别 2）。仍未进入 prepare dispose、未进入 H2；`parentDeathExperiment:false`。prepare-only 未通过，不得当作父死 heartbeat 通过。**

### 授权与实际执行边界

- 用户授权：实际隔离 prepare-only；明确不 SIGKILL、不 kill group/child、不 rm/root/worktree、不真实任务/网络/provider/credential。本轮全部遵守：未发任何信号（包括未对 fixture 进程发 SIGTERM/SIGKILL），未 `rm` 任何 fixture/worktree，未 raw `git worktree` 操作，无网络/真实 provider（fixture provider 全部内存生成，`baseUrl: http://127.0.0.1:9` 从未请求）。
- 资源：独占 `visible-host` + `unit-runner`；F1/F2/F4/F5 并行 dirty 零触碰（本轮唯一写入为本文）。
- 旧现场 `hb-vhjjea`：按要求保留，**未复用、未读取、未列举其内容**；本轮由 harness `mkdtemp` 生成全新 fixture 根。
- 未读真实用户数据：未读自身或任何真实 session 正文/prompt/authority/grant/settings/models/auth/state；fixture 侧仅读 `launch.json`/`failure.json`/`parent-observations.jsonl`/`child-36314.jsonl`/两个 `status.json` 的身份与扩展字段投影/`runner.stderr.log`/`process-terminal.json`，以及 fixture 仓 `git status`+`probe.txt` 未改事实。

### 开跑前静态校验（三源全读 + 前提逐项确认）

已完整读取：统一计划 H1/H1-key/H2 段（`docs/plans/2026-10-13-remaining-runtime-execution.md:299-327`）、本文全文、`docs/bugs/2026-10-14-required-child-session-identity.md` 全文、harness 三源全文（`test/heartbeat-parent-death.integration.mjs` 313 行、`test/fixtures/heartbeat-parent-host.ts` 31 行、`test/fixtures/heartbeat-provider.ts` 156 行）。harness 零修改。

harness 前提逐项确认（file:line）：

- **managed worktree:true**：`test/fixtures/heartbeat-provider.ts:22` `worktree: true`（`heartbeatContract`），writePaths `['probe.txt']`，acceptance 要求不改文件；运行时实证 child cwd 为 fixture state 内 managed worktree（见下）。
- **临时 Git 合法 commit**：`heartbeat-parent-death.integration.mjs:96-105` `git init -b main` + 局部 `user.name/user.email`（无全局 config）+ `add probe.txt` + `commit -m "test(heartbeat): 增加隔离只读探针"`，并断言 `--git-common-dir` 在 fixture 内；本轮实际 commit `1e0db23`。
- **固定 uid broker namespace + 随机 ID**：`:110-115` `rootSessionId = heartbeat-${randomUUID()}`、`brokerSocketPath(rootSessionId)`、启动前仅 `lstat` 本次精确 namespace（ENOENT 确认，`launch.json.brokerNamespaceAbsentBeforeLaunch:true`），不枚举共享 `/tmp/pi-root-subagent-501`。
- **白名单 env**：`:52-63` `fixtureEnvironment` 为固定字面量键集，**不展开 `process.env`**；执笔环境本身含 `PI_SUBAGENT_CHILD=1`/`PI_HOST_ROOT`/`PI_REAL_BIN`/`PI_SESSION_*` 等真实变量，均未注入 fixture Host（fixture 内 `PI_HOST_ROOT`/`PI_REAL_BIN`/`PI_PACKAGE_DIR` 由 whitelist 重写为 physical SDK 路径），无任何 API_KEY/TOKEN/SECRET/PASSWORD/AUTHORIZATION 键。
- **workflowPid=parent / runnerPid=child**：`:44-46` `assert.equal(ready.workflowPid, ready.parentPid)`、`assert.equal(ready.runnerPid, ready.childPid)`、`assert.equal(ready.runnerBirth, ready.childBirth)`；本轮运行时已实际成立（workflow `pid=36194`=父 Host；leaf `pid=36314`=`child-36314.jsonl` 的 pid）。
- **H1-key 修复已在位**：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1732` `const sessionId = ctx?.sessionManager?.getSessionId();`（仅此一处 diff，+3/-1，含中文注释）；`lifecycleSessionIdentity` 其它用法未改。上游查找键同版本核实：`pi-subagents@0.75.0` `async-execution.js:745/1513`（`ctx.parentSessionId ?? ctx.currentSessionId`）、`subagent-executor.js:3472`（`data.parentPiSessionId`）、`:4743`（`ctx.sessionManager.getSessionId()`）均为 Pi session ID。
- **physical SDK / CLI flags**：`test/helpers/pi-runtime.mjs` `resolvePiCodingAgentRoot({env:{}})` → 本仓 `node_modules/@earendil-works/pi-coding-agent`（**1.0.4**，`dist/cli.js` 存在），无 global 回退；`dist/cli/args.js` 逐个确认 `--mode/--session-id/--no-extensions/-e/--no-skills/--no-prompt-templates/--no-themes/--no-context-files/--no-mcp/--offline/--no-approve/--provider/--model/--thinking/--session-dir` 均存在；`pi-subagents` 0.75.0；Node v26.8.1（>=22.19.0）。
- **门禁 env / 残留 / staged**：开跑前 `env | grep -c PI_RUNTIME_HEARTBEAT` = **0**；`ps` 无任何 hb- fixture 进程；`git diff --cached --name-only` 为空。

### 实际命令与退出码（按执行顺序，无 pipe 掩盖 exit）

1. 合同 fixture tsc（计划 H1 第三条原样）：`node_modules/.bin/tsc --noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck test/fixtures/heartbeat-parent-host.ts test/fixtures/heartbeat-provider.ts` → **exit 1**，唯一输出 `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.`（tsc **7.0.2** 行为，与 H1v 第 1 条记录一致，非 fixture 回归）。
2. H1v 已记录并经父层复核的四项对齐命令（`--ignoreConfig --strict false --types node` + 附加 `packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts` 恢复 ambient `Error.code` 增广）→ **exit 0**：fixture 两文件在 H1-key 修复在位下对真实 SDK 类型干净。
3. 唯一真实命令（授权原样）：`env -u PI_RUNTIME_HEARTBEAT_PARENT_KILL PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs` → **exit 1**（窗口 `2026-10-14T10:26:54Z` → `10:27:11Z`）：`tests 3 / pass 2 / fail 1 / skipped 0`。pass：默认关闭+互斥+env 白名单、readiness 字段矩阵。fail：Host 用例 16946ms，`AssertionError` at `test/heartbeat-parent-death.integration.mjs:167`，actual `b340565b8d7c46084141ae0c106eecc191417d52fbbda653c8ce529f69f164c2` vs expected `bc3345519bcd1b59e8c7187152e52cd99eac3d3d7a4537e1cb28b662a16a9eba`。完整输出保留于 `/tmp/h1p-rerun-36167.log`。

本轮未执行：`node --test test/subagent-runtime-membrane.test.mjs`、package typecheck（H1-key 已验收 94/94 + 0，不重复占用 unit-runner）、H2、任何 npm test/all-integration。

### 新 fixture 现场事实（fixtureRoot=`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-fTmWES`，完整保留）

身份：harnessPid **36171**；parentPid **36194**；runner/childPid **36314**（runnerPid=childPid 成立）。rootSessionId `heartbeat-0dbc8cac-8ff9-40e5-bf88-8a273cf522c4`；brokerNamespace `/tmp/pi-root-subagent-501/3868a5c3b4cc1eb5842723268ae702ea52b61431306e995bb83f0a18867770e7.sock`（启动前 lstat ENOENT）；workflowRunId `c65f9ad6-3879-4096-86f8-662821889560`；leaf runId `9687eafb-d5cb-4b37-8484-8a46f2ae08ce`（workflowKey `typed-1e424304-920f-4870-afd3-99210341b6eb`）；leaseId `lease-1d4162f5326d028addb93cdb8ca8297382d10c441a0ab913`；ownerGeneration **1**。managed worktree：`<fixtureRoot>/state/repositories/0b929b20106292d79fd81e43c31d08c3c45843fb9ce244f9de54a2319049b9a5/worktrees/fc07e1d9-423e-4fcd-b1a5-debb6509d2dd`。sessionFile（持久会话事实）：`<fixtureRoot>/sessions/2026-10-14T10-26-55-629Z_heartbeat-0dbc8cac-….jsonl`（与 `launch.json.rootSessionId` ID 字符串**同时存在且不相等**，即 H1-key 缺陷拓扑）。

birth（sha256，均同一 `ps -ww -p PID -o lstart= -o command=` 算法）：

- `launch.json.parentBirth`（harness 在 spawn 后立即捕获，**pre-title**）= `bc3345519bcd1b59e8c7187152e52cd99eac3d3d7a4537e1cb28b662a16a9eba`
- `parent-started.registry.processBirthIdentity`（production `root-broker-registry.ts:170` 在 Host 内捕获，**post-title**）= `b340565b8d7c46084141ae0c106eecc191417d52fbbda653c8ce529f69f164c2`
- child `owner.processBirth` = `b1facf2d48aa4da5c5385ef7f4eb18a5c46970064107094fccaf32e1f98ae7b5`，与 provider 内 `captureProcessBirthIdentity(process.pid)` 相等（不等会抛错，未抛 → runner 侧 birth 自洽；`pi-subagents` runner 全仓无 `process.title` 赋值）

时间序（observedAt epoch ms，全部来自现场 jsonl）：parent-started …616650（registry endpoint/pid/rootSessionId 与 launch 完全一致）→ workflow started …617501（pid 36194=父）→ leaf started …617545（pid 36314，agent executor，parentWorkflowRunId=c65f9ad6）→ child-session-started …618253（cwd=managed worktree）→ **acknowledged `root-session-owner`** …618260 → **owner receipt 读取** …618270（ownerGeneration 1）→ subscription-ready …618270 → **barrier-entered** …618270 → lease `renewalSequence:0` …618270（lastRenewedAt …617575/expiresAt …677575）→ lease **`renewalSequence:1`** …631434（lastRenewedAt …631418/expiresAt …691418）→ harness 断言抛错 → process-terminal（runner 36314 **exitCode 0 / signal null**，proof state=observed）…631802。

leaf `status.json` 投影（只取身份/扩展字段，未读正文）：

- `launchResolvedExtensions.required = ["root-session-owner","integration-queue","agents-shared"]`，`omitted.required = 0`，`disableAmbientExtensions = true`，`runtime`/`configured`/`effective` 各非空 → **H1-key 修复在真实持久会话 + managed worktree child 上生效**（对比首轮 `required=[]`）。
- `runtimeAcknowledgedExtensions = { source:"child-runtime", ids:["root-session-owner","integration-queue","agents-shared"], omitted:0 }` → 与 required 集合逐项匹配的真实 ACK。
- `runner.stderr.log` 独立佐证 `integration-queue` 实际加载运行：`phase:"integration-gate-passed", eligible:true, queueState:"absent"`；随后 `integration-lifecycle-disposition-blocked / reason:"terminal-proof-unavailable" / error.code:"root_closing"` 与 `advance-error "Root session is closing"`——均发生在 harness 抛错后父 Host 关闭阶段，是本轮中断的结果而非缺陷。
- 终态 `state:"stopped"`、`error:"Subagent stopped by user."`（父 Host 因 harness 失败退出、stdin EOF 正常关闭导致 child 中止）；workflow `status.json` `state:"complete"`、`pid:36194`。
- `subagent` typed 工具本轮 **success**：collectReady 已越过 `:151-158`（`tool_execution_end`/`isError` 非真、`details.runId`+`workspace_id`+`asyncDir`+`dispatch_cwd` 齐备、`status.state==="running"`、`status.pid===started.pid`、containment 均通过），否则不会到达 `:167`。

fixture 仓事实：`git status --short` 空、`probe.txt` 内容未变、仅一条合法 commit `1e0db23 test(heartbeat): 增加隔离只读探针` → child 未修改任何仓库文件。

### first divergence 与机制证明

失败断言：`test/heartbeat-parent-death.integration.mjs:167` `assert.equal(parentStarted.registry.processBirthIdentity, f.birth)`；其中 `f.birth` 由 `:126` `captureProcessBirthIdentity(host.pid)` 在 **spawn 后立即**捕获，而 registry 值由 production `root-broker-registry.ts:170` 在 **Host 内 `session_start` 时**捕获。

两次捕获之间，physical SDK 必然改写 argv 内存：`node_modules/@earendil-works/pi-coding-agent/dist/cli.js:4` `setupCli()` → `dist/cli/setup.js:4` `process.title = APP_NAME`（Node 语义：赋值 `process.title` 会覆写 argv 内存，`ps -o command=` 随之变短），而 `captureProcessBirthIdentity`（`packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts:47-61`）的 sha256 输入含 `-o command=`，故 hash 必变。首轮 H1 现场已隐含同一现象（`launch.json.parentBirth d2698b6a…` vs registry `bc64a95b…`），当时因 required 缺失未到达该断言。

隔离机制探针（无 Pi Host、无网络、无 fixture；`/tmp/birth-title-child.mjs` + `/tmp/birth-title-probe.mjs`，均新建于 /tmp，子进程 stdin 结束后自行 exit 0，未发任何信号）：同一 PID **44976**、同一 `lstart`，仅执行一次 `process.title = "pi"`：

- before：`command=` 为完整 argv（`node /tmp/birth-title-child.mjs --mode rpc --session-id probe-session --offline --no-approve`），birth `20ef8b92520dc3005e5443f8d9404f328d31276dd28aaa368a28ece338e64a07`
- after：`command=` 为 `pi`，birth `8d559be631dd411dab3588eec3ff7fe4085431c909f04a1cff3518ae08bf8ecf`，`same:false`，`childExitCode:0`

即：**同一活进程的 birth identity 会因 `process.title` 合法变化而不同**；跨该变化点做相等断言的比较器无效。

受影响点（同一根因，本轮只暴露前两处）：`:167`（已抛）、`:192` `processBirthIdentityMatches(f.host.pid, f.birth)` “ready 时父身份已消失”（必然接着抛）、`:179` `ready.parentBirth = f.birth` → 污染 `:214` `remaining()`（活父会被误判为 `pid-reused` 而当作已结束，对 H2 是**假阴性**风险）与 `:236` H2 SIGKILL 前 birth 复核（必然抛）。`:133` `launch.json.parentBirth` 仅作诊断记录，无需断言语义。

### 分类（按仓库缺陷数据来源分类门禁）

- **harness → 类别 2（测试制造的非预期数据 / 实际入口错误）**：不匹配不是 production 数据被错误处理，而是测试在 production 不可能观察到的时点（`setupCli()` 之前的 spawn 瞬间）取样，再与 production post-title 取样做相等断言。production 无任何路径可在 title 改写前捕获（title 在任何 extension/broker 代码之前设置）。
- **production → 无缺陷，未修改**：registry 值是权威的、与活进程一致的——`root-broker-client.ts:72` 在连接时用 `processBirthIdentityMatches(registry.pid, registry.processBirthIdentity)` 做活体校验，而本轮 child 旁路客户端**连接成功并完成 owner.read + subscribe + 两次 lease push**，即该值在现场被独立证明与活父进程相符。不为测试增加任何兼容/fallback，不改 `captureProcessBirthIdentity`（包含 `command=` 是它的既定语义，且被 workspace coordinator/ledger 依赖）。
- **fixture provider / readiness 断言 → 无缺陷、未削弱**：provider 本轮未抛任何 fail-closed 错误（`child-36314.jsonl` 无 `observation-error`）；本轮未修改 harness/fixture 任何一行，未放宽任何断言。
- **未知项 → 无**：机制已由确定性探针 + file:line 双向证实，不需保留「来源未证实」标签。

### 残留与处置（未杀、未删）

- 进程：`ps -p 36171/36194/36314` 均无输出（harness、父 Host、runner 全部不存在）；未发任何信号。runner 36314 自行 exitCode 0/signal null（public process-terminal proof）；父 Host 36194 在 harness 抛出后由 `f.detach()` + 进程退出导致 stdin EOF，属正常 orderly shutdown（**不计父死实验证据**）。
- broker：本次精确 namespace socket 已随之移除（`ls` 报 No such file or directory）；未枚举/未触碰共享目录内其它 root。
- 保留现场：`hb-fTmWES` 全树保留，包括 `launch.json`、`failure.json`（harness 已写入 error/mode/parentExit:null/remainingFixturePids(childSupplementaryKill:false)/cleanupDisposition `retained; request supervisor exact fixture cleanup`/stderr）、`parent-observations.jsonl`、`child-36314.jsonl`、两个 asyncDir（含 `status.json`/`events.jsonl`/`runner.stderr.log`）、**未处置的 managed worktree `fc07e1d9-423e-4fcd-b1a5-debb6509d2dd`**、`sessions/`、`state/`、`agent/`、`tmp/`、`repository/`（含合法 commit）。
- 旧现场 `hb-vhjjea` 仍原样保留，本轮未读未动。
- 仓内：`git diff --cached --name-only` 空（无 staged）；本轮唯一写入为本文；未 commit/push/stash/reset。诊断辅助文件仅在 `/tmp`（`birth-title-child.mjs`、`birth-title-probe.mjs`、`status-projection.mjs`、`h1p-rerun-36167.log`），不在仓内。

### 最小修复合同（类别 2，**本轮未实施**；主管已确认语义，由父层另派精确 harness 修复任务）

目标：把父 birth 的权威取样移到 `process.title` 之后，并保持（实际加强）现有 readiness/H2 安全语义；只动原 4 文件范围，不动 production。

1. `test/fixtures/heartbeat-parent-host.ts`：在已有 `session_start` 处理器内额外 `await captureProcessBirthIdentity(process.pid)`，随 `parent-started` 记录为 `hostBirth`（与 broker registry 代码路径独立的第二个 post-title 取样）。
2. `test/heartbeat-parent-death.integration.mjs`：
   - `:167` 改为双 post-title 取样相等 + 活体复核：`assert.equal(parentStarted.registry.processBirthIdentity, parentStarted.hostBirth)` 且 `assert.ok(await processBirthIdentityMatches(parentStarted.registry.pid, parentStarted.registry.processBirthIdentity))`；`:166` `registry.pid === f.host.pid`（direct-spawn 绑定）保留不变。
   - `:133` `launch.json` 保留 pre-title 值但重命名为 `spawnBirth`（并记录 `spawnBirthCapturedBeforeProcessTitle:true` 与 `dist/cli/setup.js:4` 依据），另存 `registryBirth`/`hostBirth`；两者不等是预期事实，不得当作 PID 复用。
   - `:179` `ready.parentBirth` 改取 post-title 权威值，使 `:192`/`:214`/`:236` 全部使用同一权威 birth（修正 H2 `remaining()` 对活父的假阴性）。
   - **不得**放宽：`renewalSequence >= 1`、containment、`workflowPid===parentPid`、`runnerPid===childPid`+同 birth、64-hex birth 正则、`expiresAt > leaseReceivedAt`、ACK/bound/toolExit 断言、provider fail-closed 门禁、无 finally kill/rm 语义，全部逐字保留。
3. 修后本轮**不重跑**（合同要求停止重跑）；重跑需另行授权并重新生成新 fixture。

### 主管裁决（2026-10-14，H1p rerun 轮交付边界）

1. 确认类别 2（采样时点）证据成立；同时明确：required/ACK/lease 已实证**不等同** prepare-only 全部 pass，更不等同 H2（H2 未跑）。真实 PID birth 含 argv，在 `process.title` 变化前后不稳；最小 harness 修合法，**不改 production**。
2. 本轮 dispatch writePaths 只有 record：**不扩写路径、不修 harness、不重跑、不发信号、不保持存活等待**；追加完整证据后交付结束并释放 `unit-runner` + `visible-host`。不得以工具 task 正文的模糊许可越 writePaths（该冲突已由父层纠正）。父层另派两个精确 harness 文件修复 + unit 验证，后续新 prepare 另派。
3. `parentBirth` 权威来源应为 **post-title 的 parent probe 取样 + registry 值匹配 + 活体复核**；`spawnBirth` 仅作 historical pre-title 证据，**不得把不同摘要当作 PID reuse**；loop readiness 其它门禁（renewalSequence>=1、containment、拓扑等式、ACK/bound/toolExit、时间单调/未过期）全部保持。
4. 现场处置：`hb-fTmWES` 与 `hb-vhjjea` **完整保留**；managed workspace 未处置状态如实记录；无进程残留依据 known PID + public process-terminal proof + `ps`；不 raw `git worktree`、不 `rm`。**本轮未授 cleanup**，后续从 public workspace API 的权威 allowed 状态安排，不得直接删 root。

### 本轮未达成 / 未验证（不得外推）

- 未达成：prepare-only 整体通过；`release-barrier` 释放与 child 自然完成；public `subagent_worktree status` + allowed action token `dispose/discard`；正常 stdin/Host close 后的 `remaining` 空核对；`prepare-result.json`（本轮只有 `failure.json`）。
- 未进入：H2 `parentDeath` 分支从未执行，无 SIGKILL、无 latency/childExitAt/terminationReason 数据；`parentDeathExperiment:false`。**不得将本轮任何结果当作父死 heartbeat 通过。**
- 已真实达成且可引用：required 三项注入、`omitted.required=0`、ACK ids 匹配、owner receipt（generation 1，birth 自校）、subscribe lease push、**renewalSequence=1**、barrier entered、managed worktree 分配与 containment、workflowPid=parent/runnerPid=child 拓扑、fixture 仓零修改。
- 未验证：`assertReady` 全字段在真实现场的最终通过性（本轮在 `:167` 即中断，`:168-192` 未被真实数据执行）；lease 更长序列（>=2）；dispose 路径。

### Source provenance 分类（H1p rerun 轮）

- **本轮新增改动**：仅本文（记录层）。harness 三源、production、统一计划、其它任务现场**零改动**。
- **fixture 构造错误**：无（provider/parent-host 未抛错，未拼造 projection，未绕过 public 入口）。
- **测试 harness 错误（类别 2，已定位未修）**：`test/heartbeat-parent-death.integration.mjs:167/:192/:179→:214/:236` 使用 pre-`process.title` 的父 birth 作为比较器。
- **production**：无缺陷，无修改需求；明确拒绝为测试增加 birth 归一化/fallback。

### 本轮交付与资源释放

本轮唯一写入为本文（record）；harness 三源与 production 零改动；`git diff --cached --name-only` 空，未 commit/push/stash/reset。未发任何信号，未 rm，未 raw worktree 操作，未授 cleanup 因此未做任何清理；`hb-fTmWES`（含未处置 managed worktree `fc07e1d9-423e-4fcd-b1a5-debb6509d2dd`）与 `hb-vhjjea` 均完整保留，待父层后续按 public workspace API 权威 allowed 状态安排处置。诊断辅助文件仅存于 `/tmp`（`birth-title-child.mjs`、`birth-title-probe.mjs`、`status-projection.mjs`、`h1p-rerun-36167.log`），不在仓内、不属 fixture 现场。`unit-runner` 与 `visible-host` 于本文交付后释放。

## H1p run3（2026-10-14，sampling 修复后第三次真实 prepare-only）

**结果：命令 exit 1（fail-closed；未补杀、未 rm、未自动重试、未改任何代码）。上一轮 sampling 修复已实证生效，本轮 first divergence 前移到 harness 的第二个比较器缺陷——跨 locale 的 `ps` birth 摘要比较（类别 2）。仍未进入 prepare dispose、未进入 H2；`parentDeathExperiment:false`；prepare-only 未通过。**

### 授权与实际执行边界（本轮逐项遵守）

- 唯一实际命令即合同原样那条；未执行 tsc（fixture 已验收编译 0）、未执行 package check/H1 key 单测（已验收 94/94 + 0）、未占用 `unit-runner`、未跑全仓测试；`visible-host` 本任务独占，交付即释放。F2b-final 并行任务代码零触碰。
- 未发任何信号（无 SIGKILL/SIGTERM，无 child/runner 补杀）、未 `rm`、未 raw `git worktree`、无网络/真实 provider（fixture provider 全内存生成，`baseUrl: http://127.0.0.1:9` 从未请求）、无真实任务派发。
- 未改 harness/fixture/production 任何一行（三源与 `extension.ts` 本轮零写入）；本仓唯一写入为本文；`git diff --cached --name-only` 空，未 commit/push/stash/reset。
- 未读真实用户数据：无 user config/settings/auth/model/authority/grant/session 正文读取；fixture 侧只读身份与扩展字段投影（`launch.json`/`failure.json`/`parent-observations.jsonl`/`child-82666.jsonl`/两个 `status.json` 投影/`runner.stderr.log`）与 fixture 仓 `git status`+`probe.txt` 未改事实；未 dump raw task prompt。旧现场 `hb-fTmWES`/`hb-vhjjea` 仅存在性检查，未读、未复用、未删。

### 开跑前静态校验（全文读取 + 前提逐项确认）

已全文读取：本文全文（322 行）、harness 三源全文（`test/heartbeat-parent-death.integration.mjs` 329 行、`test/fixtures/heartbeat-parent-host.ts` 36 行、`test/fixtures/heartbeat-provider.ts` 156 行）、统一计划 H1/H1-key/H2 段（`docs/plans/2026-10-13-remaining-runtime-execution.md:299-327`）。

- **两处修复均在位（本轮实证生效）**：production `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1734` `const sessionId = ctx?.sessionManager?.getSessionId();`（含中文注释，`lifecycleSessionIdentity` 其它用法未改）；fixture `test/fixtures/heartbeat-parent-host.ts` 在 `session_start` 内 `hostBirth = await captureProcessBirthIdentity(process.pid)` 随 `parent-started` 单条原子记录；harness `:174-179` 为「双 post-title 取样相等 + registry 活体复核」，`:127/:133` 的 spawn 瞬间值已降级为 `spawnBirth` 历史诊断。
- **门禁/残留/staged**：`env | grep -c PI_RUNTIME_HEARTBEAT` = **0**；`ps` 无任何 hb-/heartbeat fixture 进程；`git diff --cached --name-only` 空；`node --check test/heartbeat-parent-death.integration.mjs` exit 0。
- **环境**：Node v26.8.1（>=22.19.0）、physical SDK `@earendil-works/pi-coding-agent` **1.0.4**（`test/helpers/pi-runtime.mjs` 公开 helper 解析本仓 root，无 global 回退）、`pi-subagents` **0.75.0**；执笔 shell `LANG=zh_CN.UTF-8`、`LC_ALL` 空（此事实即本轮 first divergence 的成因之一，见下）。

### 实际命令与退出码

`env -u PI_RUNTIME_HEARTBEAT_PARENT_KILL PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs` → **exit 1**（窗口 `2026-10-14T10:56:19Z` → `10:56:37Z`，输出无 pipe 掩盖 exit，完整日志 `/tmp/h1p-run3.log`）：`tests 3 / pass 2 / fail 1 / skipped 0`。pass：默认关闭+互斥+env 白名单、readiness 字段矩阵。fail：Host 用例 **17140.834958ms**，`AssertionError [ERR_ASSERTION]: registry birth 与活父进程不符` at `test/heartbeat-parent-death.integration.mjs:178`（actual `false` / expected `true` / operator `==`）。

### 新 fixture 现场事实（fixtureRoot=`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-iKUNgy`，完整保留）

身份：harnessPid **82310**；parentPid **82334**（ppid=82310，direct spawn）；runner/childPid **82666**（ppid=82334，runnerPid=childPid 拓扑成立）。rootSessionId `heartbeat-eb11fafb-b971-4fe9-b3e7-60f7353acacc`；brokerNamespace `/tmp/pi-root-subagent-501/efd52905154bd1ba7ba4123c4601738e6cfc5200e1af6da858eb33f9fee112fc.sock`（启动前 lstat ENOENT，`launch.json.brokerNamespaceAbsentBeforeLaunch:true`）；workflowRunId `962bc08d-c10f-42dc-a44a-cd48792ffcef`（pid 82334=父，agent workflow）；leaf runId `679f86c5-dfd2-4b13-b628-2753d14c2c51`（agent executor，workflowKey `typed-e59aa836-7904-4049-9661-7c72b2769015`，parentWorkflowRunId=962bc08d）；leaseId `lease-62ddce85f265ba5e20783f2904be57e5f4ac34228acf367f`；ownerGeneration **1**。sessionFile（持久会话事实）：`<fixtureRoot>/sessions/2026-10-14T10-56-21-151Z_heartbeat-eb11fafb-….jsonl`（与 rootSessionId ID 字符串同时存在且不相等，即 H1-key 缺陷拓扑）。managed worktree：`<fixtureRoot>/state/repositories/e2a2cbfb31c46d53e17d30ab826498573d6f5aabe6727659b8c819fd0430a3df/worktrees/0f80fe6d-7352-4370-bead-a75df6297449`（**未处置**）。

birth（sha256，同一 `ps -ww -p PID -o lstart= -o command=` 算法）：

- `launch.json.spawnBirth`（harness spawn 后立即捕获，**pre-title + harness locale**）= `7da93115fc23db9db22b87ee9fabd5cbb7268df1edfc4da9895bc4c221330dad`，仅历史诊断。
- `parent-started.hostBirth` == `registry.processBirthIdentity`（两次**独立 in-process post-title + C locale** 取样）= `634524e2f215ce55d077609739ca4973559fd62681a6b13a76441bb14729e040` → `:176-177` 以真实数据通过，证明上一轮 sampling 修复生效。
- child `owner.processBirth` = `562b653184e4b33255e9984e7c854fa9a5bc3ae27418d2294dedbabd0ff57d84`，与 provider 内 `captureProcessBirthIdentity(process.pid)` 相等（不等会抛错，未抛 → runner 侧自洽，runner 继承父 C locale）。
- harness 在 `:178` 的第三次取样（**harness locale**）摘要未知（`assert.ok` 不回显 actual 值），但机制已由隔离探针确定性证明与上值不同。

时间序（observedAt epoch ms，全部来自现场 jsonl）：parent-started …382387（registry endpoint/pid/rootSessionId 与 launch 完全一致）→ workflow started …383453（pid 82334=父）→ leaf started …383513（pid 82666，parentWorkflowRunId=962bc08d）→ child-session-started …384314（cwd=managed worktree）→ **acknowledged `root-session-owner`** …384321 → **owner receipt 读取** …384331（generation 1，birth 自校通过）→ subscription-ready …384331 → **barrier-entered** …384331 → lease `renewalSequence:0` …384332（lastRenewedAt …383533/expiresAt …443533）→ lease **`renewalSequence:1`** …397095（lastRenewedAt …397080/expiresAt …457080）→ **harness `:178` 断言抛错** → process-terminal（runner 82666 **exitCode 0 / signal null**，proof state=observed）…397391，由父 probe 记录于 …397393。

leaf `status.json` 投影（只取身份/扩展字段，未读正文）：`launchResolvedExtensions.required = ["root-session-owner","integration-queue","agents-shared"]`、`omitted` 四项全 0、`disableAmbientExtensions:true`、`runtime`/`configured`/`effective` 均非空；`runtimeAcknowledgedExtensions = { source:"child-runtime", ids:[同三项], omitted:0 }` → **H1-key production 修复在真实持久会话 + managed worktree child 上再次生效**。终态 `state:"stopped"`、`error:"Subagent stopped by user."`（harness 抛错后父 Host 关闭导致 child 中止，是本轮中断的结果）；workflow `status.json` `state:"complete"`、`pid:82334`。`runner.stderr.log` 独立佐证 `integration-queue` 实际加载运行：`integration-gate-passed, eligible:true, queueState:"absent"`；其后 `integration-lifecycle-agent-end`、`disposition-blocked reason:"terminal-proof-unavailable" error.code:"root_closing"`、`advance-error "Root session is closing"`、`shutdown-inspect-failed` 均发生在 harness 抛错后的父关闭阶段，非缺陷。Host stderr 仅 `Warning: No project session found with id …; creating a new session with that id.`。

`subagent` typed 工具本轮 **success**：collectReady 已越过 `:151-173`（`tool_execution_end`/`isError` 非真、`details.runId`+`workspace_id`+`asyncDir`+`dispatch_cwd` 齐备、parent/workflow/leaf lifecycle 绑定、registry endpoint/pid/rootSessionId 与 launch 相等、containment），否则不会到达 `:178`。fixture 仓事实：`git status --short` 空、`probe.txt` 内容未变、仅一条合法 commit `fc55397 test(heartbeat): 增加隔离只读探针`（仅临时仓、局部 `user.name/user.email`，未触本仓 index）。

### first divergence 与机制证明

失败断言：`test/heartbeat-parent-death.integration.mjs:178` `assert.ok(await processBirthIdentityMatches(parentStarted.registry.pid, parentStarted.registry.processBirthIdentity), "registry birth 与活父进程不符")`。比较双方：registry 值由 production `root-broker-registry.ts:170` 在 **fixture Host 进程内**捕获（该进程 env 由 `:52-63` `fixtureEnvironment` 白名单固定为 `LANG:"C", LC_ALL:"C"`）；`processBirthIdentityMatches` 由 **harness 进程**执行，`defaultExecFile` 不传 env，因此继承执笔 shell 的 `LANG=zh_CN.UTF-8`。

`captureProcessBirthIdentity`（`packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts:47-61`）对 `ps -ww -p PID -o lstart= -o command=` 的**原始字节**做 sha256；`assertProcessBirthOutput:24-32` 显式同时接受英文与本地化 `lstart` 格式（`/^(?:Mon|Tue|…)/` 与 `/^\S+\s+\S+\/\s*\d{1,2}\s+…/`）却**不做归一化**，故摘要天然依赖读取方 locale；`processBirthIdentityMatches:65-69` 对摘要不等与捕获异常一律返回 false。

机制探针一（shell 级，同一活进程、同一 PID、同一 lstart）：本 shell PID 下 `ps -ww -p $$ -o lstart= -o command=` 在默认 env 输出 `三 10月/14 19:01:32 2026   /bin/bash -c …`（sha256 `c38393ac…`），在 `env LC_ALL=C LANG=C` 下输出 `Wed Oct 14 19:01:32 2026     /bin/bash -c …`（sha256 `75c3c3ae…`）→ **DIFFERENT**。

机制探针二（Node 级，精确复现 `:178`；`/tmp/h1p3-locale-probe.mjs` + `/tmp/h1p3-locale-child.mjs`，无 Pi Host、无 fixture、无网络，子进程 stdin EOF 后自然 `exit 0`，全程未发任何信号）：子进程 pid **93820**，env `LANG=C LC_ALL=C`，in-process 自报 birth `e1742103dafe9e37249704ee2ec65ef8e1277a0867766b5c82a35aca53262fee`；探针父进程 env `LANG=zh_CN.UTF-8`：

- `processBirthIdentityMatches(93820, e1742103…)`（即 harness `:178` 原样调用）→ **false**
- 同一 helper + 注入固定 C locale `execFile`（helper 既有公开 `{execFile}` 选项，**production 零改动**）→ **true**，且摘要与子进程自报值逐字相等
- 原始 `lstart=`：`三 10月/14 19:03:04 2026   /opt/homebrew/Cellar/node/26.8.1/bin/node /tmp/h1p3-locale-child.mjs` vs `Wed Oct 14 19:03:04 2026     /opt/…`；`childExit {code:0, signal:null}`，`childSupplementaryKill:false`

**活父反证（证明失败文案是 harness 伪差，不是父身份事实）**：child 侧 broker 客户端在 `root-broker-client.ts:72` 用 `processBirthIdentityMatches(registry.pid, registry.processBirthIdentity)` 做活体校验并**通过**（在 runner 内执行，继承同一 C locale），随后 `owner.read`（…384331）、`subscribe`（…384331）、两次 lease push（…384332、…397095，broker 在父 Host 进程内）全部成功；父 probe 在 harness 抛错之后仍于 …397393 记录 process-terminal。即父 Host 在 harness 判定「registry birth 与活父进程不符」之后依然存活且 registry birth 有效。

### 受同一根因影响的比较点（完整集合，本轮一律未修）

1. `:178`（本轮已抛）。
2. `:196` `runnerBirth = await captureProcessBirthIdentity(started.pid)`（harness locale）与 `ready.childBirth = owner.processBirth`（runner 内 C locale）→ `:43` `assert.equal(ready.runnerBirth, ready.childBirth)` 必失败；即使修好 `:178/:208`，assertReady 仍会在 `:43` 中断。
3. `:208` `processBirthIdentityMatches(f.host.pid, ready.parentBirth)`「ready 时父身份已消失」必抛（`ready.parentBirth` 为 in-parent C locale 值）。
4. `:215/:229` `identityEnded`/`remaining()`：**parent 角色**会把活父判为 `pid-reused` → prepare-only 与 H2 的残留核对都是**假阴性**（活父被当作已结束）；runner 角色两侧都在 harness 域，判定正确。
5. `:252` H2 SIGKILL 前父 birth 复核必抛（H2 被同一根因阻塞）；`:253` runner 复核一致。
6. `:127` `spawnBirth` 混合 pre-title + harness locale，只能作历史诊断，不得作比较器（现语义已如此）。

### 分类（按仓库缺陷数据来源分类门禁）

- **harness → 类别 2（测试制造的非预期数据 / 实际取样域错误）**：fixture 白名单 env 刻意固定 `LANG=C LC_ALL=C`（不继承 `process.env`，这是合同要求且正确），而 harness 自身在执笔 shell 的 locale 下捕获同一 PID，把两个 locale 域的摘要做相等/匹配断言。production 不存在该跨域比较。
- **production → 无缺陷，未修改**：跨进程 birth 比较全部在同一 env 域内——runner env 构造 `pi-subagents@0.75.0 src/runs/background/async-execution.js:470-479` 为 `{...omitGitRoutingEnv(omitExtensionBindingsEnv(process.env)), ...childCacheRetentionEnv(), …}`；`src/runs/shared/git-environment.js:1-27` 只过滤 `GIT_*` 路由变量；`src/runs/shared/extension-bindings.js:79-82` 只删绑定变量；`src/shared/child-cache-retention.js:19-22` 只加 `PI_CACHE_RETENTION`；pi-subagents 全 src 与 enhanced 包内**无任何 LANG/LC_ALL override**（grep 为空）。因此 `root-broker-client.ts:72`、`child-broker-binding.ts:13`、`root-broker-server.ts:406/440/883/901` 的比较双方始终同 locale。按门禁**拒绝**为测试在 production 增加 birth 归一化/locale fallback。
- **fixture provider / readiness 断言 → 无缺陷、未削弱**：provider 未抛任何 fail-closed 错误（`child-82666.jsonl` 无 `observation-error`）；本轮 harness/fixture 零改动，无任何断言放宽。
- **上一轮归因的修正**：上一轮 `:167` 的不相等同时含 **pre-title** 与 **跨 locale** 两个成因，当时探针只证明了 title 成因；title 修复后 locale 成因单独暴露为本轮 first divergence。上一轮分类结论（类别 2、production 无缺陷）不变，但比较器缺陷是**两个**而非一个。
- **未知项 → 无**：机制已由 shell 级与 Node 级两级确定性探针 + file:line 双向证实。
- **另行 triage 的观察（本轮未处置、未改任何代码）**：`packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts:73/154` 会把**持久化 lock 内**的 owner birth（写入方 Host 的 locale）与**另一 Host** 的重捕获（读取方 locale）比较；若两个 Host 运行在不同 `LANG/LC_ALL` 下，摘要不可比，活 owner 可能被读成 stale/reused。本轮无任何该类事实（fixture 用独立临时 state root），按门禁不做预防性兼容，仅记录供父层决定是否另派 provenance 任务。

### 残留与处置（未杀、未删）

- 进程：`ps -p 82310/82334/82666` 三次均无输出（harness、父 Host、runner 全部不存在）；`ps -ax` 无任何引用 `hb-iKUNgy` 的进程、无任何 hb-/heartbeat fixture 进程；**未发任何信号**。runner 82666 自行 `exitCode 0 / signal null`（public process-terminal proof）；父 Host 82334 在 harness 抛错后由 `f.detach()` + harness 退出导致 stdin EOF，属正常 orderly shutdown，**不计父死实验证据**。
- broker：本次精确 namespace socket 已随之移除（`ls` 报 No such file or directory）；共享 `/tmp/pi-root-subagent-501` 未枚举、未触碰其它 root。
- 保留现场：`hb-iKUNgy` 全树保留（`launch.json`、`failure.json`（error/mode/ready:null/parentExit:null/remainingFixturePids 两条 `birth:"unconfirmed"`/`childSupplementaryKill:false`/`cleanupDisposition:"retained; request supervisor exact fixture cleanup"`/stderr）、`parent-observations.jsonl`、`child-82666.jsonl`、两个 asyncDir（`status.json`/`events.jsonl`/`runner.stderr.log`/`process-terminal.json`）、**未处置的 managed worktree `0f80fe6d-7352-4370-bead-a75df6297449`**、`sessions/`、`state/`、`agent/`、`tmp/`、`repository/`（含合法 commit `fc55397`））。
- 旧现场 `hb-fTmWES` 与 `hb-vhjjea` 原样保留，本轮未读、未复用、未删。
- 仓内：`git diff --cached --name-only` 空；三源 harness 文件与 `extension.ts` 零写入（mtime/`git status` 与开跑前一致）；诊断探针仅在 `/tmp`（`h1p3-locale-probe.mjs`、`h1p3-locale-child.mjs`、`h1p-run3.log`），不在仓内、不属 fixture 现场。

### 最小修复合同（类别 2，**本轮未实施**，需父层另派精确任务）

目标：消除 harness 的跨 locale 取样域错误，production 零改动，且**逐字保留**现有全部 readiness/H2 安全语义。

1. 仅改 `test/heartbeat-parent-death.integration.mjs`：为所有与 fixture 域内捕获值比较的 harness 侧 `ps` 取样（`:178`、`:196`、`:215`）注入固定 locale 的 `execFile`（`LC_ALL=C LANG=C`，与 `fixtureEnvironment:52-63` 一致），使用 helper 既有公开 `{execFile}` 选项；不新增 production fallback、不改 `captureProcessBirthIdentity`/`assertProcessBirthOutput`（本地化容忍是 production 既定语义，被 workspace coordinator/ledger 依赖）。
2. 不得放宽：`renewalSequence >= 1`、containment、`workflowPid===parentPid`、`runnerPid===childPid` + 同 birth、64-hex birth 正则、`expiresAt > leaseReceivedAt`、ACK/bound/toolExit 断言、provider fail-closed 门禁、无 finally kill/rm 语义、H2 双门禁与 kill 面唯一性，全部逐字保留。
3. 修后先由 unit-runner 任务做单测（默认 2 pass / 1 Host skip）与 package typecheck，再**另派**一次全新 fixture 的 prepare-only（不得复用 `hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea`）；本轮按合同**不重试**。

### 本轮未达成 / 未验证（不得外推）

- 未达成：prepare-only 整体通过；`release-barrier` 从未写入，child 从未被释放（barrier 因父关闭被 abort）；public `subagent_worktree status` + allowed action token `dispose/discard` 未执行；harness 的正常 stdin close 后 `remaining` 空核对未执行（残留由本执笔以 `ps`/精确 socket lstat 手工实证为空）；`prepare-result.json` 未生成（本轮只有 `failure.json`）。
- 未进入：H2 `parentDeath` 分支从未执行，无 SIGKILL、无 killAt/latencyMs/childExitAt/terminationReason 数据；`parentDeathExperiment:false`。**不得将本轮任何结果当作父死 heartbeat 通过。**
- 已真实达成且可引用：required 三项注入 + `omitted` 全 0、ACK ids 逐项匹配、owner receipt（generation 1，birth 自校）、subscribe + 两次 lease push、**renewalSequence=1**、barrier entered、managed worktree 分配与 containment、workflowPid=parent / runnerPid=child 拓扑、双 post-title 父取样相等（`:177`）、fixture 仓零修改、runner exitCode 0 的 public process-terminal proof。
- 未验证：`assertReady` 全字段在真实现场的最终通过性（本轮止于 `:178`，`:180-208` 未被真实数据执行）；lease 更长序列（>=2）；dispose 路径；父死 watchdog 行为。

### Source provenance 分类（H1p run3 轮）

- **本轮新增改动**：仅本文（记录层）。harness 三源、production、统一计划、其它任务现场**零改动**。
- **fixture 构造错误**：无（provider/parent-host 未抛错，未拼造 projection，未绕过 public 入口）。
- **测试 harness 错误（类别 2，已定位未修）**：`:178`（已抛）、`:43`←`:196`、`:208`、`:215`→`:229` parent 角色假阴性、`:252`（H2 阻塞）。
- **production**：无缺陷，无修改需求；明确拒绝为测试增加 locale 归一化/fallback。`coordinator-registry.ts:73/154` 的跨 Host locale 可比性仅作观察记录，未处置。

### 主管裁决（2026-10-14，H1p run3 轮交付边界）

1. **确认分类 2**：harness 跨 locale 采样域错误，production 未证缺陷；**不改 production、不做 locale 归一化 fallback**。本轮 H1p run3 仍失败，**prepare-only 与 H2 均不通过**。
2. **harness-only 最小修复由父层另派独立任务**，本 run 不得越 writePaths 修改：所有 harness 侧 `processBirthIdentityMatches`/ps 取样明确注入固定 `LANG=C`、`LC_ALL=C`（优先调用 helper 已有 `execFile` env 选项）；保留全部 birth/ACK/lease/containment/topology/单 SIGKILL/no-finally-kill 断言。修后先跑默认单测（2 pass / 1 Host skip）+ fixture tsc / package typecheck，再用**全新 fixture** 执行 run4 prepare-only，仍不 SIGKILL。
3. **三个 root `hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea` 全部先保留**：不 `rm`、不 raw `git worktree`、不猜 allowed disposition；run4 后由父层逐个读取 public workspace status，按 `allowed_dispositions`/`action_token` 处置；若仍 active/preserved 由对应工具决策。
4. **跨 LANG 持久 coordinator owner birth（`workspace/coordinator-registry.ts:73/154`）是独立的潜在类别 3 观察，不并入 H1 修复**：父层另派只读 provenance 任务（不读真实 state、不修改 production）核实是否存在合法跨 locale 生产拓扑与首偏离点，**不得凭理论加兼容**。
5. 本 run **不继续等待/不重试**；追加记录后释放 `visible-host`/`unit` 并交付。

### 本轮交付与资源释放

本轮唯一写入为本文；未 commit/push/stash/reset，`git diff --cached --name-only` 空。未发任何信号、未 `rm`、未 raw worktree 操作、未授 cleanup 因此未做任何清理；`hb-iKUNgy`（含未处置 managed worktree `0f80fe6d-7352-4370-bead-a75df6297449`）、`hb-fTmWES`、`hb-vhjjea` 全部保留，待父层按 public workspace API 的权威 allowed 状态安排精确处置。已按合同在记录现场后 `contact_supervisor` 上报，不自动新 fixture 重试。`visible-host` 于本文交付后释放；本轮未占用 `unit-runner`、未执行 tsc。

## H1p run4（2026-10-14，跨 locale 修复后第四次真实 prepare-only）

**结果：命令实际 exit 0，`tests 3 / pass 3 / fail 0 / skipped 0 / cancelled 0`，Host 用例 21266.340542ms。H1 prepare-only 首次完整通过（readiness → barrier 释放 → child 自然结束 → public workspace 处置 → 父 orderly 退出 → 残留核对 → `prepare-result.json`）。本轮未进入 H2，`parentDeathExperiment:false`，未发任何信号。前三轮三处修复（repo required-key / fixture pre-title / 跨 locale 取样域）均经现场数据实证生效。**

### 授权与实际执行边界（本轮逐项遵守）

- 唯一实际 Host 命令即合同原样那条；**未执行 tsc**（fixture 编译 0 已验收）、**未执行 package check / H1-key 单测**（94/94 + 0 已验收）、**未占用 `unit-runner`**、未跑全仓测试、未跑默认 2pass/1skip 单测（已验收）；`visible-host` 本任务独占，与 F6/S1a 代码无重叠（本轮零代码写入），交付即释放。
- **未发任何信号**：无 SIGKILL/SIGTERM，无 child/runner 补杀，无负 PID/进程组操作。harness 内唯一 kill 面在 `test/heartbeat-parent-death.integration.mjs:266`（`parentDeath` 内），前置 `:255 assert.equal(process.env[KILL],"1")` 与 `:258-262` 四重复核；本轮 `PI_RUNTIME_HEARTBEAT_PARENT_KILL` 经 `env -u` 显式移除，`experimentMode` 返回 `prepare-only`，`parentDeath` 从未进入。旁证：`prepare-result.json.parentExit = {code:0, signal:null}`（非信号终止）。
- **未 `rm`、未 raw `git worktree` 删除**：本轮对 fixture 只读；唯一 git 调用为只读 `git -C <fixture>/repository worktree list` / `status --short` / `log --oneline`。旧 root `hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea` **不复用/不读取/不删除**，仅做目录存在性检查（三者均 EXISTS）。
- **未读真实用户数据**：未读自身或任何真实 session 正文/prompt/authority/grant/settings/models/auth/credential；未扫描 UID broker 其它 root（共享 `/tmp/pi-root-subagent-501` 未枚举）。fixture 侧只读自有诊断/元数据身份投影：`launch.json`、`ready.json`、`prepare-result.json`、`parent-observations.jsonl`、`child-37438.jsonl`、两个 asyncDir `status.json` 投影、`runner.stderr.log`、workspace 台账 `records/<workspaceId>.json` 的身份/处置字段、fixture 仓 `git status`/`log`/`probe.txt` 未改事实。
- 仓内唯一写入为本文；harness 三源、production、统一计划、其它任务现场零改动；`git diff --cached --name-only` 空；未 commit/push/stash/reset。诊断辅助文件仅在 `/tmp`（`h1p-run4.log`、`h1p-run4-projection.mjs`、`h1p-run4-projection.json`），不在仓内、不属 fixture 现场。
- 无网络、无真实 provider/模型：fixture provider 全部内存生成，`baseUrl: http://127.0.0.1:9` 从未请求；未派发任何真实任务。

### 开负前静态校验（全文读取 + 前提逐项确认）

已全文读取：本文全文（440 行，含 run1/rerun/run3 全部现场）、`test/heartbeat-parent-death.integration.mjs`（285 行）、`test/fixtures/heartbeat-parent-host.ts`（36 行）、`test/fixtures/heartbeat-provider.ts`（156 行）、统一计划 H1/H1-key/H2 段（`docs/plans/2026-10-13-remaining-runtime-execution.md:299-327`）。

- **跨 locale 修复逐调用核实在位**（本轮亲自 grep 全部 birth 调用点，非转述）：`:136 spawnBirth`、`:187 registry 活体复核`、`:205 runnerBirth`、`:217 ready 时父活体`、`:224 identityEnded`、`:229 ps 缺失佐证（显式 `env:{...process.env,LANG:"C",LC_ALL:"C"}`）`、`:261/:262 H2 kill 前双复核` ——**9 处全部传入 `{ execFile: cLocaleExecFile }`**；`:14-22 cLocaleExecFile` 仅用 production helper 既有公开 `{execFile}` 选项注入 `LANG=C LC_ALL=C`，**无字符串归一化 fallback**。`packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts` 本轮 `git status` **clean**（mtime 2026-10-03T13:03:29），`{ execFile = defaultExecFile }` 为原有公开签名。
- **pre-title 修复在位**：`test/fixtures/heartbeat-parent-host.ts` 在 `session_start` 内 `hostBirth = await captureProcessBirthIdentity(process.pid)`，单条 `parent-started` 原子携带 `hostBirth`+`registry`+`readLocale`；harness `:184-188` 为「双 post-title 取样相等 + registry 活体复核」，`:127/:133` spawn 瞬间值已降级为 `spawnBirth` 历史诊断。
- **required-key production 修复在位**：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1734` `const sessionId = ctx?.sessionManager?.getSessionId();`（+3/-1，含中文注释，mtime 2026-10-14T18:18:39 即 H1-key 任务遗留，本轮零写入）；`lifecycleSessionIdentity` 其它用法未改。
- **harness/fixture 零修改证据**：三源 mtime 开负前后一致（`heartbeat-parent-death.integration.mjs` 19:20:01、`heartbeat-parent-host.ts` 19:20:01、`heartbeat-provider.ts` 16:18:46），`git status --porcelain` 与开负前相同（三源 `??`、record `??`）。
- **门禁/残留/staged**：`env | grep -c PI_RUNTIME_HEARTBEAT` = **0**；`ps` 无任何 hb-/heartbeat fixture 进程；`git diff --cached --name-only` 空。
- **环境**：Node v26.8.1（>=22.19.0）；physical SDK `@earendil-works/pi-coding-agent` **1.0.4**（`launch.json.cli` 指向本仓 `node_modules/.../dist/cli.js`，无 global 回退）；`pi-subagents` **0.75.0**（`packages/pi-subagents-enhanced/package.json:39`，安装于包内 `node_modules/pi-subagents`）。执笔 shell `LANG=zh_CN.UTF-8`、`LC_ALL` 未设——即 run3 失败的外部条件，本轮由读取侧注入 C locale 消除。

### 实际命令与退出码（无 pipe 掩盖 exit）

命令原样执行，输出重定向到 `/tmp/h1p-run4.log` 后用 `; EXIT=$?` 直接取真实退出码（不经管道，无 `tail` 掩盖）：

```sh
env -u PI_RUNTIME_HEARTBEAT_PARENT_KILL PI_RUNTIME_HEARTBEAT_PREPARE_ONLY=1 node --test test/heartbeat-parent-death.integration.mjs > /tmp/h1p-run4.log 2>&1; EXIT=$?
```

→ **REAL_EXIT=0**（窗口 `2026-10-14T11:24:25Z` → `11:24:47Z`）。完整日志：

```
✔ heartbeat harness 默认关闭，prepare/H2 互斥，环境不继承真实 provider (0.904125ms)
✔ readiness 静态字段矩阵缺身份/ACK/lease 任一项均拒绝 (3.677833ms)
✔ 隔离 managed coding 实际父 Host/child heartbeat (21266.340542ms)
ℹ fixtureRoot=/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-b9YtbN；失败需精确 cleanup，harness 不补杀不删现场
ℹ tests 3 / suites 0 / pass 3 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 21363.208209
```

本轮未执行：tsc、`test/subagent-runtime-membrane.test.mjs`、package typecheck、H2、npm test/all-integration、任何真实 typed dispatch。

### 新 fixture 现场事实（fixtureRoot=`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-b9YtbN`，证据根保留）

身份：harnessPid **37258**；parentPid **37303**（ppid=37258，direct spawn）；runner/childPid **37438**（ppid=37303，runnerPid=childPid 拓扑成立）。rootSessionId `heartbeat-50b9d1f2-4bb1-437a-8ee2-6fa91da7f313`；brokerNamespace `/tmp/pi-root-subagent-501/e842a06a91d044a021248735604ebc2946c01b50af78d577956b105ad3a59447.sock`（启动前 lstat ENOENT，`launch.json.brokerNamespaceAbsentBeforeLaunch:true`）；workflowRunId `d8271db2-3995-42e6-a552-f226f9ffe20f`（`agent:"workflow"`，pid 37303=父）；leaf runId `a3ebd19d-ea71-47ee-91b6-9535b3f05972`（`agent:"executor"`，parentWorkflowRunId=d8271db2，workflowKey `typed-a556a752-a6c9-4835-b25f-8baf305240a5`）；leaseId `lease-3fd1d6933c7e45cdaf3724479d500f468096797053b8973e`；ownerGeneration **1**；workspaceId `f7813e1f-ad0b-4f56-bb8e-f3205366ae5b`。sessionFile（持久会话事实）位于 `<fixtureRoot>/sessions/`（与 rootSessionId ID 字符串同时存在且不相等，即 H1-key 缺陷拓扑，本轮由修复覆盖）。managed worktree：`<fixtureRoot>/state/repositories/b8c84951f3a3818b1a1bb5126266deee75eab6b2cdc538096a81da068f8d1e15/worktrees/f7813e1f-ad0b-4f56-bb8e-f3205366ae5b`（已按 public 处置释放，目录已不存在）。leaf asyncDir `<fixtureRoot>/tmp/pi-subagents-uid-501/async-subagent-runs/a3ebd19d-…`；workflow asyncDir 同级 `d8271db2-…`。fixture 仓：单一合法 commit `756b017 test(heartbeat): 增加隔离只读探针`（仅临时仓、局部 `user.name/user.email`，未触本仓 index）。

birth（sha256，同一 `ps -ww -p PID -o lstart= -o command=` 算法）与同 locale 事实：

- `parent-started.readLocale = {LANG:"C", LC_ALL:"C"}` ——parent probe 在 fixture Host 内记录的取样 locale，与 harness `fixtureEnvironment` 白名单一致。
- `hostBirth` == `registry.processBirthIdentity` == `ready.parentBirth` == `ready.hostBirth` == `ready.registryBirth` = **`6ecfde864e4f569378dc03249986784f2481eb9be8aa9f24b95628a5abde7610`**（两次独立 in-process post-title + C locale 取样相等，且 harness 以 C locale `execFile` 对活父复核通过）。
- `launch.json.spawnBirth` = `920c7cb7e55dcec6634607536bfca1f723570e8da16c3dad91f41f0d384b0f1d`（pre-title，`spawnBirthCapturedBeforeProcessTitle:true`）——与权威值不等是预期事实，**未当作 PID 复用**，仅历史诊断。
- `runnerBirth` == `childBirth` = **`7bd68679de19927bea82ccde9f35868690eae8ed5c95842773891bbd5566b05f`**（harness C locale 取样 == runner 内 `owner.processBirth`；provider 内 `captureProcessBirthIdentity(process.pid)` 不等会抛错，未抛 → runner 侧自洽）。

时间序（observedAt epoch ms，全部来自现场 jsonl）：parent-started …068419（registry endpoint/pid/rootSessionId 与 launch 完全一致）→ workflow started …069594（pid 37303=父）→ leaf started …069645（pid 37438，parentWorkflowRunId=d8271db2）→ **`subagent` typed 工具 tool_execution_end success** …069704 → child-session-started …070493（cwd=managed worktree）→ **acknowledged `root-session-owner`** …070502 → **owner receipt 读取** …070515（generation 1，birth 自校通过）→ subscription-ready …070515 → **barrier-entered** …070516 → lease `renewalSequence:0` …070516（lastRenewedAt …069670/expiresAt …129670）→ lease **`renewalSequence:1`** …083121（lastRenewedAt …083106/expiresAt …143106）→ readyAt …083205（`ready.json` 落盘）→ `release-barrier` 写入 19:24:43（local）→ process-terminal proof observedAt …084390（runner `exitCode 0 / signal null`，`runnerProcessInstanceId 7060d4be-2f13-417f-8dcf-b841a5363022`，`resumeDisposition:"resumable"`）→ 台账 `updatedAt 2026-10-14T11:24:46.902Z`（public discard）→ parentExit …087008（`code 0 / signal null`）→ `prepare-result.json` 19:24:47（local）。`child-37438.jsonl` 无 `observation-error`/`observer-eof` 条目；`provider-observations.jsonl` 为空（父侧 provider 无异常分支）。

leaf `status.json` 投影（只取身份/扩展字段，未读正文）：`launchResolvedExtensions.required = ["root-session-owner","integration-queue","agents-shared"]`、`omitted = {runtime:0, configured:0, required:0, effective:0}`、`disableAmbientExtensions:true`、`runtime`/`configured` 各 1 项、`effective` 5 项 sha256 摘要；`runtimeAcknowledgedExtensions = { version:1, source:"child-runtime", ids:[同三项], omitted:0 }` → **required 三项注入 + ACK ids 逐项匹配 + omitted 0 在全新 fixture 上第四次实证**（H1-key production 修复持续生效）。ready 时 `status.state=="running"` 且 `status.runId==handle.runId`、`status.pid==started.pid`（harness 断言通过）；workflow `status.json` `state:"complete"`、`pid:37303`。`runner.stderr.log` 独立佐证 `integration-queue` 实际加载运行：`integration-gate-passed, eligible:true, queueState:"absent"`。

### 合同逐项验收（全部以现场数据成立）

| 合同项 | 现场证据 |
| --- | --- |
| required 三项 / omitted 0 | leaf `status.json.launchResolvedExtensions.required` 三项，`omitted` 四项全 0，`disableAmbientExtensions:true` |
| ACK ids | `runtimeAcknowledgedExtensions.ids` 同三项、`source:"child-runtime"`、`omitted:0`；`child-37438.jsonl` …070502 真实 `subagent:acknowledge-extension` |
| root-owner-ready / owner read bound | `pi-config:root-owner-ready` 触发旁路订阅；`owner` 条目 …070515（generation 1，`owner.processBirth == captureProcessBirthIdentity(process.pid)`，不等即抛错）；`ready.bound:true/boundAt …070515` |
| lease renewalSequence >= 1 | 同一 leaseId 两次 push：`renewalSequence:0` …070516 → **`1`** …083121；`expiresAt …143106 > leaseReceivedAt …083121`、`lastRenewedAt …083106 <= leaseReceivedAt` |
| barrier 与工具回执 | `barrier-entered` …070516（cwd=managed worktree）；`toolExit:"success"`/`toolExitAt …069704`，`details.runId`+`workspace_id`+`asyncDir`+`dispatch_cwd` 齐备 |
| managed containment | `asyncDir`/`workflowAsyncDir`/`dispatchCwd` 均经 `contained(fixtureRoot, …)` 断言；worktree 实际路径在 `state/repositories/<hash>/worktrees/<workspaceId>` |
| workflow parent / runner child 拓扑 | `workflowPid 37303 == parentPid 37303`；`runnerPid 37438 == childPid 37438` 且 `runnerBirth == childBirth`；`parentPid != childPid`；`workflowRunId != runId`；ppid 链 37258→37303→37438 |
| post-title 同 locale birth + 活体校验 | `hostBirth == registryBirth == ready.parentBirth`（`6ecfde86…`），`readLocale {C,C}`，`:187` 与 `:217` 两次 `processBirthIdentityMatches(…, {execFile:cLocaleExecFile})` 均通过 |
| prepare barrier 释放 | `release-barrier` 已写入（mtime 19:24:43）；child 释放后自然结束，public process-terminal proof `exitCode 0 / signal null` |
| public workspace 处置 | fake 父回合经 public `subagent_worktree` status→dispose；台账 `managed-workspace-ledger.v2`：`state:"released"`、`disposition:{action:"discard"}`、`actionChallenge.allowed:["publish","discard","preserve","release"]`、`used:true`、`revision:6`、`cleanupDebt:null`；worktree 目录已不存在，`git worktree list` 仅剩主工作树，`worktrees/` 为空 |
| child-owned 不可父 integrate | `integrationIntent:null`、`integrationReceipt:null`、`integrationHistory:[]`、`publishedArtifact:null`；`request.owner.kind:"standalone-subagent"`；本轮无任何父侧 integrate 调用 |
| Host 退出 | `f.host.stdin.end()` 后 `parentExit {code:0, signal:null, at …087008}`（orderly shutdown，非信号） |
| 残留核对 | `assert.deepEqual(await remaining(ready), [])` 实际通过；`prepare-result.json.remainingFixturePids:[]`；执笔独立复核：`ps -p 37258 -p 37303 -p 37438` 无输出（exit 1），`ps -ax | grep hb-b9YtbN` 无匹配，精确 broker namespace socket ENOENT |
| fixture 仓零修改 | `git status --short` 空，`probe.txt` 内容未变，仅一条 commit `756b017` |
| 真实命令 exit 记录 | `REAL_EXIT=0`，窗口 11:24:25Z→11:24:47Z，日志 `/tmp/h1p-run4.log`，无 pipe 掩盖 |

### 观察与分类（未改任何代码，不预防性兼容）

1. **leaf run 终态 `state:"failed"`，`error:"Acceptance rejected: commands-run evidence missing from child report."`** —— 归类**类别 2（测试制造的非预期数据：fixture 报告不满足 production 验收契约）**。完整生成链：fixture `heartbeatContract` 未声明 acceptance level → 上游 `inferLevel`（`pi-subagents@0.75.0 src/runs/shared/acceptance.js:52+`）对 async declared writer 推定 `checked` → `requiredEvidenceForLevel("checked")`（`:43-51`）包含 `commands-run` → `reportEvidenceStatus`（`:1072`）要求 `Array.isArray(report.commandsRun) && report.commandsRun.length > 0` → fixture `test/fixtures/heartbeat-provider.ts:31-37 childReport()` 发 `commandsRun: []` → `:1119-1127` 生成 `evidence:commands-run failed` → `:1607` 拼出该 error。production 按设计 fail-closed，**无缺陷、未修改、未加兼容**。
2. **`integration-lifecycle-advance-error reason:"workspace admission requires the authorized clean committed HEAD" retryable:true`**（`runner.stderr.log` 末条，发生在 acceptance 拒绝之后、public dispose 之前的 child runner 侧）——同一 fixture 报告链的下游结果，fail-closed 且标记 retryable，runner 仍 `exitCode 0`；未生成任何 integration intent/receipt，**child-owned workspace 未被父 integrate**（与合同一致）。不单独归因 production，不做预防性兼容。
3. **两层 terminal proof 不同值**：run 级 `processTerminal.state:"observed"`（`exitCode 0/signal null`）vs workspace 台账 `terminalProof.state:"pending"`。如实记录，不推断、不合并语义。
4. **本轮无父 Host stderr 证据**：harness 仅将 `f.stderr` 写入 `failure.json`，本轮未产生失败因此未落盘；不得声称已核对 Host stderr。
5. **旧 root 处置**：`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea` 本轮按合同仅存在性检查（均 EXISTS，未读未动）；其内 **未处置的 managed worktree**（`0f80fe6d-…`、`fc07e1d9-…` 等）仍需父层逐个读 public workspace status，按 `allowed_dispositions`/`action_token` 合法处置；本轮**未授权、未执行**任何清理，不 raw 删除、不猜 allowed disposition。

### 本轮未达成 / 未验证（不得外推）

- **H2 `parentDeath` 分支从未执行**：无 SIGKILL、无 killAt/latencyMs/childExitAt/childIdentityEnd/terminationReason 数据；`parent-death-result.json`/`before-sigkill.json` 未生成；`parentDeathExperiment:false`。**prepare-only 通过不等于父死 heartbeat 通过。**
- 未验证：lease 更长序列（>=2，本轮仅达到合同最低 `renewalSequence=1`）；父死后 watchdog 实际时长；generic / binding-failed / detached / bash descendants 等其它拓扑（managed coding 结果不外推）；child 结算通过路径（本轮 acceptance 被拒，见观察 1）。
- 未执行：tsc、package typecheck、H1-key 单测、全仓测试、任何真实业务验证。

### Source provenance 分类（H1p run4 轮）

- **本轮新增改动**：仅本文（记录层）。harness 三源、production（含 `extension.ts`、`process-birth-identity.ts`）、统一计划、其它任务现场**零改动**（mtime 与 `git status` 开负前后一致）。
- **fixture 构造错误**：仅上述类别 2 的 `childReport().commandsRun: []` 与 acceptance level 未声明；**本轮未修**（writePaths 不含 fixture），仅记录并建议父层如需干净 child 结算另行派发 fixture-only 最小修正。
- **测试 harness 错误**：本轮未暴露新缺陷；run3 定位的跨 locale 取样域错误已由父层修复并现场实证消除。
- **production**：无缺陷、无修改需求；acceptance 与 workspace admission 两处均按设计 fail-closed，未为其增加任何兼容/fallback。

### 结论与资源释放

**H1 prepare-only 已通过（exit 0，3/3），可进入 H2。**H2 必须由父层另派：独占 `visible-host` + `heartbeat-fixture`，不与 I4 并发，用全新 fixture 根，仅 SIGKILL 直接 spawn 的父 PID，不 kill group/不补杀 child；**本 run 绝不切 env 执行 kill**。`visible-host` 于本文交付后释放；本轮未占用 `unit-runner`。证据根 `hb-b9YtbN` 按 `cleanupDisposition:"public-workspace-disposed; evidence-root-retained"` 保留（未 `rm`）；无进程残留依据已知 PID + public process-terminal proof + 三次 `ps` + 精确 socket ENOENT。
