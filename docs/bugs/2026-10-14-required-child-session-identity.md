# 持久会话下 required-child 注册键与上游查找键分歧，child 丢失全部 required 注入

## 修复与 Inline 收口

先前诊断阶段的授权边界和现场证据保留在下文，不把历史“未修改”误当当前状态。

- production 注册键已最小改为 `ctx?.sessionManager?.getSessionId()`；仓内 lifecycle/file identity 闭环保持不变。
- `node --test test/subagent-runtime-membrane.test.mjs`：exit 0，111/111；包括三项持久/非持久 required-child identity 用例。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm --prefix packages/pi-subagents-enhanced run typecheck`：exit 0。
- 当前 diff 仅本修复及其测试；D0–D3 已单独提交，未重复混入。
- 这次未重跑真实 child 派发或 heartbeat，不能用 membrane 单测代替旧真实实验记录。

## 状态与本轮授权边界

**状态：只读诊断已完成，根因已在键值层完全证实（registration key = session 文件路径，lookup key = Pi session ID 字符串）。本轮未修改 production、未修改测试/harness、未修改统一计划、未重跑真实 Host、未运行 tests/tsc、未发任何信号、未做网络/provider 调用。现场 `hb-vhjjea` 完整保留，并行 dirty 未触碰。仅新建本文。**

诊断输入严格限于任务合同白名单：

- fixture 根 `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-vhjjea` 下 `launch.json`、`failure.json`、`parent-observations.jsonl`、`child-65539.jsonl` 全文；
- 上述文件明确记录的 exact asyncDir（`64cb23f7-02c7-4411-9417-a06ec0ac960d`、`7fe18152-177f-4da3-a912-3b7c16f483bf`）中 `status.json` 的身份字段与 `launchResolvedExtensions.required`、`runtimeAcknowledgedExtensions`、safe error 文本；
- 仓内锁定源码与本仓 `node_modules` 内 `pi-subagents@0.75.0`、`@earendil-works/pi-coding-agent@1.0.4` 的公开源码/`.d.ts`。

**未读取**：`session.jsonl` 正文、prompt、authority、grant、config、settings、models、auth、credential；未宽扫 `/tmp` 或 uid broker 目录（仅按 launch.json 记录的精确 namespace 事实引用，未枚举）；未读取本执笔者自身真实 session/state。`sessions/` 目录仅做文件名与 `stat` 元数据列举，未打开会话正文。

## 实际入口、identity 与 order

### 实际入口（全部为合法公开入口）

| 环节 | 入口 | 证据 |
| --- | --- | --- |
| Host 启动 | `dist/cli.js --mode rpc --session-id <uuid> --session-dir <fixture>/sessions --no-extensions -e …` | `launch.json.args`（公开 CLI flags） |
| SessionManager 构造 | `main.js:552` `createSessionManager(...)` → `main.js:351` `SessionManager.create(cwd, sessionDir, { id: parsed.sessionId })` | 未走 `parsed.noSession` 分支（`main.js:286-288`），故 `persist=true` |
| 注册侧 | enhanced 层 `pi.on("session_start")` → `ready()` → `registerRequiredChildExtensions` | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1733-1746`、`:1759-1762` |
| 派发 | 公开 typed `subagent` 工具（fake provider 生成 tool call，未手拼 projection、未直接 RPC spawn） | `parent-observations.jsonl` workflow/leaf `started` |
| 查找侧 | 上游 async 启动计划构建 | `pi-subagents/src/runs/background/async-execution.js:745`、`:894` |

### identity 事实（权威来源，非推断）

- `launch.json.rootSessionId` = `heartbeat-3b45454d-bee2-4351-a2d8-43f4f35f9a85`（**ID 字符串**）。
- `launch.json.args` 含 `--session-dir <fixtureRoot>/sessions` → `persist=true`。
- leaf `status.json.sessionId` = `<fixtureRoot>/sessions/2026-10-14T08-57-23-062Z_heartbeat-3b45454d-bee2-4351-a2d8-43f4f35f9a85.jsonl`（**文件路径**）。
- 该路径正是 `pi-subagents/src/shared/session-identity.js:1-6` `resolveCurrentSessionId()` = `getSessionFile() ?? getSessionId()` 的输出形态，且文件名内嵌同一 rootSessionId。
- 两个 identity 在同一现场**同时存在且不相等**：`test/subagent-runtime-root-broker-startup.integration.mjs:70-71` 已断言持久会话下 `getSessionId === sessionId` 且 `getSessionId !== getSessionFile`。

### order（时间序，全部来自现场记录）

| 序 | 事件 | observedAt | 来源 |
| --- | --- | --- | --- |
| 0 | SessionManager 构造并赋 `sessionFile` 字符串 | 命名时间戳 `2026-10-14T08:57:23.062Z` | 文件名字面量 + `session-manager.js:711-714` |
| 1 | `parent-started`（broker registry 正确：endpoint/pid=65435/birth） | `…243996`（= 08:57:23.996Z） | `parent-observations.jsonl` |
| 2 | workflow `started` runId `64cb23f7…`，pid **65435**（= 父） | `…244807` | 同上 |
| 3 | leaf `started` runId `7fe18152…`，pid **65539**，agent executor，parentWorkflowRunId=`64cb23f7…` | `…244846` | 同上 |
| 4 | `child-session-started`（cwd 在 fixture managed worktree 内），**无 owner/acknowledged/lease/barrier 任何记录** | `…245363` | `child-65539.jsonl` |
| 5 | `process-terminal` runner 65539 **exitCode 0 / signal null**，proof state=observed | `…245422` | `parent-observations.jsonl` |

**关键时序结论：sessionFile 字符串的命名时间戳比 `parent-started` 早 934ms**，即 `SessionManager` 构造（`main.js:552`）严格早于 AgentSession/runtime 创建与 `session_start` 派发（`main.js:773-775` `runRpcMode`）。因此 `session_start` 时 `ctx.sessionManager.sessionFile` **已非空**。

对合同中「startup 是否已提供 sessionFile 但 file 尚未存在」的精确回答：**是，且这一点不影响键值**。`session-manager.js:711-714` 在 `newSession()` 内无条件按 `persist` 赋值 `this.sessionFile = join(getSessionDir(), "<ts>_<id>.jsonl")`，不做任何 fs 检查；物理文件由 `_persist`（`:794-800`）在 `_hasConversation()`（`:788-793`，需首条 user/assistant 消息）为真后才以 `wx` 创建。`lifecycleSessionIdentity` 只读内存字符串属性，落盘与否与键值无关。

### first divergence（精确 file:line）

1. **注册侧键**：`extension.ts:1733` `const sessionId = lifecycleSessionIdentity(ctx?.sessionManager);` → `:1739-1746` `registerRequiredChildExtensions({ sessionId, extensions: [root-session-owner, integration-queue, agents-shared?] })`。
   `lifecycleSessionIdentity`（同文件 `:263-268`）= `session.sessionFile ?? session.sessionId`。**持久会话下必为文件路径。**
2. **注册表语义**：`pi-subagents/src/shared/required-child-extensions.js:60-75` 以 `store.bySession.set(input.sessionId, frozen)` **精确字符串键**存入 `globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]`；`:76-80` `resolveRequiredChildExtensions(sessionId)` 为 `registry().bySession.get(sessionId) ?? EMPTY_SNAPSHOT`——**无任何归一化、无路径/ID 互转、无模糊匹配**。
3. **查找侧键**（全部为 Pi session **ID 字符串**，无一处使用文件路径）：
   - `subagent-executor.js:6107-6108` `requestSessionId = resolveCurrentSessionId(ctx.sessionManager)`（文件路径）／`requestPiSessionId = ctx.sessionManager.getSessionId()`（ID）→ `:7149-7150` `parentSessionId: requestSessionId`、`parentPiSessionId: requestPiSessionId`；
   - `subagent-executor.js:3024-3025` `asyncCtx.currentSessionId = data.parentSessionId`（文件路径）、`asyncCtx.parentSessionId = data.parentPiSessionId`（**ID**）；
   - `async-execution.js:745` `resolveRequiredChildExtensions(ctx.parentSessionId ?? ctx.currentSessionId)` → **ID 优先命中**（文件路径仅在 `getSessionId()` 为 undefined 时兜底，而 `SessionManager.sessionId` 恒非空）；`:894` `requiredExtensions = … ?? registeredExtensions`；
   - `subagent-executor.js:3472` `resolveRequiredChildExtensions(data.parentPiSessionId)`（**ID**）；
   - `subagent-executor.js:4743` `resolveRequiredChildExtensions(ctx.sessionManager.getSessionId())`（**ID**）；
   - `subagent-executor.js:1015`（append/resume）`parentSessionId: input.ctx.sessionManager.getSessionId()`（**ID**）；
   - `async-execution.js:663` `launchParentSessionId = ctx.parentSessionId ?? ctx.currentSessionId`（**ID**）→ `:919/:1094/:1804` 写入 step，`runner-child-launch.js:17` 透传，故 `child-launch.js:78` 的兜底查找同为 ID。
4. **首偏离点**：第 1 步与第 3 步的键在持久会话下必然不相等（`sessionFile ≠ sessionId`，已由 `subagent-runtime-root-broker-startup.integration.mjs:70-71` 静态断言）。`Map.get` 精确匹配失败 → `EMPTY_SNAPSHOT`。
5. **下游后果链（现场已证）**：`requiredExtensions=[]` → `resolvePiLaunchToolPlan` 的 `required` 为空 → leaf `status.json.launchResolvedExtensions.required = []` 且 `omitted.required = 0`（**未被过滤/截断，而是解析即为空**），同结构内 `runtime`、`configured`、`effective` 均非空（各 1 项 sha256 id），`disableAmbientExtensions = true`；`runtimeAcknowledgedExtensions = null`（`subagent-runner.js:962` 由 `subagent:acknowledge-extension` 捕获，无 required 即无 ACK）→ child 未加载 `root-session-owner` → 无 `pi-config:root-owner-ready`/ACK/lease → leaf `status.json.error`（safe 文本）= `Error: 模型启动前未观察到实际 root-owner-ready`（fixture provider 按设计 fail-closed）→ `state=failed` → harness readiness 120s 超时（`failure.json`）。

`child-65539.jsonl` 只有 `child-session-started` 一条、`runner.stderr.log`/`runner.stdout.log` 均 0B、runner 自行 exit 0 且 `signal: null`（无 SIGKILL、无残留 PID），与「child 进程健康但缺 required 注入」一致，排除崩溃/被杀类解释。

## 上下游合同

- **上游（`pi-subagents@0.75.0`）合同**：`docs/agents.md:386` 定义 host 通过 `pi-subagents/required-child-extensions` 注册 `{ sessionId, extensions, requireForAllRunners? }`；`.d.ts` 注释为 “Register one immutable host-required extension snapshot for **a parent session**”，字段名 `sessionId`。上游自身**从不调用** `registerRequiredChildExtensions`（`src/` 内仅定义与 re-export），注册完全是 host 义务，因此**键必须对齐上游全部查找点使用的 `getSessionId()`**。上游对两种身份有明确命名区分：`parentPiSessionId`（Pi session ID）vs `parentSessionId`（`resolveCurrentSessionId`，文件路径优先），并把后者用于容量/预算/owner 等自有状态，前者用于 required-child 查找。
- **下游/仓内（repo owner）合同**：`lifecycleSessionIdentity` 是本仓为**自有** registry 设计的键约定，且在自有闭环内自洽——`root-broker-server.ts:252/276/361` 的 `lifecycleSessionId` 两侧同为本仓代码，`subagent-runtime-root-broker-startup.integration.mjs:76` 断言 `brokerLifecycleSessionId === getSessionFile`。该约定另被用于 `extension.ts:289`（RPC capability 校验）、`:836/:1045`（trace）、`:871/:881/:911/:1059/:1068`（workspace 绑定），这些均属仓内自闭环，**不受本缺陷影响，也不应随本修复改动**。
- **合同违背方向**：仓内把「自有 registry 的文件路径键约定」复用到了「上游 ID 键 registry」。**owner = 本仓**（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1733`），不是上游。上游无需改动，也不建议改上游去兼容路径键（那会破坏其 `parentPiSessionId`/`parentSessionId` 既有语义区分）。

## 正向证据与反向证据

### 正向证据（production 可达，合法公开数据 + 真实隔离 fixture）

1. **静态生成链完整**：`main.js:286-288` 仅在 `--no-session`（或 `--help`/`--list-models`）走 `SessionManager.inMemory`；**默认无 flag 启动**落到 `main.js:351` `SessionManager.create(...)` → `session-manager.js:1316-1319` `new SessionManager(cwd, dir, undefined, /*persist*/ true, options)` → 构造函数 `:644-660` 走 `newSession()` → `:711-714` 赋 `sessionFile`。即**默认 production Host 就是持久会话**，注册键就是文件路径。
2. **真实隔离 fixture 动态证明**：H1 现场 `launchResolvedExtensions.required=[]` + `omitted.required=0` + `runtimeAcknowledgedExtensions=null`，且 leaf `status.json.sessionId` 为文件路径、`launch.json.rootSessionId` 为 ID 字符串——两键在同一现场同时可见且不等。
3. **注册确实执行过**：`registerRequiredChildExtensions` 对空/含空白/超 256 字节/含 NUL 的 `sessionId` 会抛错（`shared/required-child-extensions.js:63-64`），本次现场 fixture 路径约 150 字节、无空白，未抛错；`session_start` 处理器亦未失败（workflow/leaf 正常派发）。故注册以文件路径键成功写入，查找以 ID 键必然落空。
4. **精确匹配语义**：`resolveRequiredChildExtensions` 无归一化（`:76-80`），排除「上游会自动等价匹配」的可能。

### 反向证据（negative evidence：为何此前未被发现）

1. **`--no-session` 退化路径掩盖**：`session-manager.js:1365` `inMemory` → `persist=false` → `newSession()` 的 `if (this.persist)` 分支不进 → `sessionFile` 恒 `undefined` → `lifecycleSessionIdentity` 退化为 `session.sessionId`（ID 字符串）→ 与上游查找键**恰好一致**→ 注入成功。
2. **现有 required 注入断言全部落在退化路径**：`test/joint-upgrade-contact-supervisor.integration.mjs:29`（断言 `launchResolvedExtensions.required` = `['root-session-owner','integration-queue']`、`:53` 断言 `runtimeAcknowledgedExtensions.ids`）以 `--no-session` 启动；`test/subagent-completion-notification.integration.mjs` 同为非持久路径。「持久会话 + required-child」组合此前**零覆盖**。
3. **同文件内已有持久会话用例但未断言 required**：`test/joint-upgrade-contact-supervisor.integration.mjs:98-99`（`JOINT_CONTACT_CASE:'restart-first'`）以 `--session-id` + `PI_CODING_AGENT_SESSION_DIR` 启动（即持久会话），但其断言集中在 supervisor request/reply 与状态文件，**未断言 `launchResolvedExtensions.required`**；该场景 child 的 `contact_supervisor` 由合成 fixture provider 驱动（`test/fixtures/joint-upgrade/contact-provider.mjs`），工具注册通道为 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-consumption.ts`，**不经 required-child registry**，因此该用例即使在 `required=[]` 下也不会失败。这不是反例，而是覆盖盲区的又一实证。
4. **`test/subagent-ordered-models.test.mjs:49` 仅 `assert.match(source, /registerRequiredChildExtensions\(/)`**，是源码文本匹配，不构成调用链证明，也不能作为键值正确性证据。

## 分类（按仓库缺陷数据来源分类门禁）

**分层结论，不使用单一标签掩盖未证实部分：**

- **主根因（键分歧）→ 类别 1「预期 production 数据未被正确处理」**。理由：数据由合法公开入口产生（公开 CLI flags `--session-id/--session-dir/--mode rpc`、公开 typed `subagent` 工具、真实 `SessionManager` 权威身份、正常事件顺序），身份/时间/资源事实均有效（PID 65435/65539、birth、exit 0、时间单调）；分歧发生在**两段 production 代码之间**（仓内注册侧 vs 上游查找侧），非测试手拼 projection、非绕过 public 入口、非非法时间、非过期 fixture。默认 production Host 即持久会话（正向证据 1），**不需要真实用户事故才成立**。合法隔离持久会话公开链的失败本身即有效证据。
- **fixture / harness → 无缺陷**。`heartbeat-provider.ts` 的 `Error: 模型启动前未观察到实际 root-owner-ready` 是设计内 fail-closed 门禁的**症状**，不是根因；harness 保留现场、不补杀、不清理均按设计执行。不需要修改测试或 fixture 来「让其通过」。
- **派生影响面（真实现网 Host 的 child 是否同样丢失 required 注入）→ 类别 3「来源尚未证实」，保持 fail closed**。见下节反例与未证实项。此项**不阻断**主根因的最小修复合同，但**不得**据本文断言现网已发生同等故障。

## 未证实项与反例（必须保留，不得当作已闭合）

1. **本执笔者自身 system prompt 含 `<pi_child_execution_boundaries source="runtime">`，不构成同拓扑反证。** 该文本由 `src/agents-shared/index.ts`（经 `pi/extensions/agents-shared.ts`，child scope 判据为 `PI_SUBAGENT_CHILD=1`）注入，而 `agents-shared` 正是本缺陷中丢失的三项 required 之一。可能的解释至少两条且**均未证实**：(a) 真实 Host 的 child launch 未置 `disableAmbientExtensions`，`agents-shared` 经 agentDir 环境发现加载，与 required registry 无关；(b) 真实 Host 的注册时点/会话形态与本 fixture 不同。合同禁止读取自身真实 session/state 求证，故**保持未证实**，不将其用作「production 不受影响」的证据，也不将其用作「production 受影响」的证据。
2. **真实 Host 下 `session_start` 时刻 `sessionFile` 是否已赋值**：本文对 fixture（RPC + `--session-id` + `--session-dir`）给出了静态+动态双重证明（早 934ms 的命名时间戳）；对 interactive/print 默认启动只给出静态链（`main.js:552` 早于 `:773`），**未做真实运行验证**。
3. **`runtimeAcknowledgedExtensions=null` 的充分性**：已证其来源为 `subagent:acknowledge-extension` 捕获（`subagent-runner.js:962`、`extension/rpc.js:328`），与 `required=[]` 一致；但未独立验证「required 非空时该字段必然非空」的全部路径。
4. **未运行项**：本轮未运行任何 test/tsc/Host/RPC/子任务/网络/kill；lease 就绪（renewalSequence≥1）、barrier 释放、public workspace dispose、`parentDeath` 分支全部仍未到达（沿用 H1 记录的未验证清单）。
5. **未验证的次生风险（仅记录，不实施防御）**：`registerRequiredChildExtensions` 对 `sessionId.length > 256` 抛错（`shared/required-child-extensions.js:63-64`）。当前以文件路径为键时，深层 `sessionDir` 会使路径超 256 字节并在 `session_start` 抛出；改为 ID 键后该风险自然消失（UUID 长度恒定）。本次 fixture 路径约 150 字节，未触发。

## 最小精确修复路径（合同，不实施）

**owner：本仓。单点、单文件、单表达式。**

- 文件：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- 位置：`:1733`（`ready()` 内 required-child 注册块 `:1733-1746`）
- 修改：将注册键从 `lifecycleSessionIdentity(ctx?.sessionManager)` 改为上游全部查找点使用的 Pi session ID，即 `ctx?.sessionManager?.getSessionId()`，并保留非空判定（`getSessionId()` 初值为 `""`，`registerRequiredChildExtensions` 会对空串抛错）后再进入 `if (sessionId && !requiredChildExtensionsRegistration)` 守卫。
- **不得改动**：`lifecycleSessionIdentity` 本身（`:263-268`）及其在 `:289/:836/:871/:881/:911/:1045/:1059/:1068` 的既有用法（仓内自闭环 registry / trace / workspace 绑定，键约定正确）；`requiredChildExtensionsRegistration` 的幂等守卫与 `:1558-1560` 的 `dispose()` 配对；注册数组内容与顺序；`requireForAllRunners` 保持缺省。
- **明确禁止的 fallback / broadening（不得实施）**：不得同时以两种键各注册一次；不得包裹 try/catch 吞掉注册异常；不得为路径键给上游打补丁或加归一化；不得置 `requireForAllRunners` 以「保证注入」（会改写 admission 语义并拒绝合法 runner/machine 放置）；不得改 fixture provider 的 fail-closed 门禁；不得放宽 harness readiness 断言。

### 测试路径建议（不实施）

- 新增独立聚焦用例 `test/required-child-persistent-session.integration.mjs`（避免改动既有现场文件）：以公开 CLI `--mode rpc --session-id <uuid> --session-dir <隔离目录>`（**持久会话**）启动真实 Host，经公开 typed `subagent` 工具派发，断言 leaf `status.json`：
  - `launchResolvedExtensions.required` 含 `root-session-owner`、`integration-queue`（及 host 声明的 `agents-shared`），且 `omitted.required === 0`；
  - `runtimeAcknowledgedExtensions.ids` 与 required 集合一致；
  - 同一现场同时断言 `getSessionId() !== getSessionFile()`，防止用例退化为 in-memory 而虚假通过（沿用 `test/subagent-runtime-root-broker-startup.integration.mjs:70-71` 的公开事实投影方式）。
- 反向用例：`--no-session` 变体断言同一集合仍注入成功，锁住既有退化路径不回归。
- 该用例属新增覆盖，不是把现有失败测试改成通过；H1 harness（`test/heartbeat-parent-death.integration.mjs`）与其 fixture 三文件保持零改动。

## 现场保留与并行 dirty

- `hb-vhjjea` 完整保留：未 `rm`、未 raw `git worktree` 删除、未清 `state/`、`sessions/`、`tmp/`；broker 仅引用 `launch.json` 记录的本次精确 namespace，未枚举其它 root。
- 无残留 fixture 进程：沿用 H1 记录事实（runner 65539 自行 exit 0；父 65435 经 stdin EOF orderly shutdown；`ps` 双次确认 65435/65539/65418 均不存在）。本轮未发任何信号。
- 原 H1 现场与并行 dirty（S1a/F2b/F4a/F5b/H1 record 等已修改/未跟踪文件）**逐字保留**，本轮零改动；`git diff --cached --name-only` 为空，无 staged 文件；未 commit、未 stash、未 reset。
- 本轮唯一写入：`docs/bugs/2026-10-14-required-child-session-identity.md`（本文）。
