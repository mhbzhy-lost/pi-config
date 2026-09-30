# Bug：custom-footer subagent 条目卡死运行态、model/token 缺失、幽灵条目

- 发现日期：2026-09-29
- 发现方式：真实生产动态验证（用户在 TUI 亲历，同日 3 个真实 async run 完成后）
- 严重级别：P1（TUI 状态投影错误；不影响 runtime 本体，但误导用户对 subagent 状态的判断）
- 分类：类别 1（预期 production 数据未被正确处理）——真实 run、真实事件、真实 footer 订阅，全部生产可达
- 关联：docs/bugs/2026-09-29-async-completion-notification-silent-swallow.md（同一现场发现，但 footer 缺陷独立于通知缺陷——completion 事件已实证到达真实事件总线）

## 现象（用户 TUI 实录，17:0x 时点）

```
● typed-3c9b4293-198b-407f-a877-e6a573a3b4a3         (qoder-pool) GLM-5.3-0.6x
  (delegate)                                                    thinking: high
● typed-9b59f979-9ad9-41b1-b4ea-113cef85805b
  (delegate)
● typed-f7156ce0-6f09-4c40-9d47-8197e76b98ec
  (delegate)
● typed-814773ba-76b1-4603-baa6-6b4419630021
  (delegate)
◯ history 4
```

1. 4 个条目全部显示 ●（运行中），而 runtime 真实状态为 complete（subagent status 三查全部 `State: complete, Process terminal: observed`）；
2. 仅 typed-3c9b4293（51e8db30 引用审计）显示 model（GLM-5.3-0.6x）与 thinking，其余 3 条无 model 信息；用户报告详情页同样看不到 model 名与 token 统计；
3. `history 4` 表明 completion 历史计数已记录 4 条——**completion 事件到达了 footer**（`custom-footer.ts:442` 订阅 `subagent:async-complete`，且 membrane events 代理的 `emit` 为透传实现，runtime-membrane.ts:160-162），但运行中条目未被清除/迁移；
4. typed-f7156ce0 是一次**派发失败**（authority_store_unavailable）留下的幽灵条目：无对应 run 目录（async-subagent-runs/ 下无 f7156ce0 run dir），但存在 workflow 容器 `7fba8a95-06c8-4960-b1fd-583cb93cbaf6/workflow-receipt.json` 引用它；失败派发未从 footer 数据源中清除。

## 已确认事实（区别于待诊断项）

- completion 事件到达真实事件总线：result-watcher 完整走完投递链（result 文件删除、completion-replay 写入、emit 透传），footer history=4 与之互证；
- footer 运行条目数据源与 completion 迁移路径存在缺陷：`browser.trackCompleted(event)` 后 `reconcile(owner, epoch)` 未能把 ● 条目转为完成态（guard `if (owner !== ctx || epoch !== sessionEpoch) return` 或 reconcile 内部状态机问题——待诊断定位）；
- model/token 信息缺失：条目 model 信息来源及为何仅 1/4 有值——待诊断定位（async-started 事件 payload？spawn 路径差异？coding vs generic 差异？）；
- 幽灵条目：失败派发在 authority_store_unavailable 前已注册 workflow/条目，失败路径未回滚该注册——待诊断定位注册与回滚的缺口。

## 待诊断项（由只读诊断任务完成）

1. footer 条目的创建/迁移/清除状态机：entry 从哪个事件/数据源创建（async-started？spawn 结果？workflow registry？），completion 后由哪条路径清除，为何本次未清除；
2. model 信息的数据链路：为何 typed-3c9b4293 有值而其余无；
3. token 统计的数据链路：详情页 token 统计来源（completion 事件 payload 的 usage？status 快照？）及缺失原因；
4. 幽灵条目的注册时序：authority_store_unavailable 失败发生在 workflow 注册之后还是之前，失败路径是否应有回滚，footer 从哪里读到它。

## 处置方向（诊断后定案）

- 修复 footer 状态机（completion 后正确迁移/清除运行条目）；
- 修复 model/token 投影数据链路；
- 修复失败派发的条目注册回滚（或 footer 对无 run 目录条目的过滤）；
- 均按 TDD：诊断报告先行，RED 断言「completion 事件后 footer 状态迁移」等行为，再最小实现。

## 处置状态（2026-09-29 footer 修复任务，TDD）

诊断依据：`var/upgrade/footer-bug-diagnosis.md`（唯一修复依据，根因与 RED 素材见其 §1–§3/§7）。

- 待诊断 1（● 条目卡死）：**已修复**。`packages/pi-subagents-enhanced/src/tui/session-browser.ts` 两条消费路径均改为 run 级终局兑底 child 级非终局：
  - `trackCompleted`：run 级 `state`/`status` 终局且逐 child 条目（`result.status`/`result.state`）未携带显式终局时，采用 run 级终局（原 :269 优先级反转）；
  - `reconcileRun`：run 级 `state` 终局时不再让冻结的 `step.status:"running"` 维持活跃（原 :228）。
  - 「已终局不回退」不变式（原 :229/:272 语义）原样保留；root 条目完成后正确迁出 activeChildren 进入 recentChildren。
- 待诊断 2（model 缺失）+ 待诊断 3（token 缺失）：**已修复**。`reconcileRun` 在容器 steps 缺 model/thinking/tokens 且 `step.runId` 存在（root facade 形态标志）时，经 `readBrowserRunStatus`（O_NOFOLLOW/2MB 上限防线，`browser-adapter.ts:16-40`）解析 `path.dirname(asyncDir)` 邻接目录下 leaf run 的 status.json，取 leaf step 补齐 model/thinking/tokens。路径限定为邻接 runs 根的直接子目录（`../` 逃逸、绝对路径、嵌套路径均拒绝）。
- 待诊断 4（幽灵条目）：**保持待办，另行评审**。footer 侧表现随 #1 修复消失（root 容器随 run 级终局迁入 history）；runtime 侧缺陷（authority 锁竞争 `durable-storage.ts:26-37` 无等待语义 + `authority-store.ts:43` 错误吞因 + `spawnWorkflowLeaf` 失败零回滚 `extension.ts:464`）未动，须独立任务处理。

### 验证证据

- RED（修复前，实现缺失导致失败，非测试错误）：
  - `test/subagent-session-browser.test.mjs`「run-level terminal completion settles children whose facade result is frozen at running」→ actual `'running'` / expected `'complete'`（trackCompleted 路径）；
  - 「run-level terminal reconcile settles frozen running step status and later polls do not resurrect it」→ 同形态 RED（reconcileRun 路径）；
  - 「reconcile projects facade model, thinking, and tokens from the adjacent leaf status」→ state 断言 RED `'running'`/`'complete'`；单独观察 model 断言 RED：actual `undefined` / expected `'qoder-pool/GLM-5.3-0.6x:high'`（#2/#3 实现缺失）。
- GREEN：上述用例全部通过；「facade leaf resolution is confined to the adjacent runs root」守护用例通过，且经变异验证（临时移除路径限定检查后用例捕获 `escape-pool/escaped-model:high` 逃逸投影，随后恢复实现）。
- 聚焦回归：`TMPDIR=/tmp node --test test/subagent-session-browser.test.mjs test/custom-footer-subagents.test.mjs test/custom-footer-input.integration.test.mjs` → 81 pass / 0 fail（session-browser 29→33，含 4 个新用例）；`npm run typecheck` 通过。
- 修复报告：`var/upgrade/footer-fix-123.md`。

### 未修（登记，非本任务范围）

- root/leaf 双条目并存（去重属独立产品决策：修后 root 迁入 history 会与 leaf 条目并列显示）；
- 主会话 model 与 selector 首行同行造成的视觉误读（footer 布局调整，低优先登记项）；
- `trackCompleted` 采集 completion 事件 `results[].usage`（可选增强未做——数据经 leaf status 投影已补齐）。
- 上游形态成因（`subagent-executor.js:3897` facade 完成结果逐 child 携带 detach 时刻 `state:"running"`）：登记为上游回馈候选，本仓 no-patch 不改上游。

## 注意

本缺陷与通知缺陷同现场但独立：即使通知修复，footer 投影仍会卡死；反之亦然。修复须分别验证。

## 关联观察：完成通知的标题投影陈旧（2026-09-29 晚）

triage 任务（2709b3ba）的超时完成通知标题显示为「Bug #4③：spawnWorkflowLeaf 失败尽力 stop 回滚（TDD）」——这是更早任务（b6d9d47d）的标题，而通知体中的 runId/asyncDir/session file 均指向 2709b3ba。标题与正文的身份投影不一致，疑似 title registry 的 workflow 标题绑定被后续派发覆盖/未按 run 绑定。与 #1（状态卡死）不同源：状态已由本次修复正确流转，仅标题串扰。低优先（显示层），登记待查；root→leaf 双条目去重（本记录处置节的遗留项）修复时可一并评估 titleRegistry 的绑定粒度。
