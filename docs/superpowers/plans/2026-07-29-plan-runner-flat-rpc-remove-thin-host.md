# Plan Runner 扁平 RPC 与薄 Host 退役 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除独立 Standalone Plan Host，让 Main Agent 与 Plan Runner 都通过项目 `subagent` tool adapter 请求 Root session 的同一套 `pi-subagents` RPC runtime；Plan Runner 与 Executor 在 runtime 中保持扁平一级 run，在 Plan 领域中保持可审计的逻辑父子关系，并随 Root session 一起终止。

**Architecture:** Root extension 持有唯一上游 `pi-subagents` runtime，并在当前 Root session 内启动一个 Unix-domain-socket RPC broker。Main 的本地 adapter 直接使用 Root event bus；Plan Runner child 加载 child-safe adapter，通过 broker 把同一份 typed tool 请求转发回 Root，再由 Root 本地 RPC bridge 派发 Executor。Broker 不向上游传递 caller/parent/depth，因此 Plan Runner 和 Executor 都是 runtime 一级 run；Plan event、一次性 dispatch authorization 和 broker ownership map 维护领域关系、Supervisor 路由与清理责任。

**Tech Stack:** Node.js 22 ESM/TypeScript、Pi Extension API、Unix domain sockets、`pi-subagents@0.37.0` RPC v1、Plan Event Writer、Node 内置 test runner、真实 Pi headless Harness。

---

## 0. 前置条件与红线

本计划在 `2026-07-29-plan-ir-v3-complete-capsule-contract.md` 的 Task 1-9 全部完成后执行。实施前以当时 `main` 为基线重新确认文件行号，但不得改变以下合同：

1. Root session 是 Plan Runner 与 Executor 的唯一进程生命周期 owner；Root A 关闭后，Root B 不 attach、不 resume、不管理 A 的 run。
2. 领域拓扑是 `Main -> Plan Runner -> Executor`，runtime 拓扑是 Root 下两个扁平一级 run。
3. 不修改 `pi/npm/node_modules/pi-subagents/**`，不启用 `fanout-child`，不在 Plan Runner 内 re-root，不伪造或改写 `PI_SUBAGENT_PARENT_DEPTH/RUN_ID/PATH`。
4. Plan Runner 只能通过项目 typed `subagent` tool 派发由 Harness 预先授权的完整 Executor `dispatch-ir.v1`；模型不能自由构造、扩大或重放合同。
5. Main/Plan Runner 不构造 Plan IR；revision store 仍是 Plan Markdown 到 IR 的唯一 compiler。
6. Root broker 只承担 transport、run ownership 和生命周期路由，不拥有 DAG、revision、Attempt、Git、Gate 或 amendment 状态机。
7. 不采用 `pi-worktree` 替代 `workspace.mjs` / `attempt-workspace.mjs`。
8. 旧 Host handle 不做跨 Root session 自动迁移；旧 schema 只返回明确的 unsupported/migration error。

## 1. 文件职责图

### 新建文件

- `scripts/lib/subagent-dispatch/root-broker-protocol.ts`：broker envelope、响应、push event、socket path 和严格 parser。
- `scripts/lib/subagent-dispatch/root-broker-server.ts`：Root 内 Unix socket server、caller grant、run ownership、上游 RPC 转发和 push subscription。
- `scripts/lib/subagent-dispatch/root-broker-client.ts`：child-safe request/reply client、生命周期订阅、断线 fail-close。
- `scripts/lib/subagent-dispatch/root-broker-registry.ts`：同一 Root 进程内供 runtime extension 与 Plan Launcher 共享 broker handle；不做磁盘持久化。
- `pi/child-extensions/root-owned-subagent.ts`：Plan Runner child 的 typed `subagent` / `plan_executor_supervisor` adapter 和 Root ownership subscription。
- `pi/child-extensions/root-session-owner.ts`：Plan Runner 与 Executor 共用的 Root socket ownership guard；Root socket 消失时终止 child。
- `scripts/lib/plan/plan-executor-tool-boundary.mjs`：一次性 Executor tool-call authorization、tool result binding 和 bind-or-cleanup。
- `test/root-subagent-broker-protocol.test.mjs`：协议与 socket identity 单测。
- `test/root-subagent-broker.test.mjs`：server/client、ownership、flat forwarding、push 与 shutdown 单测。
- `test/plan-executor-tool-boundary.test.mjs`：Plan dispatch authorization 与工具结果绑定测试。
- `test/plan-flat-runtime-harness.integration.mjs`：真实 Root -> Plan Runner -> Executor、Supervisor 与 Root shutdown Harness。
- `docs/architecture/plan-runner-flat-runtime.md`：最终架构、生命周期矩阵和被淘汰方案。

### 修改文件

- `scripts/lib/subagent-dispatch/extension.ts`：复用 typed tool 的 injected RPC；暴露 Root supervisor adapter 给 broker，不新增第二套 tool schema。
- `pi/extensions/subagent-runtime.ts`：启动/关闭 Root broker，并在上游 runtime dispose 前执行 broker drain。
- `scripts/lib/plan/plan-launcher-extension.mjs`：通过 Root typed RPC 启动/管理 Plan Runner，改用 session-local handle。
- `scripts/lib/plan/plan-capsule-extension.mjs`：允许受控 `subagent`，拦截 tool call/result，删除 Standalone Host 文案和本地 Supervisor 假设。
- `scripts/lib/plan/plan-runner-dependencies.mjs`：准备 Executor dispatch authorization，消费 broker lifecycle/supervisor push。
- `scripts/lib/plan/coordinator.mjs`：把“提交 dispatch intent”与“实际 spawn/bind”分开。
- `scripts/lib/plan/pi-subagents-execution-backend.mjs`：改为 broker-backed status/stop/artifact adapter；实际 spawn 由 tool boundary 完成。
- `pi/agents/plan-runner.md`：frontmatter 不声明 builtin `subagent`；项目 adapter 注册后由 Capsule 在 `plan_open` 后按一次性授权激活，删除本地 runtime wait/re-root 语义。
- `pi/agents/executor.md`：加载 Root session owner guard。
- `scripts/lib/plan/tui/plan-widget.mjs`、`scripts/lib/plan/plan-runtime-tools.mjs`、`scripts/probes/pi-subagents-compat.mjs`：迁移 Host 展示、工具激活文案和兼容 probe。
- `test/plan-runtime-migration.test.mjs`、`test/plan-runtime-tool-policy.test.mjs`、`test/pi-subagents-compat.test.mjs`、`test/subagent-runtime-resource-isolation.test.mjs`：覆盖旧 Host 消费者迁移。
- `test/subagent-runtime-membrane.test.mjs`、`test/plan-launcher-extension.test.mjs`、`test/plan-capsule-extension.test.mjs`、`test/plan-coordinator.test.mjs`、`test/plan-runner-dependencies.test.mjs`、`test/plan-execution-backend.test.mjs`：对应迁移测试。
- `scripts/doctor.mjs`、`test/doctor.test.mjs`：删除 Host 恢复检查，增加 Root broker/owner extension 检查。
- `docs/audits/2026-07-29-plan-runner-architecture-audit.md`：追加 superseding decision，明确旧“保留 Host/re-root”结论已被新生命周期合同淘汰。

### 删除文件

- `scripts/lib/plan/plan-host-runtime.mjs`
- `test/plan-host-runtime.test.mjs`
- Task 10 迁移最后一个真实 Harness fixture 后删除无生产调用方的 `scripts/lib/subagents-rpc-client.mjs` 与 `test/subagents-rpc-client.test.mjs`。
- 仅在 `rg` 证明无其他调用方后删除 `scripts/lib/plan/parent-lifecycle.mjs` 与对应测试；若仍有非 Host 调用方则保留该通用模块。

---

### Task 1: 冻结 Root Broker 协议

**Files:**
- Create: `scripts/lib/subagent-dispatch/root-broker-protocol.ts`
- Create: `test/root-subagent-broker-protocol.test.mjs`

- [ ] **Step 1: 写协议 parser 的失败测试**

测试固定 request 不包含 runtime parent/depth 字段，并拒绝未知 method、额外字段、路径型 runId 和错配 session：

```javascript
const request = {
  schemaVersion: "pi-root-subagent-broker-request.v1",
  requestId: "req-1",
  rootSessionId: "root-session-1",
  callerRunId: "plan-run-1",
  callerToken: "a".repeat(64),
  method: "spawn",
  params: { agent: "executor", task: "execute", async: true },
};
assert.deepEqual(parseBrokerRequest(request), request);
for (const forbidden of ["parentRunId", "parentDepth", "parentPath", "fanout"]) {
  assert.throws(() => parseBrokerRequest({ ...request, [forbidden]: "x" }), /additional|unsupported/i);
}
assert.throws(() => parseBrokerRequest({ ...request, callerToken: "short" }), /callerToken/);
assert.throws(() => parseBrokerRequest({ ...request, callerRunId: "../other" }), /callerRunId/);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/root-subagent-broker-protocol.test.mjs`

Expected: FAIL，`root-broker-protocol.ts` 不存在。

- [ ] **Step 3: 实现固定协议与 socket path**

协议只公开 Root broker 需要的字段：

```typescript
export const BROKER_METHODS = [
  "ping", "spawn", "status", "steer", "interrupt", "stop",
  "supervisor.pending", "supervisor.reply", "subscribe",
] as const;

export type BrokerRequest = {
  schemaVersion: "pi-root-subagent-broker-request.v1";
  requestId: string;
  rootSessionId: string;
  callerRunId: string;
  callerToken: string;
  method: typeof BROKER_METHODS[number];
  params: Record<string, unknown>;
};

export type BrokerPush = {
  schemaVersion: "pi-root-subagent-broker-push.v1";
  rootSessionId: string;
  callerRunId: string;
  type: "execution.started" | "execution.completed" | "supervisor.request" | "root.closing";
  data: Record<string, unknown>;
};
```

`supervisor.request` 的 canonical identity 固定为 `data.requestId := upstreamDetails.id`、`data.executorRunId := upstreamDetails.runId`；reply 只接受 `replyTo === requestId`。不得另生成 broker request identity，也不得把 child index/agent name 当唯一键。

`brokerSocketPath(rootSessionId)` 固定使用短根目录 `/tmp/pi-root-subagent-<uid>/` 与 `sha256(rootSessionId)` 文件名，目录权限 `0700`，socket 文件权限 `0600`，并断言最终 UTF-8 path 不超过 macOS Unix socket 的 103-byte 上限；不得使用可能过长的 `os.tmpdir()` session 子目录。parser 使用 exact-key 比较，不接受 caller hierarchy 字段。`brokerGrantPath(rootSessionId, runId)` 位于同一短目录的 `grants/`，内容固定 `{schemaVersion,rootSessionId,runId,callerToken,role}`、权限 `0600`。同 UID 进程可读取该目录，因此权限和 token 只承担误路由/typed 参数防伪，不声明跨同 UID 进程的安全隔离。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
node --test test/root-subagent-broker-protocol.test.mjs
git add scripts/lib/subagent-dispatch/root-broker-protocol.ts test/root-subagent-broker-protocol.test.mjs
git commit -m "feat(subagent): 定义 Root RPC broker 协议"
```

Expected: PASS；协议无法表达 runtime 嵌套 parent。

---

### Task 2: 建立 Root Session Broker

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/subagent-dispatch/root-broker-server.ts`
- Create: `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify: `pi/extensions/subagent-runtime.ts`
- Create: `test/root-subagent-broker.test.mjs`
- Modify: `test/subagent-runtime-membrane.test.mjs`

- [ ] **Step 1: 写 flat forwarding 与 ownership RED 测试**

使用 fake upstream RPC 断言 broker 转发时只发送原始 method params：

```javascript
await broker.grantCaller({ callerRunId: "plan-run-1", planId: "plan-1", cwd: "/repo", role: "plan-runner" });
const reply = await client.spawn({ agent: "executor", task: "execute", cwd: "/attempt" });
assert.deepEqual(upstream.spawnCalls[0], {
  agent: "executor", task: "execute", cwd: "/attempt", async: true, clarify: false,
});
assert.equal("callerRunId" in upstream.spawnCalls[0], false);
assert.equal("callerToken" in upstream.spawnCalls[0], false);
assert.equal("parentRunId" in upstream.spawnCalls[0], false);
assert.equal(reply.details.runId, "executor-run-1");
await assert.rejects(otherClient.stop({ runId: "executor-run-1", dir: "/async/1" }), /not owned/i);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/root-subagent-broker.test.mjs test/subagent-runtime-membrane.test.mjs`

Expected: FAIL，Root broker API 尚不存在。

- [ ] **Step 3: 实现 session-local registry**

`root-broker-registry.ts` 只保存当前进程对象，不写文件：

```typescript
const brokers = new WeakMap<object, RootBrokerServer>();
export function bindRootBroker(pi: object, broker: RootBrokerServer): void {
  if (brokers.has(pi)) throw new Error("Root subagent broker is already bound");
  brokers.set(pi, broker);
}
export function requireRootBroker(pi: object): RootBrokerServer {
  const broker = brokers.get(pi);
  if (!broker) throw new Error("Root subagent broker is unavailable");
  return broker;
}
export function unbindRootBroker(pi: object): void { brokers.delete(pi); }
```

- [ ] **Step 4: 实现 broker server 和上游 membrane**

Server 持有：

```typescript
Map<callerRunId, { planId: string; cwd: string; role: "plan-runner"; callerToken: string; ownedRunIds: Set<string> }>
Map<executorRunId, callerRunId>
Map<callerRunId, Set<Socket>>
```

`spawn` 只允许已 grant 的 `plan-runner` caller 派发 `executor`/`spark`，每次 request 必须同时匹配 `callerRunId + callerToken + rootSessionId`。`grantCaller()` 生成 256-bit token 并原子写入 adapter-private grant 文件；Plan Runner 在 IR v3 Task 6 后没有 `bash/edit/write`，typed tool 参数也不能覆盖 token。该 token 只用于协议防误路由，不提供同 UID 进程隔离。Broker 调用 Root 本地 `createTypedSubagentRpcClient(pi.events)`；成功后记录 run ownership，并为 Executor 写 role=`executor` 的 ownership grant。`status/steer/interrupt/stop` 必须先验证 target run 属于 caller。`ping` 返回上游 capability，但把 `session.cwd` 投影为 grant 的 Plan Runner cwd，满足 typed tool 的 caller-local capability check。

- [ ] **Step 5: 保证 shutdown 顺序早于上游 dispose**

扩展 `createTypedSubagentExtension` 的 options，增加 `beforeDispose = async () => {}`。它的 `session_shutdown` handler 必须：

```typescript
pi.on("session_shutdown", async () => {
  if (registry.get(pi)?.token !== token) return;
  await beforeDispose();
  dispose();
  registry.delete(pi);
});
```

`installHeadlessTypedSubagentRuntime(pi, { beforeRuntimeDispose, ...options })` 把 `beforeRuntimeDispose` 作为 `beforeDispose` 传入同一个 typed extension；不得另注册一个顺序不确定的 shutdown handler。`pi/extensions/subagent-runtime.ts` 在 `session_start` 启动 broker，在 `beforeRuntimeDispose` 调用 `broker.closeRootSession()`。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
node --test test/root-subagent-broker.test.mjs test/subagent-runtime-membrane.test.mjs
git add scripts/lib/subagent-dispatch/root-broker-server.ts scripts/lib/subagent-dispatch/root-broker-registry.ts scripts/lib/subagent-dispatch/extension.ts pi/extensions/subagent-runtime.ts test/root-subagent-broker.test.mjs test/subagent-runtime-membrane.test.mjs
git commit -m "feat(subagent): 增加 Root session RPC broker"
```

Expected: PASS；所有 upstream spawn call 都不含 caller hierarchy。

---

### Task 3: 增加 Child-Safe Typed Adapter 与 Root Ownership Guard

**Deps:** Task 2

**Files:**
- Create: `scripts/lib/subagent-dispatch/root-broker-client.ts`
- Modify: `scripts/lib/subagent-dispatch/supervisor-adapter.ts`
- Create: `pi/child-extensions/root-owned-subagent.ts`
- Create: `pi/child-extensions/root-session-owner.ts`
- Modify: `pi/child-extensions/plan-runner.ts`
- Modify: `pi/agents/plan-runner.md`
- Modify: `pi/agents/executor.md`
- Modify: `test/root-subagent-broker.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `test/subagent-supervisor-adapter.test.mjs`

- [ ] **Step 1: 写 child adapter 与断线 RED 测试**

测试用真实 Unix socket 和 fake Pi API，并用真实 `pi-subagents` `resolvePiLaunchToolPlan`/child argv probe 固定 extension 注册与 upstream fanout 判定：

```javascript
assert.deepEqual(registeredTools.map((tool) => tool.name).sort(), ["plan_executor_supervisor", "subagent"]);
assert.deepEqual(planRunnerFrontmatter.tools.filter((name) => name.startsWith("subagent")), []);
assert.equal(launchPlan.declaredBuiltinTools.includes("subagent"), false);
assert.equal(launchPlan.fanoutAuthorized, false);
assert.equal(launchPlan.extensionArgs.some((path) => path.endsWith("fanout-child.ts")), false);
assert.equal(observedChildArgv.some((arg) => arg.endsWith("fanout-child.ts")), false);
await registeredToolsByName.get("plan_executor_supervisor").execute("call", { action: "status" });
assert.equal(brokerSupervisorCalls.length, 1);
assert.equal(nativeRootSupervisorCalls.length, 0);
assert.equal(observedChild.env.PI_SUBAGENT_FANOUT_CHILD, "0");
assert.equal(observedChild.env.PI_SUBAGENT_PARENT_DEPTH || undefined, undefined);
assert.equal(observedChild.env.PI_SUBAGENT_PARENT_RUN_ID || undefined, undefined);
assert.equal(processEnvMutations.some((name) => name.startsWith("PI_SUBAGENT_PARENT_")), false);
server.destroyAllConnections();
await ownerClosed;
assert.deepEqual(signals, [{ pid: process.pid, signal: "SIGTERM", reason: "root-session-disconnected" }]);
```

另断言缺少 `PI_SUBAGENT_RUN_ID` 或 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 时 extension fail closed，不回退到本地 `pi.events`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/root-subagent-broker.test.mjs test/pi-subagents-compat.test.mjs`

Expected: FAIL，child broker client/extension 不存在。

- [ ] **Step 3: 实现 request/reply 与 subscription client**

每个 request 使用一条 JSONL socket 连接；`subscribe` 保持长连接。Client 从 adapter-private grant 文件读取 `callerToken`，每个 envelope 自动写 `rootSessionId/callerRunId/callerToken`，tool 参数不能覆盖。Token 只防止模型通过 typed tool 参数伪造 caller 和误路由，不作为同 UID 恶意进程隔离边界；Root B 拒绝旧 run 依赖 in-memory registry/session ownership，不依赖 token secrecy。Client API 与 typed extension 的 injected RPC 相同：

```typescript
export interface RootBrokerRpc {
  ping(): Promise<unknown>;
  spawn(params: object): Promise<unknown>;
  status(params: object): Promise<unknown>;
  steer(params: object): Promise<unknown>;
  interrupt(params: object): Promise<unknown>;
  stop(params: object): Promise<unknown>;
  supervisorPending(): Promise<unknown>;
  supervisorReply(params: object): Promise<unknown>;
  subscribe(onPush: (push: BrokerPush) => void): Promise<{ dispose(): void }>;
  dispose(): void;
}
```

断线、错 session、错 caller、非 JSON reply 都拒绝 pending calls；不得切换到 local event-bus RPC。

- [ ] **Step 4: 注册 typed tools，但让 upstream fanoutAuthorized 保持 false**

`root-owned-subagent.ts` 调用 `createTypedSubagentExtension(pi, { rpc: brokerClient })` 时不传 supervisor adapter，只注册项目 `subagent`。由于 Pi loader 对跨 extension 同名 tool 采用 first-registration-wins，upstream prompt runtime 固定早于 configured extension，项目不得尝试覆盖原生 `subagent_supervisor`。先以 RED 测试扩展 `createSupervisorTool(adapter, {name,label})`，默认调用保持现有 `subagent_supervisor`，root-owned 则用 `{name:"plan_executor_supervisor",label:"Plan Executor Supervisor"}` 创建唯一项目 tool；其 execute 只调用 broker supervisor client。测试触发全部 session_start handler 后执行该项目 tool，并证明调用 broker、没有调用 upstream native Root supervisor channel。extension 不 import upstream extension，不读写 child/depth/fanout env。

`plan-runner.md` frontmatter 的 `tools` **不得包含** `subagent`、`subagent_wait`、`subagent_supervisor` 或 `plan_executor_supervisor`。`subagent` 会让 upstream 确定性加载 `fanout-child.ts`；另外两个 upstream 名称会错误授权 prompt runtime 的 local wait/direct Root supervisor。既有 `subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs` 保持唯一 profile entry；`pi/child-extensions/plan-runner.ts` 在现有 Capsule 之前安装 `root-owned-subagent.ts`，不得在 frontmatter 追加第二条不受 launcher 校验的 extension path。项目 extension 注册 `subagent/plan_executor_supervisor`，Capsule 在 `plan_open` 成功后用 `pi.setActiveTools()` 激活这两个工具。Executor lifecycle 通过 Task 6 broker push/follow-up 驱动，不使用 Plan Runner 本地 `subagent_wait`。

Step 1 的真实 argv probe 必须同时证明：项目 tools 已注册并可激活、`plan_executor_supervisor` 调用 broker、`declaredBuiltinTools` 不含三个 upstream subagent 名称、`fanoutAuthorized=false`、child argv 不含 `fanout-child.ts`、`PI_SUBAGENT_FANOUT_CHILD !== "1"`。任何一项失败都阻断本计划，不得清除环境变量或改写 upstream package 绕过。

- [ ] **Step 5: 为 Plan Runner 与 Executor 安装 ownership guard**

`root-session-owner.ts` 使用标准 `PI_SUBAGENT_RUN_ID` 和 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 读取对应 grant 文件并建立 `subscribe`。Plan Runner grant 在 Launcher 获得 spawn reply 后发布；Executor grant 在 broker 观察到 async-started/reply binding 后发布，因此 owner extension 对 `GRANT_NOT_READY` 使用固定 5 秒 startup deadline 与 25ms backoff，deadline 内只重试该错误，其他错误立即 fail closed。Root 推送 `root.closing` 或已建立 subscription 的 socket EOF 时只执行一次：

```typescript
await Promise.resolve(pi.sendMessage?.({
  customType: "pi-root-session-closing-v1",
  content: "Root session closed; this child must terminate.",
  details: { rootSessionId, runId },
})).catch(() => {});
kill(process.pid, "SIGTERM");
```

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
node --test test/root-subagent-broker.test.mjs test/pi-subagents-compat.test.mjs test/subagent-supervisor-adapter.test.mjs
git add scripts/lib/subagent-dispatch/root-broker-client.ts scripts/lib/subagent-dispatch/supervisor-adapter.ts pi/child-extensions/root-owned-subagent.ts pi/child-extensions/root-session-owner.ts pi/child-extensions/plan-runner.ts pi/agents/plan-runner.md pi/agents/executor.md test/root-subagent-broker.test.mjs test/pi-subagents-compat.test.mjs test/subagent-supervisor-adapter.test.mjs
git commit -m "feat(subagent): 增加 child-safe 远程派发适配器"
```

Expected: PASS；Plan Runner/Executor 都保持 runtime depth 1，Root socket 消失会终止 child。

---

### Task 4: 通过 Root RPC 启动 Plan Runner

**Deps:** Task 2, Task 3

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `pi/child-extensions/plan-runner.ts`
- Modify: `test/plan-launcher-extension.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`

- [ ] **Step 1: 写 session-local handle RED 测试**

新 handle 固定为：

```javascript
assert.deepEqual(handle, {
  schemaVersion: "pi-plan-handle.v4",
  planId: "plan-1",
  revision: 1,
  manifestSha256: HASH_A,
  sourceBytesSha256: HASH_B,
  planHash: HASH_C,
  planIrHash: HASH_D,
  rootSessionId: "root-session-1",
  planRunnerRunId: "plan-runner-run-1",
  asyncDir: "/async/plan-runner-run-1",
  worktree: "/state/var/plan-worktrees/plan-1",
  baseCommit: "base",
});
assert.equal(await pathExists("/state/var/plan-runs/plan-1/host-handle.json"), false);
```

Root B 或不同 sessionId 调用 status/cancel 必须返回 `Plan run belongs to another Root session`，不得读取 persisted handle attach。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs`

Expected: FAIL，Launcher 仍创建 Standalone Host v3 handle。

- [ ] **Step 3: 用 Root broker spawn Plan Runner**

Launcher 保留 revision prepare 与 Plan worktree 创建，但替换 Host spawn：

```javascript
const reply = await rootRpc.spawn({
  agent: "plan-runner",
  title: `Plan ${planId}`,
  task: bootstrapRevisionIdentity(prepared, { planId, baseCommit, worktree }),
  cwd: worktree,
  context: "fresh",
  async: true,
  clarify: false,
  artifacts: true,
  output: false,
  timeoutMs: planRunnerTimeoutMs,
});
const binding = requireAsyncBinding(reply);
await broker.grantCaller({
  callerRunId: binding.runId,
  planId,
  cwd: worktree,
  role: "plan-runner",
});
```

Grant 失败必须 stop 已 spawn Plan Runner 并回滚 workspace。handle 只写当前 Root session branch，`plan-status/cancel` 从 branch + in-memory map 解析，不读磁盘 Host handle。

- [ ] **Step 4: 移除 child guard 与 Standalone 假设**

`pi/child-extensions/plan-runner.ts` 不再拒绝 `PI_SUBAGENT_CHILD`。它加载 Plan Capsule、Root broker client 和 root ownership guard，但不 bootstrap 上游 runtime。工具阻断文案从 “Standalone control plane” 改为 “Plan dispatch authorization boundary”。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs
git add scripts/lib/plan/plan-launcher-extension.mjs pi/child-extensions/plan-runner.ts test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs
git commit -m "feat(plan): 通过 Root RPC 启动 Plan Runner"
```

Expected: PASS；Root runtime 创建 Plan Runner 一级 run，v4 Plan handle 不持久化 PID/Host processIdentity/keeper 字段。

---

### Task 5: 建立一次性 Executor Tool Authorization

**Deps:** Task 4

**Files:**
- Create: `scripts/lib/plan/plan-executor-tool-boundary.mjs`
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `pi/agents/plan-runner.md`
- Create: `test/plan-executor-tool-boundary.test.mjs`
- Modify: `test/plan-coordinator.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写 exact-contract 与 replay RED 测试**

Coordinator 先提交 `attempt.workspace-allocated` 和 `attempt.dispatch-requested`，返回完整 `dispatch-ir.v1`。测试固定：

```javascript
const prepared = await coordinator.prepareAuthorizedDispatches();
assert.equal(prepared.dispatches.length, 1);
assert.equal(prepared.dispatches[0].contract.version, "dispatch-ir.v1");
assert.equal(prepared.dispatches[0].contract.taskId, "task-1");
assert.equal(prepared.dispatches[0].contractHash, projection.attempts.get(prepared.dispatches[0].attemptId).toolHash);
assert.doesNotThrow(() => boundary.authorize(prepared.dispatches[0].contract, projection));
assert.throws(() => boundary.authorize({ ...prepared.dispatches[0].contract, risk: "low" }, projection), /contract hash/i);
assert.throws(() => boundary.authorize(prepared.dispatches[0].contract, projection), /already authorized|replay/i);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/plan-executor-tool-boundary.test.mjs test/plan-coordinator.test.mjs test/plan-capsule-extension.test.mjs`

Expected: FAIL，Coordinator 仍直接调用 backend.spawn，Capsule 仍阻断所有 subagent。

- [ ] **Step 3: 分离 intent commit 与 tool execution**

`Coordinator.prepareAuthorizedDispatches()` 只做：frontier、resource/workspace、完整 execution view、dependency receipts、typed contract、`attempt.dispatch-requested`。它不调用 spawn。返回值固定：

```javascript
{
  state: "dispatch-required",
  dispatches: [{
    attemptId,
    dispatchId,
    contract,
    contractHash,
  }],
  projectionVersion,
}
```

`toolHash` 使用 typed contract canonical hash；`dispatchContextHash` 保持 Plan IR v3 既有算法。

- [ ] **Step 4: 实现一次性 boundary**

`authorize(input, projection)` 只接受 `executor` 或 `spark` 的完整 `dispatch-ir.v1`，重新 compile 并比较当前 `dispatch-requested` Attempt 的 `toolHash/taskHash/schedulingHash/dispatchContextHash`。Boundary 状态机固定为 `prepared -> executing(toolCallId) -> spawned(binding) -> bound | cleaned`，identity 为 `dispatchId + toolHash`；不同字段、第二个并发 toolCallId、其他 agent、control action 均拒绝。

已知 spawn 前的 typed tool validation error 消费本次 toolCallId 后可回到 `prepared` 重试；一旦 broker 已观察到 async-started，或 reply 丢失导致 spawn 是否发生不确定，authorization 不得重开，必须按 `dispatchId/requestId + cwd` 唯一 reconcile，找到一个 run 则 stop，零个或多个进入 durable `dispatch_uncertain`。测试覆盖 tool abort、缺失 `tool_result`、reply 丢失、`resolveAttempt` 抛错和 late cancel。

- [ ] **Step 5: 允许 Plan Runner 调用 exact subagent tool**

Capsule `tool_call` 对 `subagent` 调用 `authorizeExecutorDispatch`；授权失败返回 block。`plan_open` 后 active tools 精确包含项目 `subagent/plan_executor_supervisor` 且不包含 `subagent_wait/subagent_supervisor`；`plan_continue` 返回 exact contract 后，Plan Runner prompt 固定要求逐个原样调用 `subagent`，不得重写字段；没有 pending dispatch 时禁止调用。完成/阻断由 broker lifecycle push 发送 follow-up，再调用 `plan_status`，不得等待本地 upstream run map。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
node --test test/plan-executor-tool-boundary.test.mjs test/plan-coordinator.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git add scripts/lib/plan/plan-executor-tool-boundary.mjs scripts/lib/plan/coordinator.mjs scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs pi/agents/plan-runner.md test/plan-executor-tool-boundary.test.mjs test/plan-coordinator.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 授权 Plan Runner 工具派发"
```

Expected: PASS；模型只能执行 Event Writer 已提交的一次性 dispatch contract。

---

### Task 6: 绑定 Tool Result 并转发 Runtime Lifecycle

**Deps:** Task 5

**Files:**
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-protocol.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-server.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-client.ts`
- Modify: `pi/child-extensions/root-owned-subagent.ts`
- Modify: `pi/child-extensions/plan-runner.ts`
- Modify: `scripts/lib/plan/plan-executor-tool-boundary.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `scripts/lib/plan/pi-subagents-execution-backend.mjs`
- Modify: `test/subagent-dispatch-extension.test.ts`
- Modify: `test/root-subagent-broker.test.mjs`
- Modify: `test/plan-executor-tool-boundary.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-coordinator.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`
- Modify: `test/plan-execution-backend.test.mjs`

- [ ] **Step 1: 固定 Root-session 内的可恢复 spawn identity**

领域事件中的 `dispatchId` 是唯一 `spawnKey`。Boundary 在 `tool_call` 授权后按 `toolCallId` 向 typed `subagent` 提供 `{spawnKey, requestId}`；模型输入和 upstream spawn params 都不能覆盖该值。Root broker 维护 Root-session 内的幂等 ledger：相同 `caller planId + spawnKey + paramsHash` 只能调用一次 upstream spawn，并通过 `spawn.lookup` 返回 `not-started | spawning | spawned | uncertain | cleaned` 与已知 binding。Plan Runner 子进程重启后必须 lookup，禁止盲目重放 spawn。

Ledger 不承诺跨 Root session crash 存活；Task 8 必须让 Root session 终止时停止全部 owned runs。`ping`、grant、输入校验和请求发送前失败属于 `not-started`，可以释放 authorization；请求发送后断线、超时或 upstream 结果不确定必须保留 reconcile fence。

- [ ] **Step 2: 写幂等 spawn、lookup、result binding、push 与 late cancel RED 测试**

```javascript
await boundary.onToolResult({
  toolCallId: "tool-1",
  isError: false,
  details: { runId: "executor-run-1", asyncDir: "/async/executor-run-1" },
});
assert.equal(latest.attempts.get("attempt-1").runId, "executor-run-1");
upstreamEvents.emit("subagent:async-complete", {
  runId: "executor-run-1", asyncDir: "/async/executor-run-1", state: "complete",
});
assert.deepEqual(childPushes.at(-1).type, "execution.completed");
```

RED 必须彼此独立覆盖：相同 spawnKey 并发/重试只 spawn 一次；响应丢失后 lookup 恢复同一 binding；真正 pre-spawn 失败可重试；started 早于 upstream reply 时不丢失；started/complete/process-terminal 只推给 owner；同 cwd 多 dispatch 依靠 dispatchId 精确映射；成功 tool result 绑定；重复同 binding 幂等；Plan 在 tool result 前 cancelled 时 stop 且不写 `attempt.bound`；不同 binding/CAS/持久化失败执行 cleanup；重建 boundary 后从 durable dispatch intent + lookup 恢复而不 spawn。

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/subagent-dispatch-extension.test.ts test/root-subagent-broker.test.mjs test/plan-executor-tool-boundary.test.mjs test/plan-capsule-extension.test.mjs test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs test/plan-execution-backend.test.mjs`

Expected: FAIL，broker 尚未把 lifecycle push 给 logical caller，tool result 未绑定 Attempt。

- [ ] **Step 4: 实现 broker 幂等 ledger 与 mapped lifecycle**

Broker 在调用 upstream 前登记 spawnKey 和 paramsHash；同 key 同参数等待或重放同一结果，不同参数 fail closed。`spawn.lookup` 只允许同 plan caller。Broker 监听 Root event bus 的 `subagent:async-started`、`subagent:async-complete` 和 `subagent:process-terminal`；started 可在 upstream reply 前暂存并按唯一 `agent + cwd` 的 in-flight ledger 绑定。根据 ledger owner 只推给对应 subscription；push data 保留 dispatchId/runId/asyncDir/cwd/session/state，不添加 runtime parent/depth/path。terminal 缺失字段从 ledger binding 补齐。

- [ ] **Step 5: Child adapter 镜像本地事实**

`root-owned-subagent.ts` 收到 push 后向 Plan Runner 本地 `pi.events` emit 同名 lifecycle，并发送有界 follow-up message。这样 `pi-subagents-execution-backend.mjs` 继续从本地 event stream 生成 official execution facts，但其 `rpc` 改为 broker client，不能访问 Plan Runner 本地上游 runtime。

- [ ] **Step 6: Tool result 执行 bind-or-cleanup**

Capsule 在 `tool_call` 授权时以 `event.toolCallId` 执行 `prepared -> executing`，并在现有 `pi.on("tool_result", ...)` handler 中对 `event.toolName === "subagent"` 调用 `boundary.onToolResult({toolCallId:event.toolCallId,isError:event.isError,details:event.details})`；必须复用同一个 handler，与 Supervisor reply 分支按 toolName 分流，避免注册顺序造成双消费。错误 result 按状态机区分“已知未 spawn”与“spawn 不确定”，session shutdown 对所有 `executing/spawned` entry 执行 reconcile/cleanup，禁止留下可 replay 的 token。

成功 result 校验 runId/asyncDir 和 one-shot authorization 后执行 `spawned -> bound`。正常路径由 tool result 提交 `attempt.bound`；lifecycle started 只生成带 dispatchId 的 official fact，供 tool result 丢失后的 lookup/recovery 使用。两条路径必须复用 Coordinator 的同一 bind-or-cleanup 原语：CAS conflict 时重放最新 projection；同一 binding 幂等成功；terminal 或不同 binding 通过 broker stop 本次 run并进入 `cleaned`；非冲突 persistence error 先 stop 再传播，stop 也失败时抛 `AggregateError`。

Plan Runner 在 `before_agent_start` 与 graceful shutdown 对 durable `dispatch-requested` 执行 lookup：`spawned` 使用同一 bind-or-cleanup；`not-started` 才允许释放本 session authorization并重新派发；`spawning/uncertain` 保持 fail closed fence；不得依赖 shutdown handler 覆盖 SIGKILL。

- [ ] **Step 7: 运行 GREEN 并提交**

```bash
node --test test/subagent-dispatch-extension.test.ts test/root-subagent-broker.test.mjs test/plan-executor-tool-boundary.test.mjs test/plan-capsule-extension.test.mjs test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs test/plan-execution-backend.test.mjs
git add scripts/lib/subagent-dispatch/extension.ts scripts/lib/subagent-dispatch/root-broker-protocol.ts scripts/lib/subagent-dispatch/root-broker-server.ts scripts/lib/subagent-dispatch/root-broker-client.ts pi/child-extensions/root-owned-subagent.ts pi/child-extensions/plan-runner.ts scripts/lib/plan/plan-executor-tool-boundary.mjs scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/coordinator.mjs scripts/lib/plan/plan-runner-dependencies.mjs scripts/lib/plan/pi-subagents-execution-backend.mjs test/subagent-dispatch-extension.test.ts test/root-subagent-broker.test.mjs test/plan-executor-tool-boundary.test.mjs test/plan-capsule-extension.test.mjs test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs test/plan-execution-backend.test.mjs
git commit -m "feat(plan): 绑定扁平 Executor runtime 事实"
```

Expected: PASS；runtime flat run 被确定性绑定到领域 Attempt。

---

### Task 7: 路由 Supervisor 与 Attention

**Deps:** Task 6

**Files:**
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-server.ts`
- Modify: `scripts/lib/subagent-dispatch/root-broker-client.ts`
- Modify: `pi/extensions/subagent-runtime.ts`
- Modify: `pi/child-extensions/root-owned-subagent.ts`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `test/root-subagent-broker.test.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`
- Modify: `test/plan-runner-dependencies.test.mjs`

- [ ] **Step 1: 写 Supervisor owner routing RED 测试**

两个 Plan Runner 各有两个并行 Executor，Root 收到乱序 request 后必须按 upstream `details.id/details.runId` 只推给 owner：

```javascript
rootMessages.emit(supervisorRequest({ runId: "executor-a-1", id: "request-a-1" }));
rootMessages.emit(supervisorRequest({ runId: "executor-b-2", id: "request-b-2" }));
rootMessages.emit(supervisorRequest({ runId: "executor-a-2", id: "request-a-2" }));
assert.deepEqual(planA.pushes.map((push) => [push.data.requestId, push.data.executorRunId]), [
  ["request-a-1", "executor-a-1"], ["request-a-2", "executor-a-2"],
]);
assert.deepEqual(planB.pushes.map((push) => push.data.requestId), ["request-b-2"]);
await planA.client.supervisorReply({ replyTo: "request-a-2", message: "approved" });
assert.deepEqual(rootSupervisorReplies, [{ replyTo: "request-a-2", message: "approved" }]);
await assert.rejects(planB.client.supervisorReply({ replyTo: "request-a-1", message: "forged" }), /not owned/i);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/root-subagent-broker.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs`

Expected: FAIL，Root supervisor adapter 尚未暴露给 broker。

- [ ] **Step 3: 暴露受限 Root supervisor target**

`installHeadlessTypedSubagentRuntime` 返回的 handle 增加内部 `executeSupervisor(params, ctx)`；`pi/extensions/subagent-runtime.ts` 只把该函数绑定给当前 Root broker。Broker 从 upstream Root message `details.id/details.runId` 规范化为 `(requestId, executorRunId, callerRunId)` 三元组并持久到当前 Root 内存；只允许 owner pending/reply，reply 精确传入 `{action:"reply",replyTo:requestId,message}`，不向 child 暴露 Root 全局 request 列表。

- [ ] **Step 4: Child adapter 注册 remote supervisor tool**

`plan_executor_supervisor pending/reply/status` 通过 broker；Plan Runner 现有 authorize/resolve Attention fencing 保持不变，upstream 原生 `subagent_supervisor` 始终不在 active tools。收到 `supervisor.request` push 时 child extension 用 `pi.sendMessage(customType:"subagent_supervisor_request")` 注入本地 session，Capsule 继续通过 Event Writer 持久化 Attention。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/root-subagent-broker.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git add scripts/lib/subagent-dispatch/extension.ts scripts/lib/subagent-dispatch/root-broker-server.ts scripts/lib/subagent-dispatch/root-broker-client.ts pi/extensions/subagent-runtime.ts pi/child-extensions/root-owned-subagent.ts scripts/lib/plan/plan-capsule-extension.mjs scripts/lib/plan/plan-runner-dependencies.mjs test/root-subagent-broker.test.mjs test/plan-capsule-extension.test.mjs test/plan-runner-dependencies.test.mjs
git commit -m "feat(plan): 路由扁平 Executor Supervisor"
```

Expected: PASS；Supervisor routing 由 adapter ownership 完成，项目 `plan_executor_supervisor` 不与 upstream 原生 tool 冲突，runtime 仍不知道领域 parent。

---

### Task 8: 让所有 Plan Runs 跟随 Root Session 终止

**Deps:** Task 4, Task 6, Task 7

**Files:**
- Modify: `scripts/lib/subagent-dispatch/root-broker-server.ts`
- Create: `scripts/lib/subagent-dispatch/process-birth-identity.ts`
- Modify: `pi/extensions/subagent-runtime.ts`
- Modify: `pi/child-extensions/root-session-owner.ts`
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `test/root-subagent-broker.test.mjs`
- Create: `test/process-birth-identity.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`
- Create: `test/fixtures/root-session-owner-child.ts`

- [ ] **Step 1: 写 graceful shutdown 顺序 RED 测试**

```javascript
await broker.closeRootSession();
assert.deepEqual(stopOrder, ["executor-run-1", "executor-run-2", "plan-runner-run-1"]);
assert.ok(terminalAt.get("executor-run-1") < stopRequestedAt.get("plan-runner-run-1"));
assert.ok(terminalAt.get("executor-run-2") < stopRequestedAt.get("plan-runner-run-1"));
assert.ok(terminalAt.get("plan-runner-run-1") < socketClosedAt);
assert.equal(pushes.at(-1).type, "root.closing");
assert.equal(socketClosed, true);
assert.throws(() => requireRootBroker(pi), /unavailable/);
```

重复 shutdown 必须幂等。测试覆盖正常 terminal、stop 超时后 verified process-group SIGKILL、一个 run 失败但其余仍 drain；模拟 stale status PID 已被复用或 `ps` 出生身份错配时必须断言没有 signal 且 upstream RPC 未 dispose。AggregateError 只能在所有 run 已 terminal 或形成明确 cleanup debt 后返回。`test/pi-subagents-compat.test.mjs` 固定 pinned source 包含并发出 `subagent:process-terminal`，防止静默依赖不存在的 event。

- [ ] **Step 2: 写 abnormal Root exit RED Harness**

启动一个持有 broker socket 的 fixture Root 进程，再启动两个加载 `root-session-owner.ts` 的 child。强制 `SIGKILL` Root，断言两个 child 在 deadline 内收到 EOF 并退出；不得依赖 heartbeat age 或跨 session recovery。

Run: `node --test test/root-subagent-broker.test.mjs --test-name-pattern='Root session'`

Expected: FAIL，当前 broker 没有 ordered drain/ownership EOF 保证。

- [ ] **Step 3: 实现 ordered drain 与 fail-closed socket ownership**

`closeRootSession()` 设置 `closing=true`，拒绝新 spawn 并 push `root.closing`。Broker 在每个 `subagent:async-started` 到达时先规范化 `runId := event.runId ?? event.id`（pinned upstream 实际使用 `id`），再记录 `{rootSessionId,runId,asyncDir,pid,birthIdentity}`；`birthIdentity` 由新 helper 执行 `ps -ww -p <pid> -o lstart= -o command=` 后 SHA-256，禁止从 caller 提供。

对每个 Executor：发送 upstream stop，等待匹配 `runId/sessionId/asyncDir` 的 Root `subagent:process-terminal` event，或同一 official `process-terminal.json/status.processTerminal` terminal artifact（固定 deadline）；只有所有 Executor terminal 后才 stop Plan Runner，并等待其 terminal proof。若 deadline 到期，先重新捕获 birthIdentity；只有与 spawn 时值精确一致才允许向 detached process group `-pid` 发送 SIGKILL，随后再次等待 official terminal artifact、ownership subscription EOF，并验证该 birth identity 不再存活。birth identity 缺失/错配时禁止 signal，形成 cleanup debt 并阻断 upstream dispose，不得声称仅靠 PID/status 可防复用。全部 run terminal 后才 destroy subscriptions、close/unlink socket、删除本 Root grant 文件、unbind registry 和 dispose upstream RPC。

一个 run 的 stop/force 失败不得跳过其余 run；使用 `Promise.allSettled` 收集 cleanup debt。无法证明某 run 已终止时 `beforeDispose` 必须返回 AggregateError 且保持 transport/registry 可诊断，测试不得把 `state:"stopping"` 当完成。Child owner 对 explicit push 或 abnormal EOF 只触发一次 SIGTERM。

- [ ] **Step 4: Root B 明确拒绝旧 handle**

Launcher management API 比较 handle.rootSessionId 与当前 session；不同则返回 terminal diagnostic，不 attach、不调用 status/stop。旧 `pi-plan-handle.v3` 返回 `Standalone Host handles are unsupported after flat runtime migration`。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
node --test test/root-subagent-broker.test.mjs test/process-birth-identity.test.mjs test/pi-subagents-compat.test.mjs test/plan-launcher-extension.test.mjs
git add scripts/lib/subagent-dispatch/root-broker-server.ts scripts/lib/subagent-dispatch/process-birth-identity.ts pi/extensions/subagent-runtime.ts pi/child-extensions/root-session-owner.ts scripts/lib/plan/plan-launcher-extension.mjs test/root-subagent-broker.test.mjs test/process-birth-identity.test.mjs test/pi-subagents-compat.test.mjs test/plan-launcher-extension.test.mjs test/fixtures/root-session-owner-child.ts
git commit -m "fix(plan): 让运行实例跟随 Root session 终止"
```

Expected: PASS；Root 正常关闭或进程死亡后均无 Plan Runner/Executor orphan。

---

### Task 9: 删除 Standalone Host 与旧恢复面

**Deps:** Task 8

**Files:**
- Delete: `scripts/lib/plan/plan-host-runtime.mjs`
- Delete: `test/plan-host-runtime.test.mjs`
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `scripts/lib/plan/tui/plan-widget.mjs`
- Modify: `scripts/lib/plan/plan-runtime-tools.mjs`
- Modify: `scripts/probes/pi-subagents-compat.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`
- Modify: `test/plan-runtime-migration.test.mjs`
- Modify: `test/plan-runtime-tool-policy.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `docs/pi-plan-execution-capsule.md`
- Modify: `docs/audits/2026-07-29-plan-runner-architecture-audit.md`
- Create: `docs/architecture/plan-runner-flat-runtime.md`

- [ ] **Step 1: 写 no-Host 静态与 doctor RED 测试**

```javascript
assert.equal(sourceFiles.some((file) => file.endsWith("plan-host-runtime.mjs")), false);
assert.doesNotMatch(launcherSource, /spawnPlanRunner|processIdentity|host-handle\.json|pi-plan-host-keeper/);
assert.doesNotMatch(widgetSource, /host-handle\.json|hostRunId|Host:/);
assert.doesNotMatch(runtimeToolsSource, /Standalone Plan Runner/);
assert.doesNotMatch(compatProbeSource, /standaloneRootService|standaloneNoChildEnv|buildStandaloneRuntimeEnv/);
assert.doesNotMatch(migrationSource, /thin Host|plan-host-runtime/);
assert.match(doctorOutput, /Root subagent broker: ready/);
assert.doesNotMatch(doctorOutput, /Standalone Host|detached Host/);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/doctor.test.mjs test/plan-launcher-extension.test.mjs test/plan-runtime-migration.test.mjs test/plan-runtime-tool-policy.test.mjs test/pi-subagents-compat.test.mjs`

Expected: FAIL，Host 模块和 doctor 检查仍存在。

- [ ] **Step 3: 删除 Host runtime 与 persistence**

删除 keeper、PID/process identity fencing、Host status path、Attention poller 和 `plan-recover` attach。保留 `plan-status/cancel/attention-reply` 的当前 Root session 实现，它们只使用 v4 branch handle + Root broker。

同时迁移所有当前消费者：Widget 只展示 `status.json` Plan projection 与 broker-owned Executor facts，不读 Host handle；runtime tools 错误文案改为 Plan Session；compat probe 验证 `rootBrokerReady/flatRuntimeDepth/childAdapterRegistered/noFanoutExtension`；runtime migration 测试改为断言 Root broker 是唯一 Plan process-control adapter；现行 `docs/pi-plan-execution-capsule.md` 改为 flat runtime，历史计划和 bug 文档不重写。

运行：

```bash
rg -n "plan-host-runtime|pi-plan-host-keeper|processIdentity|host-handle.json|hostRunId|Standalone Plan Runner Host|standaloneRootService|standaloneNoChildEnv" scripts pi test docs/pi-plan-execution-capsule.md
```

Expected: 无生产命中；只允许 migration 文档/历史 bug 文档命中。

- [ ] **Step 4: 判断 parent-lifecycle 通用模块是否可删**

Run: `rg -n "createParentLease|startParentLeaseWatchdog|parent-lifecycle" scripts pi test --glob '!test/parent-lifecycle.test.mjs'`

Expected: 若无调用方，删除 `scripts/lib/plan/parent-lifecycle.mjs` 与 `test/parent-lifecycle.test.mjs`；若仍有非 Host 调用方，保留并在提交说明列出调用者。禁止仅因文件名相似而删除。

- [ ] **Step 5: 更新架构文档**

`docs/architecture/plan-runner-flat-runtime.md` 必须包含：

```text
领域拓扑: Main -> Plan Runner -> Executor
runtime 拓扑: Root -> [Plan Runner, Executor]
生命周期: Root session 单一 owner，其他 Root 不恢复
dispatch: tool -> child adapter -> Root broker -> local pi-subagents RPC
授权: dispatch event + one-shot contract hash
Supervisor: broker ownership routing
淘汰: Standalone Host、re-root、fanout-child、跨 Root attach
```

审计报告追加“Superseding Decision”，不得改写原审计时间点事实。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
node --test test/doctor.test.mjs test/plan-launcher-extension.test.mjs test/plan-runtime-migration.test.mjs test/plan-runtime-tool-policy.test.mjs test/pi-subagents-compat.test.mjs
git diff --check
git add -A -- scripts/lib/plan/plan-host-runtime.mjs test/plan-host-runtime.test.mjs scripts/lib/plan/plan-launcher-extension.mjs scripts/lib/plan/tui/plan-widget.mjs scripts/lib/plan/plan-runtime-tools.mjs scripts/probes/pi-subagents-compat.mjs scripts/doctor.mjs test/doctor.test.mjs test/plan-launcher-extension.test.mjs test/plan-runtime-migration.test.mjs test/plan-runtime-tool-policy.test.mjs test/pi-subagents-compat.test.mjs docs/pi-plan-execution-capsule.md docs/audits/2026-07-29-plan-runner-architecture-audit.md docs/architecture/plan-runner-flat-runtime.md scripts/lib/plan/parent-lifecycle.mjs test/parent-lifecycle.test.mjs
git commit -m "refactor(plan): 删除 Standalone Host runtime"
```

Expected: PASS；不存在独立 Host 进程层。

---

### Task 10: 真实 Harness 与累计回归

**Deps:** Task 9

**Files:**
- Create: `test/plan-flat-runtime-harness.integration.mjs`
- Modify: `test/fixtures/plan-harness/plan-runner-extension.ts`
- Modify: `test/fixtures/plan-harness/executor-extension.ts`
- Modify: `test/fixtures/deterministic-provider-state.mjs`
- Modify: `test/deterministic-provider.test.mjs`
- Modify: `test/plan-parallel-harness.integration.mjs`
- Delete: `scripts/lib/subagents-rpc-client.mjs`
- Delete: `test/subagents-rpc-client.test.mjs`
- Modify: `test/subagent-runtime-resource-isolation.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写真实拓扑 Harness**

Harness 使用真实 `pi` 和真实项目 adapters，断言：

```javascript
for (const child of [observed.planRunner, observed.executor]) {
  assert.equal(child.status.sessionId, observed.root.sessionId);
  assert.equal(child.env.PI_SUBAGENT_FANOUT_CHILD, "0");
  assert.equal(child.env.PI_SUBAGENT_PARENT_DEPTH || undefined, undefined);
  assert.equal(child.env.PI_SUBAGENT_PARENT_RUN_ID || undefined, undefined);
  assert.equal(child.env.PI_SUBAGENT_PARENT_PATH || undefined, undefined);
  assert.equal(child.argv.some((arg) => arg.endsWith("fanout-child.ts")), false);
}
assert.equal(observed.executor.parentRunIdForwardedToUpstream, undefined);
assert.equal(observed.plan.lifecycle, "validated");
assert.equal(observed.executor.attemptId, "attempt-plan-1-task-1-1");
```

再用两个 Plan Runner、每个两个并行 Executor 覆盖乱序 Supervisor request -> owner Plan Runner Attention -> Root reply -> broker supervisor reply，断言 `(upstream id, executor runId, caller runId)` 不跨 owner。`test/fixtures/deterministic-provider-state.mjs` 同步把 Plan Runner 的 pending/reply tool 从 `subagent_supervisor` 改为 `plan_executor_supervisor`，删除本地 `subagent_wait` 控制分支，改由 broker completion/attention follow-up 驱动；`test/deterministic-provider.test.mjs` 先写对应 RED。

- [ ] **Step 2: 写 Root shutdown Harness**

在 Executor active 时关闭 Root session，断言：

```javascript
assert.deepEqual(terminalStates, {
  root: "closed",
  planRunner: "terminated",
  executor: "terminated",
});
assert.ok(terminalProofAt.executor < stopRequestedAt.planRunner);
assert.ok(terminalProofAt.planRunner < brokerClosedAt);
assert.equal(await processAlive(planRunnerPid), false);
assert.equal(await processAlive(executorPid), false);
assert.equal(await pathExists(brokerSocket), false);
```

启动 Root B 后调用旧 handle，断言拒绝且没有 spawn/attach。

- [ ] **Step 3: 迁移最后一个 fixture、删除旧 client 并运行新 Harness 到 GREEN**

先把 `test/fixtures/plan-harness/plan-runner-extension.ts`（由 `test/plan-parallel-harness.integration.mjs` 使用）迁移到 Root broker adapter；`rg -n "subagents-rpc-client\.mjs" scripts pi test` 证明只剩待删除 client 自测/resource-isolation 旧断言后，删除 `scripts/lib/subagents-rpc-client.mjs`、`test/subagents-rpc-client.test.mjs`，更新 resource-isolation 门禁。`scripts/probes/pi-subagents-compat.mjs` 内自包含的 generic upstream compatibility client、它的 `test/pi-subagents-compat.test.mjs` 单测与 `test/pi-subagents-runtime.integration.mjs` 保留，因为它们验证公开 RPC，不是 Plan runtime 消费者；用 `rg -n "createSubagentsRpcClient" scripts pi test` 断言命中精确限定在这三个 probe 文件。不得在 Task 9 提前删除，避免阶段性 Harness 断裂。

```bash
PI_REAL_BIN="$(command -v pi)" node --test test/plan-flat-runtime-harness.integration.mjs
```

Expected: PASS，包含 happy path、Supervisor roundtrip、graceful shutdown、abnormal Root exit 四组场景；旧 client 无生产或 fixture 调用方。

- [ ] **Step 4: 运行聚焦和全量门禁**

```bash
node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/process-birth-identity.test.mjs test/plan-executor-tool-boundary.test.mjs test/plan-launcher-extension.test.mjs test/plan-capsule-extension.test.mjs test/plan-coordinator.test.mjs test/plan-runner-dependencies.test.mjs test/plan-execution-backend.test.mjs test/pi-subagents-compat.test.mjs test/plan-runtime-migration.test.mjs test/plan-runtime-tool-policy.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/deterministic-provider.test.mjs test/doctor.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/plan-parallel-harness.integration.mjs test/plan-flat-runtime-harness.integration.mjs
rg -n "subagents-rpc-client\.mjs" scripts pi test
rg -n "createSubagentsRpcClient" scripts pi test
npm test
npm run doctor
git diff --check
```

Expected: 全部 PASS；doctor 不再报告 Host recovery warning。

- [ ] **Step 5: 做累计 diff review**

先使用本地 `plan-reviewer` 审查全部累计 diff，修复高置信度 blocker；随后按 `external-llm-review` skill 使用有限外源轮次审查最终 diff。必须重点检查：broker caller 越权、runId ownership 混淆、Root shutdown 顺序、Supervisor 跨 Plan 泄漏、tool contract replay、socket 文件权限和 orphan process。

- [ ] **Step 6: 提交 Harness**

```bash
git add -A -- test/plan-flat-runtime-harness.integration.mjs test/fixtures/plan-harness/plan-runner-extension.ts test/fixtures/plan-harness/executor-extension.ts test/fixtures/deterministic-provider-state.mjs test/deterministic-provider.test.mjs test/plan-parallel-harness.integration.mjs scripts/lib/subagents-rpc-client.mjs test/subagents-rpc-client.test.mjs test/subagent-runtime-resource-isolation.test.mjs package.json
git commit -m "test(plan): 验证扁平 Root runtime 链路"
```

Expected: 最终工作树只保留用户原有无关改动；`pi/settings.json` 不进入任何提交。

---

## 最终验收矩阵

1. `pi-subagents` upstream 收到的 Plan Runner 与 Executor spawn 均无 caller parent/depth 字段。
2. 真实 child 都属于 Root `sessionId`，`PI_SUBAGENT_FANOUT_CHILD=0`，`PI_SUBAGENT_PARENT_DEPTH/RUN_ID/PATH` 为空，argv 不含 `fanout-child.ts`。
3. Plan Runner 只能执行 Event Writer 已提交、hash 完全匹配的一次性 Executor contract。
4. Executor status/stop/interrupt 只能由所属 Plan Runner broker grant 操作。
5. Supervisor request/reply 不跨 Plan Runner 泄漏。
6. Root session graceful shutdown 先取得所有 Executor terminal proof、再取得 Plan Runner terminal proof、最后关闭 broker/dispose upstream。
7. Root 进程异常退出后 ownership socket EOF 会终止两个 child，无 orphan。
8. Root B 明确拒绝 Root A 的 v4 handle，不 attach、不 resume。
9. 仓库无 `plan-host-runtime.mjs`、keeper、process identity、persisted Host handle 或已无调用方的旧 Plan RPC module；generic upstream compatibility probe 的自包含 client 明确保留。
10. 全量测试、真实 Harness、doctor、外部 review 和 `git diff --check` 全部通过。
