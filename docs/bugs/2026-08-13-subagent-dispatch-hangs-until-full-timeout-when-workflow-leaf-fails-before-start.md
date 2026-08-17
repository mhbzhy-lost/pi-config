# 2026-08-13 subagent 派发在 workflow leaf 启动前失败时卡满整个 timeout

## 一句话描述

`subagent` 工具派发后，如果 workflow root 已失败（如 "Unknown agent: reviewer"）而 leaf 从未产出 `subagent:async-started` 事件，工具调用会一直卡到 `timeoutMs`（900s=15min）才以 `WORKFLOW_CHILD_START_TIMEOUT` 失败，且真实错误被吞掉。

## 复现流程

1. 在任意项目派发一个**未注册的 agent**（如 `reviewer`/`researcher`，generic 或 coding 均可，timeoutMs 越大卡越久）：
   `subagent({ agent: "reviewer", title: "...", task: "...", timeoutMs: 900000 })`
2. 观察：workflow root 的 `status.json` 在 ~6ms 内即 `state: failed, error: "Unknown agent: reviewer"`（见
   `/var/folders/.../pi-subagents-uid-501/async-subagent-runs/f033c6ea-*/status.json`），但 `runs.run()` 从未 spawn leaf，因此没有 `subagent:async-started`。
3. `createWorkflowChildStartCollector`（`scripts/lib/subagent-dispatch/workflow-spawn.ts`）只监听
   `subagent:async-started`，对 root 失败无感知 → `waitFor` 挂到 `timeoutMs` 才 reject。
4. 实测案例（session `2026-08-12T03-51-03-346Z_019ff418`）：
   - `call_00_...`（reviewer，03:17:19Z）→ root `f033c6ea` 6ms 失败，工具调用卡满 900s；
   - `call_01_...`（researcher，03:17:19Z）→ root `723e16bb` 163ms 失败，工具调用卡满 900s；
   - 历史同类：08-12 03:51 session 另有 900s/300s 两例；08-12 04:13 session 120s 一例。

## 修复方案

1. `workflow-spawn.ts` 的 collector 增加对 root 终态的感知：
   - 同时订阅 `subagent:async-complete`；当 `event.runId`（或 `event.id`）等于 `waitFor(root)` 的 root runId
     且尚未绑定 leaf 时，立即 fail-fast，错误码 `WORKFLOW_CHILD_START_FAILED`，消息带上 root 的
     `state`/`error`（如 `workflow root ... failed before child start: Unknown agent: reviewer`）。
   - complete 事件在 `waitFor` 之前到达时同样 buffered（复用 started 事件的 buffered 模式）。
   - leaf 已绑定后到达的 complete 事件忽略。
2. `extension.ts` 限制 child-start 等待上限：`waitFor` 的 timeout 用
   `workflowChildStartTimeoutMs ?? min(执行 timeout, 120_000)`，leaf 的**启动**事件不该等整个执行预算；
   workflow spawn 参数里的 `timeoutMs` 保持原值不变（那才是 leaf 的执行预算）。
3. 测试（`test/subagent-workflow-spawn.test.mjs`，先 RED）：
   - root failed complete 事件 → fail-fast 且消息包含 root error；
   - complete 先于 `waitFor` 到达 → 同样 fail-fast；
   - 其他 runId 的 complete → 忽略；
   - leaf 已绑定后的 complete → 忽略；
   - root 成功完成但无 leaf → fail-fast；
   - 全部 fail-fast 路径都释放事件订阅（listenerCount 归零）。
