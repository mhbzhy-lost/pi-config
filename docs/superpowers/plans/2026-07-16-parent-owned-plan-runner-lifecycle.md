# Parent-Owned Plan Runner Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan Runner 仍可在 Parent 存活期间后台运行，但 Parent Session 正常销毁或 Parent 进程异常崩溃后，所有由它启动的 Plan Runner 必须终止，不得成为孤儿进程。

**Architecture:** Parent Launcher 为每个 Plan Runner 建立带随机 token 的 heartbeat lease，并持续原子刷新；Plan worktree runtime wrapper 同时加载 child runner 与 watchdog。正常 `session_shutdown` 由 Parent 主动 stop 所有 active run，异常崩溃则由 child watchdog 在 lease 超时后终止自身。路径/worktree 隔离保持不变；durable 七字段 handle 只用于观察终态，不再用于让新 Parent 接管仍运行的旧 child。

**Tech Stack:** Pi `0.80.6` Extension API、`pi-subagents@0.34.0` stable RPC v1、Node.js ESM、Git worktree、Node 内置 test runner。

---

## 文件职责

| 文件 | 职责 |
|---|---|
| `scripts/lib/plan/parent-lifecycle.mjs` | Parent heartbeat lease、token 校验、child watchdog 与终止回调 |
| `scripts/lib/plan/plan-launcher-extension.mjs` | active run 登记、heartbeat 启停、正常 shutdown stop、wrapper 注入 |
| `test/parent-lifecycle.test.mjs` | lease 与 watchdog 的确定性单元测试 |
| `test/plan-launcher-extension.test.mjs` | Launcher 生命周期顺序、失败回滚、多 Plan shutdown 测试 |
| `test/plan-capsule.integration.mjs` | Parent 存活后台执行、正常退出、异常崩溃真实 E2E |
| `docs/pi-plan-execution-capsule.md` | Parent-owned 生命周期与恢复语义 |
| `scripts/doctor.mjs` | 检查 lifecycle helper 与 child wrapper 能力 |
| `test/doctor.test.mjs` | doctor 合同 |

### Task 1：实现 Parent heartbeat lease 与 child watchdog

**Files:**
- Create: `scripts/lib/plan/parent-lifecycle.mjs`
- Create: `test/parent-lifecycle.test.mjs`

- [ ] **Step 1：写 lease 原子刷新 RED**

测试创建临时 `var/plan-runs/<planId>/control/parent-lease.json`，断言内容严格为：

```javascript
{
  schemaVersion: "pi-plan-parent-lease.v1",
  planId,
  token,
  parentPid,
  updatedAt
}
```

覆盖非法 `planId`、空 token、路径逃逸、原子临时文件残留。

Run: `node --test test/parent-lifecycle.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现最小 lease writer**

导出：

```javascript
export function createParentLease({ stateRoot, planId, token, parentPid, now, intervalMs })
```

返回 `{ path, beat(), start(), stop(), remove() }`；`beat()` 使用临时文件 + rename，文件 mode `0600`；timer 必须 `unref()`。

- [ ] **Step 3：写 watchdog RED**

使用注入的 `readFile/now/setInterval/onExpired`，覆盖：新鲜 lease 不终止、token/planId 不匹配 fail-closed、lease 缺失在启动宽限期后终止、stale 后只调用一次 `onExpired`、stop 后不再检查。

- [ ] **Step 4：实现 watchdog**

导出：

```javascript
export function startParentLeaseWatchdog({
  leasePath,
  planId,
  token,
  timeoutMs,
  checkIntervalMs,
  onExpired,
})
```

默认 `onExpired` 先写 `parent-lost.json`，再向当前 child Pi 进程发送 `SIGTERM`；不得扫描或终止无关 PID。

- [ ] **Step 5：运行 GREEN**

Run: `node --test test/parent-lifecycle.test.mjs`

Expected: PASS。

### Task 2：将 lease 注入 Plan runtime wrapper

**Deps:** Task 1

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`

- [ ] **Step 1：写 wrapper/lease 顺序 RED**

断言 `/plan-run` 的顺序为：创建 worktree → 首次 heartbeat 落盘 → 生成 wrapper → RPC spawn。wrapper 必须包含 child runner 与 watchdog helper 的可信绝对 file URL，以及 JSON 编码的 `leasePath/planId/token/timeoutMs`。

Run: `node --test --test-name-pattern="parent lease|runtime wrapper" test/plan-launcher-extension.test.mjs`

Expected: FAIL，wrapper 不含 watchdog。

- [ ] **Step 2：实现 wrapper 注入**

`writePlanRunnerRuntimeWrapper` 生成：

```javascript
import planRunner from "file:///trusted/pi/child-extensions/plan-runner.ts";
import { startParentLeaseWatchdog } from "file:///trusted/scripts/lib/plan/parent-lifecycle.mjs";
export default function (pi) {
  startParentLeaseWatchdog({ leasePath, planId, token, timeoutMs });
  planRunner(pi);
}
```

token 使用 `crypto.randomUUID()`；不得写入 Parent handle 或 Plan domain events。

- [ ] **Step 3：写启动失败清理 RED**

RPC spawn、session artifact 等待或 handle 持久化失败时，断言 heartbeat timer 已 stop、lease 与 wrapper 已删除，然后才 rollback workspace。

- [ ] **Step 4：实现失败清理并运行 GREEN**

Run: `node --test test/plan-launcher-extension.test.mjs`

Expected: PASS。

### Task 3：正常 Parent shutdown 主动停止所有 active run

**Deps:** Task 2

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Modify: `test/plan-launcher-extension.test.mjs`

- [ ] **Step 1：写多 Plan shutdown RED**

模拟同一 Parent 启动两个 Plan；触发 `session_shutdown`，断言每个 active run 恰好调用一次 `rpc.stop({runId})`，等待 terminal artifact，随后停止 heartbeat。已终态 run 不重复 stop；单个 stop 失败不得阻止其他 run 清理，最终汇总错误。

- [ ] **Step 2：实现 active run registry**

registry 仅保存在 Parent Extension 进程内，值为 `{handle, lease}`。成功 append handle 后登记；cancel/自然终态后移除。`session_shutdown` handler 复制 registry 后并行 stop，并对每个 run 条件等待终态。

- [ ] **Step 3：禁止新 Parent 接管 active old run**

`/plan-recover` 从 durable sidecar 找到 run 时只允许读取 status；若 artifact 仍是 running 但不在当前 registry，返回 `orphaned-owner`/blocked 观察结果，不启动 heartbeat、不 spawn、不宣称接管。

- [ ] **Step 4：运行 GREEN**

Run: `node --test test/plan-launcher-extension.test.mjs`

Expected: PASS。

### Task 4：真实验证 Parent 存活期间后台执行

**Deps:** Task 3

**Files:**
- Modify: `test/plan-capsule.integration.mjs`

- [ ] **Step 1：改造 RPC harness RED**

增加可控 Parent harness：收到 handle 后保持 stdin/Parent 进程存活，通过条件等待 Plan `validated` 后才关闭。断言 Plan Runner 在 Parent 存活期间保持后台运行，Parent 同时可处理无关 prompt 和双 Plan 并发。

- [ ] **Step 2：更新现有 happy/unrelated/concurrent E2E**

所有成功场景不再在 handle 出现时立即销毁 Parent；结束后仍调用 `terminateDetachedRun` 作为测试兜底，并断言兜底前 runner 已自然终态。

- [ ] **Step 3：运行 GREEN**

Run: `PI_REAL_BIN="$(command -v pi)" node --test --test-name-pattern="real Parent Launcher|unrelated|concurrently" test/plan-capsule.integration.mjs`

Expected: PASS，无残留 Pi。

### Task 5：真实验证正常退出与异常崩溃都终止 child

**Deps:** Task 4

**Files:**
- Modify: `test/plan-capsule.integration.mjs`
- Modify: `test/support/plan-e2e-process-cleanup.mjs`

- [ ] **Step 1：写正常 shutdown RED**

用 file latch 保持 Plan child running，正常关闭 Parent RPC stdin。断言 `session_shutdown` 先 stop 原 run，runner artifact 进入终态，heartbeat 停止，child/runner PID 全部退出。

- [ ] **Step 2：写 crash RED**

启动相同 latch 场景，获得 handle 与 runner PID 后对 Parent Pi 发送 `SIGKILL`。不调用测试 cleanup，等待超过 lease timeout，断言 child watchdog 写 `parent-lost.json`、runner/child PID 退出、无引用本次临时 package/origin 的进程。

- [ ] **Step 3：调整 restart 语义**

替换旧“Parent restart 后原 child 继续 validated”断言：新 Parent 只能通过 sidecar 观察旧 run 已终止；不得出现第二个 spawn/handle，也不得接管 heartbeat。

- [ ] **Step 4：运行 GREEN**

Run: `PI_REAL_BIN="$(command -v pi)" npm run test:plan`

Expected: 全部 PASS，无孤儿进程。

### Task 6：更新 doctor 与文档

**Deps:** Task 5

**Files:**
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `docs/pi-plan-execution-capsule.md`
- Modify: `README.md`

- [ ] **Step 1：写 doctor RED**

健康 fixture 必须包含 `scripts/lib/plan/parent-lifecycle.mjs`；缺失时报告 `missing Parent-owned Plan lifecycle helper`。doctor 文案不再描述 Parent restart continuation。

- [ ] **Step 2：实现 doctor 检查**

保持 pause/resume、compaction 为上层非目标；新增 Parent-owned lifecycle 能力检查，不把 heartbeat runtime 文件加入 Git。

- [ ] **Step 3：更新中文文档**

明确：后台不等于跨 Parent 存活；正常退出主动 stop，异常崩溃 lease 超时自停；sidecar 只用于终态观察；Parent 重启不接管旧 running child。

- [ ] **Step 4：运行 GREEN**

Run: `node --test test/doctor.test.mjs test/migration-contract.test.mjs && npm run doctor`

Expected: PASS，仅保留上层非目标提示。

### Task 7：最终验收

**Deps:** Task 6

**Files:**
- Verify only

- [ ] **Step 1：运行完整矩阵**

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
  python -m unittest discover -s skill-overrides/external-llm-review/tests
```

Expected: 全部 PASS。

- [ ] **Step 2：检查进程与现场**

确认没有引用 `pi-plan-capsule-*` 临时目录的 runner/Pi，没有 Parent crash E2E 遗留进程；记录未 commit 的工作区状态，不自动 commit/push。
