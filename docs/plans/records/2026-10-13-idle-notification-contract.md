# I1：主会话空闲系统通知接点合同与公开接口阻塞

## 1. 交付状态与决策

- taskId：`I1 / dispatch-b14d6def`。
- 主状态：**blocked-upstream**。已核的 `pi-subagents@0.75.0` 公开查询接口，不能为每个已登记真实 run ID 提供无歧义的 `paused / queued / running / terminal` 结构化分类。这里表示当前公开接口边界不足，不表示已经决定修改上游，更不是“只能改上游”的证明。
- coverage 子问题：**blocked-evidence**。同一新 Host 内的直接 typed 派发可以设计完整登记；fresh resume 的历史集合、nested 归属及其他恢复路径不能以空集合默认成功。
- 通知功能：**未实现、未验证、固定可见目标尚未满足**。I2/I3/I4 暂不派发。下述 controller/parser/recheck 接口仅为可供父层决策的候选合同，**未冻结、未获 coding 资格**。不能把纯 controller 或模拟状态测试交付成通知功能完成。
- 父层通过 `contact_supervisor` 确认上述分型阻塞收口；不继续查、不修改计划/source、不用 terminal proof 替代 paused 语义、不新 provider、不改派发为 delegation，不读取私有 artifact。
- 本记录为静态 gate。没有运行真实 Host、RPC status、provider、模型、系统通知、kill；没有访问 settings/models/auth/credential、真实完整 session、authority/state 或运行 artifact 正文。恢复对话提供的历史 session 文件未读取。

产品条件仍为：主会话发生 `agent_settled`，其完整登记集合内全部 run 不活跃时通知；paused 与明确终态都算不活跃，不等待成功、workspace、ACK、消费或 proof。固定标题 `Pi`，中文正文 `主会话已空闲，子代理均不活跃。`。是否实际桌面可见只能由后续 I4 隔离可见验收证明，不能以 osascript exit 0 替代。

## 2. 已读取依据与证据边界

全文读取统一计划 `docs/plans/2026-10-13-remaining-runtime-execution.md`（含末尾 Z/自检）、产品决策 `docs/decisions/2026-10-10-idle-system-notification.md`；读取历史 followups 的 T5/T10 合同，仅作历史背景，不以其暂缓结论代替此次现场核对。

核心现场文件：

| 证据 | 精确事实 |
| --- | --- |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:420-468` | `spawnWorkflowLeaf` 在 RPC root reply 校验后将 root.runId 放入 `spawnedRunIds`；leaf collector 的 onBinding 先放入 observed.runId，再调用授权 hook；返回值仅 leaf binding；失败保留原错误并尽力 stop rollback。 |
| 同文件 `:767-981 / :982-1114` | coding/generic 均建 `spawnedRunIds`，均通过该 workflow wrapper；成功 details.runId 是 leaf ID，不包含完整 root+leaf 集合。 |
| 同文件 `:1248-1260` | resume await RPC 后，从公开 `reply.details.runId ?? reply.details.asyncId` 获取新身份；title registry 只用于标题延续，不是登记权威。 |
| 同文件 `:1591-1643` | 唯一 typed tool execute 路由为 action→control、coding、generic；现有外层 catch 转为原有 failure 回执。observer 不得吞掉或替换真实 executor 错误处理。 |
| `src/subagent-dispatch/workflow-spawn.ts:63-105,137-275`（均在 package 内） | 生成脚本只有一次 `runs.run(key, leaf)`；collector 按 sessionId/agent/workflowKey/parentWorkflowRunId 关联，成功后退订，只支持一个 root/一个 leaf，缓冲阶段发现不一致 leaf 会失败。 |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:212,242,275-283,300-347,350-355,456-480` | child env 时直接返回；entry 已有 renewable rpc 闭包并注入 typed extension；控制面 readRuntime 使用 rpc.status 后转 runtimeFromStatus；本通知不能复用这个布尔 helper。 |
| `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts:17-35` | readSessionIdentity 从 manager 公共方法取身份；本仓 resolveCurrentSessionId 返回逻辑 sessionId，不是 sessionFile。 |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:555-625,766-772,875-893` | start reason 为 startup/reload/new/resume/fork；shutdown reason 为 quit/reload/new/resume/fork；settled 仅 type、无runId/epoch；input 有 source/text/images/streamingBehavior，无自造generation。 |
| SDK `dist/core/extensions/runner.js:640-713` | 上下文 getter/isIdle/hasPendingMessages 都受 assertActive 保护；tool context 是 fresh object，不能以 ctx 对象引用判断同一会话。 |
| SDK `dist/core/agent-session.js:682-706,2932-2964` | settled 将本 AgentSession run 标为非活动再 emit；reload shutdown→旧 runner invalidate→重建→session_start reload，manager 不因 reload 更换。 |
| SDK `dist/core/agent-session-runtime.js:100-145` | replacement abort outgoing session→shutdown→dispose→新 manager/runtime；订阅与上下文必须重新绑定。 |

Pi 文档相关阅读：完整读取 installed `docs/extensions.md`、`sdk.md`、`tui.md`、`rpc-extension-ui.md`、`sessions.md`、`session-format.md`、`message-types.md`、`json.md`、`rpc.md`、`rpc-commands.md`；跟随 lifecycle/session/RPC/mode 相关交叉引用，读取 `examples/extensions/todo.ts` 与 `examples/sdk/13-session-runtime.ts`。`session.md` 不存在，已改读正确的 `sessions.md`，不是漏读一个现存合同。没有加载 TDD skill。文档中的 MCP 示例不构成本仓调用授权。本 gate 不做与问题无关的凭据/provider 示例探索。

以下安装目录相对 `packages/pi-subagents-enhanced/node_modules/pi-subagents/`，只读源码用于证明公开 API 的生产生成调用链，不以深层 import 作为候选实现路径。

## 3. 派发登记：已证明可设计的接点

### 3.1 owner 与 DI

领域 owner：`pi-subagents-enhanced` package。entry 绑定 Host API；候选复用实现归属 `packages/pi-subagents-enhanced/src/idle-notification/`，不得新建 root feature/idle extension，不修改根 tsconfig，不共享 footer recent20/history roster。

候选 observer options：

```ts
type IdleDispatchObservers<Token> = {
  onActivityStart(ctx: ExtensionContext): Token | undefined;
  onRunsRegistered(token: Token | undefined, ids: readonly string[]): void;
  onCoverageUnknown(token: Token | undefined): void;
};
```

时序：tool.execute 第一段同步捕获当前 manager、逻辑 sessionId 与当代 token，在任何 discovery/ping/spawn/resume await 前执行 onActivityStart。即使 invalid input/status/list 也可保守 invalidate 候选，不将它们登记为 run。observer 是同步 no-throw 通知接口；不得返回一个需 executor await 的异步工作。若 hook 抛错，独立隔离并将当代 coverage 标 unknown；连 unknown hook 也失败时 entry owner 应保留本地 unknown 锁存并可观察诊断，不能把异常等同登记成功。没有可用 token 时不得 late 读取新 ctx 把旧结果挂到新会话。

observer 与原 executor 分离：登记失败不能触发 `stopSpawnedRunsBestEffort`，不能改 raw content/details/isError，不能吞 executor 异常，不能替换授权/rollback 协议。现有生产失败本来触发 rollback 的情况继续保持；通知登记自身不能增加一次 stop。

### 3.2 coding/generic 的完整集合

- 不能仅在成功 return `:975` / `:1109` 登记 details.runId：这会漏 workflow root。
- 每次 executeCoding/executeGeneric 已有本地 `spawnedRunIds`：root 经真实 RPC binding 校验后 push；leaf 经 collector 关联验证后 push。新增 observer 的成功接点位于原成功 return 前，去重后提交 `[rootRunId, leafRunId]`，并核对 `details.runId === leafRunId`。不把 title/agent/task/workflowKey 当 run ID。
- 可以在每个已验证 binding 到达时先提交新增真实 ID，再在成功 return 前提交完整去重集合；hook 的失败不得进入原 collector onBinding 的授权抛错链。登记顺序不改变 executor。
- 多次直接 typed 调用：每次 root+leaf 都 union 到相同 manager/session 分区；不能以后一调用覆盖前一集合。
- 当前生成脚本只有一次 runs.run，因此一个合法直接调用的 wrapper 范围是一个真实 root+一个 leaf，不是任意多 leaf workflow。若未来脚本变为 parallel/多 leaf，当前 collector 成功后停止监听无法证明完整集合，应 unknown，不得以“已捕获第一个”宣称完整。
- nested：本合同区分“当前 main 直接发出的 wrapper root+leaf”与“child 自己派发的后代”。后者不因标题/路径相似自动属于 main 的直接登记集；现有 collector 无递归集合证明。若产品所有 subagent 包含递归后代，需要父层另行冻结公开归属/完整性合同。本 gate 不默默缩小或扩大产品范围。

### 3.3 失败与 rollback

合法 production 顺序可为：RPC 已 spawn root/leaf→授权 hook 拒绝→rollback stop 失败→tool failure。`extension.ts:445-467,938-945,1089-1096` 的尽力 rollback 不能证明 child 已不活跃。

失败路径保留所有已验证 spawnedRunIds，提交可知部分后 `onCoverageUnknown(token)`；RPC spawn 已发但超时/回复缺身份、collector 超时/矛盾、原授权或 bindRun/goal bind 后置失败，都不能推导零 run。明确 preflight 尚未调用 RPC 的错误才可证明本次没有新增 ID，但不能清除本 session 原先 unknown。原 failure 与错误 cause 沿原 executor 处理，不由 observer 处理。

### 3.4 resume

`executeControl:1248-1260` await `rpc.resume(params)` 且非 error 回复后，以公开 `details.runId ?? details.asyncId` 登记实际新完整 ID；两字段同在却不同、缺失、空白/前缀/路径均 unknown，不推输入旧 ID 为新 ID。不根据 Started 文案或 titleRegistry 猜测。

旧 ID 若已登记继续保留；新的 ID union。成功 reply 只证明当前新 run，不恢复未知的历史集合。RPC 已提交但异常/超时不能推零新增 run。工作流 resume 是否创建更多直接 leaf 集合没有在公开回复中证明，须 unknown。

## 4. 现有 rpc.status：准确返回形态与不能放行的原因

候选 DI 精确为：

```ts
const readRunStatus = (runId: string): Promise<unknown> => rpc.status({ id: runId });
```

使用 entry 已有 rpc 闭包，不另造 client/authority，不通过 typed tool 引发 observer activity。`rpc-client.ts:230-264` 已验证 protocol/requestId 并 resolve reply.data，返回给 parser 的是 **data**，不是外层 `{version,requestId,success,data}`；error/timeout reject。

实际生成链：`src/extension/rpc.js:599-621` targeted status→`executeChecked`→upstream executor `inspectSubagentStatus`→`dataFromToolResult`，之后附加 fleet/asyncSnapshot：

```ts
type ObservedStatusData = {
  text: string;
  details: { mode: string; results: unknown[]; /* 可选 workflow/proof metadata */ };
  fleet: unknown;
  asyncSnapshot: {
    kind: "pi-subagents.async-status-snapshot";
    version: 1;
    generatedAt: number;
    caps: unknown;
    omitted: { runs: number; children: number; byteLimitExceeded: boolean };
    runs: unknown[];
  };
};
```

1. `src/runs/background/run-status.js:760` async-status 成功返回 details 只有 mode/results 与可选 workflowReceiptPath/preflight/workflowChildren/workflowTerminalProof/runFanoutBudget/lifecycleStatus。`:822` result-file 成功同样没有结构化目标 state/runId/sessionId。foreground/nested success 也只有 mode/results。目标 `Run:` / `State:` 在 text，**本任务禁止文本猜测**。
2. `src/runs/background/async-status-snapshot.js:5-20` 只投影当前 runtime 已加载的 asyncJobs/fleetJobs，按 sessionId 过滤，但 snapshot run node 不携带 sessionId。
3. `src/runs/shared/async-status-projection.js:9-13,528-543` 默认 caps 为20 root runs、每 node8 children、depth3、32KiB，超限 omitted。它是 bounded display projection，**不是完整恢复枚举**。
4. 同文件 `:61-68` normalizeState 把 completed→complete、pending→queued，未知输入→partial。故 snapshot partial 可能是未知原始状态，不得当终态。
5. 同文件 `:222-297` 将 materialized leaf 挂到 parent；`projectMaterializedStep` 将真实 child node 的 id 改为 workflowKey、kind 改 step。leaf 运行中不保证存在 `asyncSnapshot.runs.find(id===fullLeafId)`，也不能从某个同名 key 推 runId。
6. Snapshot 内 fullID 的顶层 root 可以是正向证据，但不覆盖上述缺失 leaf/超过20/fresh恢复场景，不能据缺条目认完成。snapshot node state 未知转 partial进一步限制可用分类。

### 候选 parser 的防误报合同（未冻结）

```ts
type RunActivity =
  | { kind: "active"; runId: string; state: string }
  | { kind: "inactive"; runId: string; state: "paused" | "complete" | "completed" | "failed" | "stopped" | "rejected" }
  | { kind: "unknown"; runId: string; reason: string };
```

- 只接受登记时获取的完整实际 ID。当前生产 run 使用 UUID完整值；不得 trim 后匹配、前缀匹配、索引匹配、按标题匹配、读取 dir 来补身份。
- 收集真正带目标身份的结构化候选：若 details 提供 id/runId/asyncId，所有存在字段必须同一完整目标 ID；其 state 才可成为候选。当前正常 targeted details **并不提供此候选**，不能假造 fixture 成“现场形态”。
- snapshot 只接受合法 kind/version、精确完整 node.id 且非 step/host-step/占位值的候选；数组重复目标、畸形 envelope、目标缺 state→unknown。根/后代不能以 workflowKey 拼接为完整ID。没有命中→unknown。
- 若 details 与 snapshot 同时提供精确身份候选，状态按有限明确 alias 规范化后必须一致；running true 与 inactive state冲突、session字段与绑定owner冲突、不同ID或不同状态均 unknown，不做 details 优先覆盖。false running 本身不是终态。
- 已知 active：running/queued/pending/starting/start/resuming/resume/stopping；paused 与明确 complete/completed/failed/stopped/rejected 属 inactive。不新增“error文本”“partial”“unknown”“不存在”终态 alias。枚举中的 starting/resuming 只是候选防误报，不声称当前status保证产出这些值。
- rpc reject/isError/unknown/missing/conflict 全不通知。不得复用 `runtimeFromStatus` 的 `running===false`：该 helper 对 queued/缺字段也可为false，且不校验身份冲突。

**结论：这套 parser 可阻止误报，却不能从现公开回复补出缺失的精确状态，不能据此放行 I2/I3。**

## 5. 有界核对公开替代 API

父层要求最多10次精确只读补核；实际6次 read 加2次 grep，共8次，之后明确停止，不继续源码探索。以下 API 从 package exports 核实，未调用。

| 公开/本仓 API 签名 | 正向可用事实 | 为什么不是现方案的完整替代 |
| --- | --- | --- |
| `pi-subagents/background-work`: `registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void`；`listBackgroundWorkProviders(): readonly BackgroundWorkProvider[]`；`snapshotBackgroundWork(sessionId: string, nowMs?: number): BackgroundWorkSnapshot` | 注册有 exact disposer fencing；snapshot 按精确session筛选；provider失败抛错。 | Item 严格只有 `{id:string,sessionId:string}`；provider仅 listActiveWork/reconcile/wakeChannels，validateItem拒绝state附加字段；缺 paused/terminal 分类。grep 未见既有 subagent runs 自动注册这类 provider，仅 bg_wait/auto-drain消费者。空snapshot不能证明run inactive。不创建新provider把本地计数当权威。 |
| `pi-subagents/delegation`: 事件 request/started/update/response/cancel；`SubagentDelegationRequest={requestId,ownerRunId,nodeId,agent,task,context,cwd,...}`；update/terminal 的 runId 可选 | 独立 prompt-template 请求有 request/node关联与有限终态枚举。 | 无sessionId或按既有typed run的status查询/全量枚举；非本任务rpc.spawn通道。不能重派一个delegation替代查询，不能把ownerRunId猜成Host session归属。 |
| `pi-subagents/inspectors`: `registerInspector(pi: Pick<ExtensionAPI,"events">, plugin: InspectorPlugin): InspectorRegistration` | 提供插件注册。 | 不是既有每run精确status查询。 |
| 本仓 `RootBrokerServer.inspectExecutionProof(runId:string)` / `inspectFacadeTerminalProof(runId:string)` | `root-broker-server.ts:775-802` 只返回已接受的精确binding/terminal proof；null不推终态。 | owned snapshot terminal:null/observed，没有paused/queued实时状态；facade与owned不同集合。依赖proof会把paused等到process-terminal，违反产品条件。不能读取artifact补齐，也不接 `inspectExecutionProofForSettlement` 的私有恢复路径。 |

最小本仓 observer/registry/DI 接口有明确合法接点；**状态缺口没有在已核公开 API 中找到合规解法**。可以向父层交付所缺能力的具体规格：同Host exact fullID→结构化原始 state（不能unknown→partial）、可验证session归属、无丢失的直接wrapper ID集合。取得新合法公开接口证据或用户范围决策后再冻结，不预判需要改哪一层，更不自动改变不改上游决定。

## 6. Session / epoch / candidate 的候选合同（未冻结）

```ts
type Coverage = "complete" | "unknown";
type SessionToken = Readonly<{ sessionId: string; epoch: number; instance: symbol }>;
type ActivityToken = Readonly<{ session: SessionToken; activityRevision: number }>;
type SettledInput = {
  token: ActivityToken;
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
};

declare function createIdleNotificationController(deps: {
  readRunStatus(runId: string): Promise<unknown>;
  notify(): Promise<{ exitCode: number }>;
}): {
  bindSession(input: {
    manager: object;
    sessionId: string;
    knownRunIds: readonly string[];
    coverage: Coverage;
  }): SessionToken;
  beginActivity(): ActivityToken;
  recordRun(token: ActivityToken, runId: string): void;
  markCoverageUnknown(token: ActivityToken): void;
  settled(input: SettledInput): Promise<IdleCheckResult>;
  dispose(): void;
};

type IdleCheckResult = {
  decision: "notified" | "suppressed" | "notify-failed";
  reason: string;
};
```

候选规则：

1. manager 仅作弱引用分区key；逻辑 sessionId 从 getSessionId/本仓resolveCurrentSessionId；生命周期RPC identity是 sessionFile??sessionId，两者用途不能混淆。plain ID roster 可存于 package-owned进程内弱映射（manager→sessionId→plain ids/coverage），不保留ctx/pi/authority/prompt、不落盘。
2. 同 manager+同逻辑session的 reload 可以恢复该 plain roster，但重新发 instance/epoch，旧controller dispose、unsubscribe，旧callback/token绝不能通知或污染新session。仅ctx换对象不算session改变。
3. replacement/new/fork 的manager/id分区不同，不继承旧ID；fork复制的历史tool result不是新main实际派发。树导航不删除当前session已经派发的run，不能因为branch变更把活动子代理从集合抹掉。
4. coverage complete 初始空集合只适用于已证明真正fresh且无此前派发的main（例如明确new，或Host提供完整fresh证明）。startup事件本身也可加载旧session，不能仅reason=startup就置complete空；fresh进程resume历史不能证明时unknown。此限制不是要求先解决所有历史恢复，才设计/实现明确fresh direct场景。
5. bind失效与activity失效分开。beginActivity只递增activityRevision/invalidate候选，不重置session roster。不用活动计数作status权威。
6. 并行工具 token A 后于 token B完成时，A仍属于相同session epoch的真实ID必须登记；recordRun应检验session token有效，不因A.activityRevision老而漏ID。登记union本身须invalidate尚未发送的候选；不同epoch/instance则拒绝写新session。
7. markCoverageUnknown单调锁存；后续正常dispatch/空ids不清除unknown。旧epochunknown callback不污染新epoch；reload继承之前unknown。unknown集合不是空集合。
8. 每次真实settled捕获独立candidate序号、session token、activityRevision、完整ID副本。只有当前边沿一次status查询批次；同candidate重复settled不重复发送。新input（interactive/rpc/extension）、before_agent_start/agent_start、dispatch/resume、session_before_switch/fork、shutdown使候选失效；before事件被取消也允许保守失效，不伪造新session目标。
9. await前后与notify调用前核对session token、candidate序号、activityRevision和当次ctx.isIdle/hasPendingMessages。fresh ctx闭包只在当次settled promise期间使用，结束即释放；异常（例如stale ctx）抑制。示例API将检查方法作为函数而非过早求值的boolean，避免status晚回后用旧值通知。
10. 检查一次集合内全部ID；任一active/unknown/error不发。异步新输入/新登记使候选无效，即使全部RPC后来inactive也不发。没有timer、轮询循环、第二event状态authority。
11. notify失败/非零exit隔离且可观察，本candidate消费一次不自动重试；dispose幂等、先使token失效再清闭包/退订。notifier不启动agent，不用sendMessage制造settled。

候选 notifier：`sendMacOSIdleNotification(): Promise<{exitCode:number}>`，未来只用 `execFile('/usr/bin/osascript', 固定argv)`，不用shell、不拼prompt、不读用户任务。其他进程模式不发；仅ctx.mode==='tui'的main，child env和rpc/print/json不接桌面通知。osascript实际发送仍待I4授权资源，不在此执行。

## 7. settled 与 child 后完成：不能把时序保证说错

SDK公开 `agent_settled` 只保证**该main AgentSession**不会自动继续当前session-level run；不保证全部detached child已经结束，不保证未来child event使main再次settled。`notify.js:422-435,689` 真实sender允许triggerTurn=false（失败也可能不投递），不能据“完成通知自动送达”宣称必有下一main settled。

正例：某真实main settled时，complete coverage里的root与leaf已明确paused/terminal，逐ID查询成功且没有新活动→应通知。当前公开状态缺口使此正例尚不能实现完整验证。

反例：main先settled时leaf running→本候选不发；leaf后来paused而sender triggerTurn=false→公开settled语义不保证第二次main settled。现有“一次settled检查”不能许诺必然最终通知。**这不是第二次事件不可观察的证明**，也不是在本任务内擅自扩展产品条件的授权。

父层允许记录的未来候选扩展（未冻结、未实施）：

```ts
recheckSettledCandidate(input: SettledInput): Promise<IdleCheckResult>;
```

合法child事件只作为唤醒尚有效、尚未通知的last-settled候选；仍逐登记ID重新查询同一权威status，事件payload不判状态、不新增/删除集合、不根据完成事件计数推空。每个已接收事件最多一次有界重检查，single-flight并合并在途唤醒，禁止定时重查/自递归循环；任何新main活动或session变化清候选。不得sendMessage制造settled。

此扩展需父层/用户先明确“settled后候选仍有效时，后续child状态变化可触发一次只读重检查”的语义与I2/I3写接点；**它不是当前精确状态缺口的解法**。没有批准时保持原settled-only候选接口，不宣称覆盖child later场景。

## 8. 正反例与后续合同验证清单（未新增/运行测试）

| 输入/顺序 | 正确结果 |
| --- | --- |
| fresh main两次coding/generic，每次真实root+leaf | roster union四个完整ID，不能只两个leaf；这只证明登记设计，不证明状态查询可行。 |
| collector先收到leaf事件，后收到root RPC回复 | 依parentWorkflowRunId验证后的leaf才登记；不因started先到猜root身份。 |
| root spawn成功，leaf授权抛错，rollback stop失败 | 保留已知root/leaf，coverage unknown；原tool失败仍失败；不补stop。 |
| 两个并行dispatch，A旧revision晚于B返回 | 相同session epoch接受A真实ID，同时旧通知候选失效。 |
| resume旧R返回新N，title缺失 | 登记N，与标题无关；R已登记则保留。 |
| resume details.runId=N而asyncId=M或reply缺ID | unknown，不能选优先字段掩盖身份冲突。 |
| same manager/session reload | plain ID roster保留，新instance/epoch；旧promise晚回无通知、无新session写入。 |
| new/fork/switch不同manager/session | 分区隔离，不复制source run IDs；resume完整历史不明则unknown。 |
| targeted details只有mode/results，snapshot无fullLeafId | unknown，不解析text、不以没有条目认完成。 |
| snapshot leaf节点id为workflowKey/kind step | 不当leaf身份；即使state complete也不能满足精确fullID。 |
| snapshot partial | unknown，因为producer可由未知原始state规范化而来。 |
| 同IDdetails paused/snapshot running，或不同ID | 冲突unknown，不发送。 |
| 合法原始exact paused/complete/failed/stopped | 候选inactive，不等proof/workspace/ACK；但本公开接口未为所有登记ID产出该形态。 |
| status全部inactive，查询中收到input或resume | 旧candidate抑制，不发送。 |
| complete空集合但仅startup/resume没有fresh证明 | coverage unknown；不能真空成立。 |
| notify非零/抛错 | 单次可观察失败，不影响executor、不自动重发，不宣称可见。 |

后续若父层取得可实施资格，聚焦命令候选为计划I2/I3列出的 `node --test test/idle-notification.test.mjs test/idle-notification-status.test.mjs`、package typecheck及显式 runtime integration；本任务禁止测试写入/运行业务，不运行这些命令，不占F1 unit-runner。

## 9. 验证与解除条件

已执行只读 `git status --short && git diff --cached --name-only`，exit 0，index为空；观察到其他并行分支独立dirty路径，未覆盖、未清理、未stage。仅创建本record。最终执行 `git diff --check` 及 Node 内联记录结构检查（必需合同字段、固定正文、代码围栏配对），组合命令 exit 0，输出 `I1 record static structure: PASS; runtime/notifier tests: NOT RUN`；`git diff --cached --name-only` 无输出，record状态为 `??`。未新增/运行测试，不把Markdown检查解释为runtime通过。

解除条件不是“永远关闭”，也不是自动批准改上游：

- 父层提供/批准能查询既有typed run的合法公开精确ID+原始state+session归属接口，明确missing/conflict/unknown处理；或取得用户认可的范围/接口调整。现有rpc.status和已核public替代的缺口按本记录逐项可复核。
- 单leaf直接fresh登记设计可以独立冻结，fresh历史恢复unknown保留；若需nested/多leaf覆盖，补公开owner/完整集合证据，不能复制有限TUI投影。
- 父层明确是否采用last-settled候选的事件触发只读重检查，并获得对应I2/I3接口资格；不制造agent turn、无轮询。
- 然后才冻结完整implementation合同、授权I2/I3；I4证明固定系统通知实际可见后才说通知目标完成。

本分支具体blocked允许统一DAG账本收口为partial，不能把blocked状态勾成通知功能已实现。
