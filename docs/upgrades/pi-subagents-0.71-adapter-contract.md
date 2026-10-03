# pi-subagents 0.71.0 适配契约与 authority 图

> T3 探索记录。本文只记录 0.71.0 shadow 的现场证据、适配决策和后续升级决策项，不修改生产代码。纯文档变更，按 `test-driven-development` Skill 的规则属于显式 TDD 豁免；验证以 shadow 安装、逐公开 specifier import、源码/类型行号和一次真实 Host 探针为准。
>
> 环境：`/Users/leshi.zhy/pi-config-upgrade`，分支 `upgrade/pi-stack-0.87`，基线 HEAD `530ada5e2d395cf6a21261b99bdd02244301de16`；Node `v26.8.1`；core 四包为 `0.87.1`。shadow 安装目录为 `/tmp/pi-shadow-0.71`，registry 固定为 `https://registry.npmjs.org`，npm cache 为 clone 的 `var/tmp/npm-cache`。

## 1. 0.71.0 exports 实测清单

### 1.1 安装与实测方法

执行了计划规定的安装命令：

```sh
mkdir -p /tmp/pi-shadow-0.71
cd /tmp/pi-shadow-0.71
NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  npm_config_cache=$HOME/pi-config-upgrade/var/tmp/npm-cache \
  npm init -y >/dev/null
NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  npm_config_cache=$HOME/pi-config-upgrade/var/tmp/npm-cache \
  npm install pi-subagents@0.71.0 --no-audit --no-fund
```

安装成功（`added 6 packages in 6s`）。为验证需要 peer 的模块，又在 shadow 中安装了 `@earendil-works/pi-{coding-agent,ai,agent-core,tui}@0.87.1`；因此 `preflight` 也能被真实加载。包 `package.json:3-4` 确认 `name=pi-subagents`、`version=0.71.0`，`package.json:55-116` 是完整 `exports` 表。

现场逐公开 specifier 使用 `node --input-type=module` import。结果留存于 `var/upgrade/trace/shadow-public-imports.txt`；包与关键源码 hash 也在该文件中。结论如下：

| 公开 specifier | 实测导出 | 结论 |
| --- | --- | --- |
| `pi-subagents` | `default` | 可 import；类型为 `registerSubagentExtension(pi: ExtensionAPI): void`（`index.d.ts:1-2`） |
| `pi-subagents/background-work` | background-work registry/version、provider 注册与 snapshot | 可 import；与现有八项 compat 无同名替代 |
| `pi-subagents/external-job-provider` | external job provider registry、validate/register/list | 可 import；不是现有八项的替代 |
| `pi-subagents/external-runs` | external run register/update/snapshot/unregister | 可 import；展示/外部作业记录 API，不是旧 runtime/config API |
| `pi-subagents/agents` | `registerAgent`、`registerAgentViaEvents` 及常量 | 可 import；**没有** `discoverAgents` |
| `pi-subagents/delegation` | delegation event 常量 | 可 import；不是通知投递函数 |
| `pi-subagents/capability-ceiling` | ceiling 编解码/注册/解析 | 可 import；是能力上限 API，不是 RPC capability ping |
| `pi-subagents/workflow-resources` | `registerWorkflowResource` | 可 import |
| `pi-subagents/required-child-extensions` | `registerRequiredChildExtensions` | 可 import；可作为 required child extension 的公开注册面 |
| `pi-subagents/preflight` | `SUBAGENT_LAUNCH_CONTRACT_VERSION`、`resolveSubagentLaunchContract` | 可 import；契约签名见 `.d.ts:1-32` 起，能做 launch preflight，不替代身份/通知/产物 API |
| `pi-subagents/control-channel` | `requestAsyncStop` | 可 import |
| `pi-subagents/intercom-bridge` | `resolveIntercomSessionTarget` | 可 import |
| `pi-subagents/child-tool-plan` | `resolvePiLaunchToolPlan` | 可 import |
| `pi-subagents/shared-types` | `DEFAULT_FORK_PREAMBLE`、`wrapForkTask` | 可 import |
| `pi-subagents/project-panes` | project pane lifecycle API | 可 import |

以下旧 compat 使用的深层 specifier 均实测失败，错误均为 `ERR_PACKAGE_PATH_NOT_EXPORTED`：`pi-subagents/config`、`pi-subagents/background-notify`、`pi-subagents/session-identity`、`pi-subagents/completion-owner`、`pi-subagents/artifacts`、`pi-subagents/fleet-transcript`、`pi-subagents/enhanced-agents`。这不是路径猜测：0.71 的 `package.json:56-116` exports 列表没有这些 subpath。

### 1.2 与 0.71 行为相关的现场源码

- RPC ping 的返回面在 `src/extension/rpc.js:298-337`：返回 `cwd`、`sessionId`、`sessionFile`，methods 包含 `ping/status/manage/spawn/steer/interrupt/stop/resume/cost`，capabilities 明确有 `statusProjection`、`asyncSpawn`、`processTerminalProof`、`cost`，并返回事件通道名。
- `loadConfig` 仍存在于包内实现 `src/extension/config.js:221-244`，类型为 `loadConfig(): ExtensionConfig`（`src/extension/config.d.ts:1-7`），但未进入 exports，不能作为跨包契约依赖。
- session identity 内部类型是 `getSessionFile(): string|null|undefined`、`getSessionId(): string|null|undefined`，函数签名在 `src/shared/session-identity.d.ts:1-5`；同样未公开。
- completion owner 是 process-local 的 Symbol/random UUID（`src/shared/completion-owner.js:1-7`），类型仅 `currentCompletionOwnerId(): string`（`src/shared/completion-owner.d.ts:1-2`），未公开。
- artifact helper `getArtifactsDir(sessionFile, projectCwd?, dirPreference?): string` 在 `src/shared/artifacts.d.ts:1-10`，未公开。
- fleet transcript 读/渲染签名在 `src/tui/fleet-transcript.d.ts:40-48`，未公开。
- 0.71 `discoverAgents(cwd, scope, preferredModelProvider?)` 仍在包内 `.d.ts:321-325`，但 `pi-subagents/agents` 的公开导出只有 runtime agent registration，因此不能以公开 API 证明发现/准入语义。
- 0.71 配置支持 `worktree?: boolean`、`worktreeProvider?: "auto"|"native"|"worktrunk"`（`src/shared/types.d.ts:2592-2600`），但这只是 upstream worktree 开关，不是本仓 write-path 或终局 authority 契约。

## 2. 八项 compat 映射决策表

现有文件 `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts:1-8` 的八项导入逐项决策如下。三种结论严格区分：可直接用公开 API；可以在增强层自建且不触碰安全 authority；或无安全实现路径、必须升级决策项。这里不把包内深层实现冒充公开 API。

| # | 0.62 导入 | 0.71 公开 API 证据 | 决策 | 依据/边界 |
| --- | --- | --- | --- | --- |
| 1 | default runtime | `package.json:56-60` 公开 `.`；`index.d.ts:1-2` 为 `registerSubagentExtension(pi): void` | **0.71 公开 API** | 将 `import upstreamSubagentRuntime from "pi-subagents"` 迁移为根导入；只将其作为 Host extension 注册函数，不推断旧内部状态。 |
| 2 | `loadConfig` | `src/extension/config.d.ts:7` 有类型，`package.json:56-116` 无 `./config` | **无安全实现路径 → 升级决策项** | 配置含 worktree、authority、route 等启动策略；从文件重读或复制默认值会绕过上游校验和配置 authority，不能自建 facade。 |
| 3 | `registerSubagentNotify` | 类型仍在 `src/runs/background/notify.d.ts:131-142`，但无公开 subpath；注释明确 result 文件只有 `sendMessage()` 接受后才删除 | **2026-09-29 用户决策已执行：删除增强层包装，依赖上游原生投递+ack** | 不在增强层复制 notifier。上游 bootstrap 时由 `extension/index.js:440` 注册原生 `registerSubagentNotify`（`src/runs/background/notify.js:580`，含 dedupe/batching/ownership/ack；`sendCompletion` 在 `notify.js:428` 发送 `subagent-notify` customType，result 文件仅在 `sendMessage()` 接受后删除）。增强层 `createCompletionNotifier`/`subscribeAsyncComplete` 包装链已删除，`extensions/subagent-runtime.ts` 不再传 `completionNotifierFactory`，上游 `subagent-notify` 消息不再被 `suppressCompletionNotifications` 抑制；项目 `subagent-notify` renderer 保留以赢得 last-write 所有权。执行记录：`var/upgrade/p1-notifier-removal.md`。 |
| 4 | `resolveCurrentSessionId` | 内部签名 `src/shared/session-identity.d.ts:1-5`，无 exports | **无安全实现路径 → 升级决策项** | `sessionFile/sessionId` 是 owner identity 绑定基础；从上下文 cwd、环境变量或路径猜测不能替代权威 session manager。 |
| 5 | `currentCompletionOwnerId` | 内部实现 `src/shared/completion-owner.js:1-7`，无 exports | **无安全实现路径 → 升级决策项** | process-local Symbol + UUID 的 owner identity 不可由增强层另生成；错误 facade 会造成重复投递或跨 runtime 归属。 |
| 6 | `getArtifactsDir` | 内部类型 `src/shared/artifacts.d.ts:8-10`，无 exports | **无安全实现路径 → 升级决策项** | artifact 路径决定结果/terminal 证据 authority；自行拼 `$cwd/.pi` 或 session 路径不能承诺与 upstream 相同的隔离和清理语义。 |
| 7 | `readFleetTranscript` / `renderFleetTranscript` | 内部类型 `src/tui/fleet-transcript.d.ts:40-48`，无 exports | **自建 facade（仅展示类）** | 允许在增强层拥有显示适配：保留原始 transcript 数据，仅复制/重写 parser/renderer 的显示实现；不能修改 agent 消息、event payload 或结构化 details。未知/不可信路径应显示降级警告。该 facade 不得参与成功、terminal、release 或 artifact authority。 |
| 8 | `discoverAgents` / `AgentConfig` | `pi-subagents/agents` 公开 `registerAgent/registerAgentViaEvents`，而 `discoverAgents` 仅见内部 `src/agents/agents.d.ts:321-325` | **2026-09-28 用户决策修订：repository-configured 前置过滤** | typed dispatch admission 只认 Host 配置声明 `pi/agents/{delegate,executor,reviewer}.md`；不扫描 `<cwd>/.pi/agents`、不观察 runtime registration，也不以外部宿主冲突结果扩展集合。未知名 fail closed 为 `AGENT_ADMISSION_UNAVAILABLE`。 |

**安全停止结论：** 通知投递、owner identity、artifact authority 和 agent admission 均没有 0.71 公开替代面；因此 T3 不承诺自建这些 facade，不放行 T4/T5 的安全迁移。只有第 1 项和展示类第 7 项具备当前安全可接受路径。`required-child-extensions` 与 `preflight` 虽然公开，但它们不能补齐上述四个缺口。

### 2.8 2026-09-28 用户决策修订：admission 分层权威模型

本层 typed dispatch 的 admission 前置过滤权威为 repository-configured profiles：只解析 Host 必定加载的 `pi/agents/{delegate,executor,reviewer}.md`，集合恰好为这三个 profile，返回标签 `repository-configured`。项目 `.pi/agents`、运行时注册事件及外部宿主注册/冲突结果不再作为本层准入来源；自定义/项目 agent 由上游原生工具派发，不经 typed 工具。

上游 spawn 期仍负责对已通过前置过滤的请求做内部解析与终审（包括 disabled、scope 等策略）；该终审对本仓仍是待动态验证项。残留验证项：上游 spawn 期对禁用 agent 与 scope 限制的终审行为尚待 fresh Host 动态验证，不能由本层 admission 结果推断。

## 3. facade TS 接口签名

以下是目标 facade 的**完整签名草案**。它是契约文档，不是本次 T3 的生产实现；第 2 节标记为“无安全实现路径”的导出不得在 T5 伪实现。类型只引用 Host 的公开 `ExtensionAPI`/`ExtensionContext` 和 0.71 可公开获得的类型；`AgentConfig` 不从未导出的深层文件泄漏。

```ts
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/** 0.71 根 extension 注册函数；可直接转发公开 default。 */
export declare function upstreamSubagentRuntime(pi: ExtensionAPI): void;

/** 以下四个签名仅记录缺口；在公开 API 出现前禁止实现。 */
export declare function loadConfig(): never;
export declare function registerSubagentNotify(...args: never[]): never;
export declare function resolveCurrentSessionId(sessionManager: {
  getSessionFile(): string | null | undefined;
  getSessionId(): string | null | undefined;
}): never;
export declare function currentCompletionOwnerId(): never;
export declare function getArtifactsDir(
  sessionFile: string | null,
  projectCwd?: string,
  dirPreference?: "project" | "session" | "temp",
): never;

/** 展示类 transcript 类型；实现只能产生独立显示投影。 */
export type FleetTranscriptEvent =
  | { kind: "assistant"; text: string; model?: string; timestamp?: number }
  | { kind: "user"; text: string; timestamp?: number }
  | {
      kind: "tool";
      toolCallId?: string;
      name: string;
      args?: string;
      argsPayload?: string;
      output?: string;
      outputTruncated?: boolean;
      status: "running" | "complete" | "error";
      error?: string;
      startedAt?: number;
      endedAt?: number;
      timestamp?: number;
    }
  | { kind: "notice"; text: string; tone: "muted" | "warning" | "error"; timestamp?: number };
export interface FleetTranscript {
  path: string;
  events: FleetTranscriptEvent[];
  truncated: boolean;
  warning?: string;
}
export interface FleetTranscriptReadOptions {
  trustedRoots: string[];
  trustedFiles?: string[];
  trustedFileRoot?: string;
  maxRecords?: number;
  maxBytes?: number;
}
export declare function readFleetTranscript(
  filePath: string,
  options: FleetTranscriptReadOptions,
): FleetTranscript;
export declare function renderFleetTranscript(
  transcript: FleetTranscript,
  width: number,
  theme: ExtensionContext["ui"]["theme"],
  markdownTheme: MarkdownTheme,
  options?: { expandedTools?: boolean },
): string[];

/** discovery 缺口不导出 AgentConfig；必须等公开 admission API。 */
export declare function discoverAgents(...args: never[]): never;
```

`never` 的含义是“安全缺口占位，禁止调用”，不是建议在 T5 写一个总抛错的生产 facade。T5 必须先取得公开 API 或升级决策项解除；否则旧 import 删除后对应调用方应停止编译/停止升级，而不是静默降级。

## 4. capability 协商清单

0.71 的 RPC ping 实现证据为 `src/extension/rpc.js:307-336`；其 `session` 由 `sessionData` 在 `:298-305` 投影，`spawn` 通过 `:568-570` 进入同一执行路径。协商必须先 ping 一次，未知字段透传但不得误读。

| capability / method | 类别 | 协商与缺失策略 | 静态证据/动态项 |
| --- | --- | --- | --- |
| RPC version=1、`ping`、`spawn` | 安全 | 缺任一项 fail closed，拒绝 spawn 并停止升级 | `rpc.js:307-313`；本仓 `extension.ts:306-320` 已验证 version/method/session/cwd |
| `session.sessionId` + `session.sessionFile` + `session.cwd` | 安全/身份 | 缺失、空值或 cwd 不等于宿主 orchestrator cwd 时 fail closed | `rpc.js:298-305,336`；动态 T11 需验证 parent/root session identity 与 cwd |
| `status` + `statusProjection` | 展示（status 结果中的释放判断仍属安全） | 缺失可降级为 unavailable 展示；不得把 unavailable 当 terminal | `rpc.js:313-317`；T11 覆盖 active/terminal/awaiting-disposition |
| `asyncSpawn` | 安全 | 缺失拒绝异步 spawn；不改用未协商 CLI | `rpc.js:317`；T11 fresh spawn |
| `steer` / `nonRecoveringSteer` | 安全生命周期 | 缺失对应 control 操作拒绝；不将 `agent_settled` 当 delivered | `rpc.js:318-320`；T11 steer→consumed follow-up |
| `interrupt` / `stop` / `resume` | 安全生命周期 | 各自缺失拒绝该操作；展示可标注 unavailable | `rpc.js:320-322`；T11 interrupt/resume、retained resume |
| `launchResolvedExtensions` / `runtimeAcknowledgedExtensions` | 安全准入 | 缺失时不能承诺 required child extension 已加载；spawn fail closed | `rpc.js:323-324`；T11 loader/branch switching |
| `processTerminalProof` | 安全终局 authority | 缺失直接 fail closed；禁止用 `agent_end` 或 process exit 猜 terminal | `rpc.js:325`、`process-terminal.js:134-226`；T11 terminal proof 前后处置矩阵 |
| `cost` | 展示/计量 | 缺失只显示 cost unavailable，不影响生命周期 | `rpc.js:326`；T11 cost projection |
| `fleetStatus` / `asyncStatusSnapshot` | 展示 | 缺失降级为最小 raw status；未知 status 归 awaiting-disposition | `rpc.js:315-317`；T11 status projection |
| `events.processTerminal` / `events.asyncComplete` / `events.childStatus` | 安全证据/展示 | terminal event 缺失不得补造 proof；展示事件可降级 | `rpc.js:328-335`；T11 事件序列 |
| `worktree` / `worktreeProvider` 配置 | 安全资源边界 | 静态可见配置键，但不能证明本仓 writePaths/action token 语义；继续禁用 upstream worktree | `types.d.ts:2592-2600`；T11 验证 child 不创建 upstream worktree |

**静态不可确认项，移交 T11 动态矩阵：** ping→spawn 的真实 reply（runId/asyncDir/cwd）；parent/root session 与 child session 的身份关联；`agent_end`、`agent_settled`、process-terminal proof 的严格时序；steer/follow-up 的 delivered receipt；terminal proof 与 integrate/discard/preserve/release 的绑定；真实 fresh/fork、retained resume、nested child、context_edit/pruned-fork、通知去重及 cost 记录。任何安全项动态失败均 fail closed，不回退 0.62 假设。

## 5. authority / 等待边图

### 5.1 0.71 terminal proof 的产生和消费

```text
child runner close
  └─ async-execution.js:501-513 观察 close，调用 finalizeProcessTerminal(asyncDir, runId, runnerClose)
       └─ process-terminal.js:134-226
            ├─ 校验 candidate writers / session lease / process tree (:153-205)
            ├─ 写入 process-terminal.json (:214-220)
            └─ 追加 subagent.run.process_terminal 事件 (:221)
                 ├─ RPC ping 宣布 processTerminalProof capability + event (:307-335)
                 ├─ status / async snapshot 投影（消费方）
                 └─ release / capacity 门（active-async-capacity.js:162-187）
                      仅 observed 且 runId、runnerProcessInstanceId 匹配才可 release
```

这里的 terminal proof 产生方是 runner close 的 finalize，不是 `agent_settled`。`agent_settled` 只能作为 Host 观察通知；它没有在上述 proof writer 中出现。`active-async-capacity.js:171-187` 明确要求 terminal state 后仍读取 proof，proof 不匹配时保留资源。因而等待边是：`spawn reply → child execution → agent_end/settled observations → runner close → durable terminal proof → status/release/disposition consumer`；后续消费方必须等待 proof，不能只等待模型回合结束。

### 5.2 与本仓两段边界映射

**A 段：child 参与型动作（冲突续接 / admission / rebase 启动）。** 本仓 `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts:118-121` 在 `agent_end` 内发冲突 follow-up；`:143-150` 注释和 handler 证明 Pi 会等待 `agent_end` handler，再决定 queued continuation，而 `agent_settled` 仅计数观察。`child-extensions/integration-queue.ts:250-274` 同样在 `agent_end` 中做 eligibility、inspect、bounded continuation，`:274` 的 settled handler 明确 observation-only。因此等待边是 `agent_end(awaited) → admission/continue/rebase start`，不能后移到 settled，也不能等待最终 terminal proof 才发起 child 参与型动作，否则会丢失冲突续接窗口。

**B 段：终局门控（发布 / 释放 / 回收 / preserve 处置）。** 本仓 workspace service 已将终局动作与 proof/token 绑定：`packages/pi-subagents-enhanced/src/workspace/service.ts:400-426` 解析 proof 并计算 allowed actions；`:429-452` 以 action token、snapshot hash 和 proofId 发放/消费 publish action；`:460-485` 同样门控 apply/discard；`:552-592` 的 dispose 检查 challenge 的 snapshot/proof hash 后才处置。故 B 段边是 `durable terminal proof → workspace status/proof validation → action token → integrate/release/discard/preserve`。A 段与 B 段不可合并：`agent_end` 可启动 A 段，但不能授权 B 段；`agent_settled` 只观察，不是任一段的权威完成证据。

## 6. upstream worktree 替代可行性评估

本节是用户要求新增的 Phase 2 评估，不改变本次 T9 的“禁用 upstream、单一 owner”策略。

### 6.1 缺口一：writePaths 级写路径门禁

**裁决：不可让渡。** 0.71 的 `src/runs/shared/worktree.js:195-206` 只检查 git 仓库和 source checkout 在排除 `.pi/subagents` 后是否 clean；`captureWorktreeDiff` 在 `:935-950` 采集相对 base 的全部 patch。没有 `writePaths` 字段、匹配器或拒绝越界文件的证据。其配置 `worktree`/`worktreeProvider`（`src/shared/types.d.ts:2592-2600`）也没有路径白名单。对照本仓 `git-worktree.ts:249-251,396` 的 `assertManagedWorkspaceWritePaths`，upstream 不能承接本任务的 write-path 封闭性。迁移建议：只有 upstream 增加 typed policy（声明 writePaths、在 capture/publish 前 canonicalize 并 fail closed）并提供可验证 receipt 后，才可重新评估。

### 6.2 缺口二：处置是否绑定 terminal proof/action token

**裁决：不可让渡。** upstream `cleanupSingleWorktree` 在 `src/runs/shared/worktree.js:984-1000` 处理 preserve blocker；`:1027-1062` 对 preserve 依赖 captured handoff patch；`:1064-1083` 对 discard 只调用 `resolveAuthorityDecision` 并要求 policy/confirmation；`:1087-1100` 随后直接执行 `git worktree remove --force` 和 branch 删除。`cleanupWorktrees` 在 `:1293-1299` 只接收 `intent`。这些行没有 terminal proof 校验、proofId、一次性 action token、snapshot hash 或 integrate 语义；upstream 也未提供 integrate/publish/discard/preserve 的统一终局 receipt。对照本仓 `service.ts:429-485,552-592`，缺口是安全边界而非可接受降级。迁移建议：upstream 必须先提供 terminal-proof provider、每个 disposition 的一次性 action token 和 proof/snapshot 绑定，且 token 消费必须原子化。

### 6.3 缺口三：身份模型是否绑定宿主会话 cwd

**裁决：不可让渡（当前证据不足且 fail closed）。** upstream RPC ping 确实返回宿主 `ctx.cwd`、`sessionId`、`sessionFile`（`src/extension/rpc.js:298-305,336`），这只能证明 ping projection 存在；worktree allocator 的 source 证明仍以传入 `cwd` 做 git probe（`worktree.js:195-206`），并未在 worktree record/cleanup contract 中证明 `sessionId/sessionFile` 与 owner cwd 绑定。现有 worktree 类型主要保留 path/branch/provider/naming（`src/shared/types.d.ts:390-427`），未见 host-session identity 字段。迁移建议：upstream 需让 allocation receipt 同时绑定 canonical host session identity、origin root、dispatch cwd，并在每次 disposition 校验三者；在此证据出现前，不能把 upstream worktree 视作跨仓派发身份解锁点。

**总裁决：不可让渡。** 三个缺口均不是本仓可以通过配置弥补的差异；Phase 2 若要迁移，先以 upstream typed policy/receipt 补齐 writePaths、terminal proof+action token、session/cwd binding，再做独立 TDD 和真实链路评估。本次 T9 保留本仓 workspace service 为唯一 owner，并显式禁用 0.71 upstream worktree。

## 7. 真实最小链路 trace（0.62 基线探针）

按授权边界只执行了一次计划规定的隔离 shell，未重试：

```sh
env PI_REAL_BIN=$HOME/pi-config-upgrade/node_modules/.bin/pi \
 PI_CODING_AGENT_SESSION_DIR=$HOME/pi-config-upgrade/var/sessions \
 PI_CODING_AGENT_GOAL_DIR=$HOME/pi-config-upgrade/var/goals \
 PI_CODING_AGENT_WORKSPACE_DIR=$HOME/pi-config-upgrade/var/workspaces \
 PI_SESSION_OWNER_REGISTRY=$HOME/pi-config-upgrade/var/tmp/session-owner-registry \
 TMPDIR=$HOME/pi-config-upgrade/var/tmp \
 zsh -f -c 'source ~/pi-config-upgrade/scripts/pi-shell.zsh; cd ~/pi-config-upgrade; pi -p "通过 subagent 工具派发一个最小 generic 任务：让 executor 执行 pwd 并返回。"'
```

证据文件：

- `var/upgrade/trace/real-minimal-link.stdout`：0 bytes，parent 没有正常输出。
- `var/upgrade/trace/real-minimal-link.stderr`：
  `No API key found for the selected model.`，并指向 clone 内 provider 文档。
- `var/upgrade/trace/real-minimal-link.exit`：`1`。

这次调用在 Host/model 初始化阶段失败，未进入合法 public dispatch；因此没有伪造 parent/root session、child runId/cwd、RPC ping/spawn reply 或 `agent_end`/`agent_settled`/terminal proof 事件。这是放行前提未满足的原文证据，不是成功链路。按停止条件不重试、不直接 import 内部模块、不手工 event、不 fake child。该 trace 验证了探针 shell 的隔离路径和失败留存方法，但**不能**证明 0.62 基线真实 spawn 成功；0.71 行为差异仍以第 4/5/6 节和 T11 动态矩阵为准。

## 升级决策项清单

1. **通知投递缺口（安全，曾阻塞 T5）→ 已关闭（2026-09-29 用户决策：删除增强层包装）**：0.71 未公开 `registerSubagentNotify`；不得复制内部 notifier 或用事件/轮询替代。用户决策：删除增强层 compat completion notifier 包装（`createCompletionNotifier`/`subscribeAsyncComplete` 及 `subagent-runtime.ts` 的 `completionNotifierFactory` 接线），完成投递+ack 完全依赖上游原生 notify 语义（bootstrap 注册，`notify.js:428` 发送 `subagent-notify`，result 文件仅在 `sendMessage()` 接受后删除）；项目 `subagent-notify` renderer 保留。执行与验证记录：`var/upgrade/p1-notifier-removal.md`。
2. **owner identity 缺口（安全，阻塞 T5）**：`resolveCurrentSessionId` 与 `currentCompletionOwnerId` 均未公开；不得自行生成 owner/session identity。
3. **artifact authority 缺口（安全，阻塞 T5）**：`getArtifactsDir` 未公开；不得拼接路径承诺 artifact/terminal authority。
4. **agent admission 缺口（安全，阻塞 T5）**：`discoverAgents`/`AgentConfig` 未公开；不得以目录扫描替代准入发现。
5. **真实链路未通过（放行阻塞）**：一次隔离 Host 探针因缺少所选模型 API key 在初始化阶段退出，故未获得 parent/child/RPC/terminal 事件证据；只能保留失败原文，不得重试。
6. **upstream worktree 不可让渡（Phase 2）**：缺少 writePaths、terminal proof/action token、host-session cwd binding；T9 必须保持本仓 workspace service 单一 owner。

## 证据索引

- Shadow 安装与公开 import 矩阵：`/Users/leshi.zhy/pi-config-upgrade/var/upgrade/trace/shadow-public-imports.txt`
- 真实探针 stdout/stderr/exit：`/Users/leshi.zhy/pi-config-upgrade/var/upgrade/trace/real-minimal-link.{stdout,stderr,exit}`
- 0.62 基线摘要：`var/upgrade/baseline-0.87.1-0.62.md`
- 四份审计副本：`var/upgrade/inputs/{d6cf9f40-4357-468e-843e-607b2ce751b9,cbe224ed-8307-4e64-b0db-a29a3fd6267e,44baada9-3691-4828-81c2-8a972356a162,d98b5ed1-6c6d-461f-8c65-b85d3c048ba2}.inline`
- 本仓 A 段证据：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts:118-121,143-150`、`child-extensions/integration-queue.ts:250-274`

## 8. 真实最小链路 trace 补跑（auth.json 就位后，2026-09-27）

- 凭据决策：用户批准复制主树 pi/auth.json 至 clone（同机同用户，两侧均 gitignored，600 权限）。
- 同一隔离 shell 模板重跑：exit=0；parent 经 public dispatch 派发 executor child，child 执行 pwd 返回 /Users/leshi.zhy/pi-config-upgrade。
- 证据：var/upgrade/trace/real-minimal-link-2.{stdout,stderr,exit}。
- 结论：放行前提满足。0.62 基线的真实 Host + public dispatch 链路在隔离环境验证通过；
  同时印证 clone 内宿主会话的身份断言路径可用（session.cwd = clone = dispatch origin）。
- stderr 的 fallback model 不可用提示为环境性告警（隔离环境模型清单受限），不影响链路判定。
