# Pi Plan Execution Capsule

## 使用方式

批准计划后，由 Main 发起：

```text
/plan-run docs/superpowers/plans/<approved-plan>.md
/plan-status <plan-id>
/plan-cancel <plan-id>
```

每个 Plan 使用独立 `pi-plan/<planId>` 分支和 `var/plan-worktrees/<planId>` accumulator worktree。每个活动 Attempt 再使用独立分支、cwd 和 owner token；无路径或资源冲突的 root Task 可以并行。

## Flat runtime

领域关系是 `Main -> Plan Runner -> Executor`：Main 批准 Plan，Plan Runner 解释批准的 DAG、路径和资源，再为 Executor 创建固定合同。运行时关系则是同一个 Root 下的 siblings：Root 分别持有 Plan Runner 与 Executor；这不改变领域中的父子职责。

Root session 是唯一生命周期 owner。Launcher 通过 `pi.appendEntry(HANDLE_TYPE, handle)` 将 session-local v4 handle 写入当前 Root session branch，handle 只在该 Root 内有效；`root-session-owner.ts` 不保存 handle，它在 child 中订阅 `root.closing` 与 ownership EOF，并以 `SIGTERM` 终止该 child。其他 Root 不恢复，也不接管已有运行。每个派发的 `spawnKey` 是 Root 私有键，不可作为跨 Root 标识或恢复依据。

Plan Runner 模型原样调用项目 `subagent` 工具。Plan Capsule 只在该 tool call 上执行一次性授权，child adapter（`root-owned-subagent`）再将已授权请求交给 Root broker，broker 调用本地 `pi-subagents` RPC 并持有 Executor 的运行所有权；Capsule 既不直接 spawn，也不禁止该工具调用。Executor 只能在已分配 Attempt worktree 中运行，不能改变 DAG、cwd、allowed paths、资源或集成顺序，也不能继续派发 Agent。

## 三类事实

三类事实不得相互替代：

1. append-only `pi-plan-event-v1` 与 Git 提交证明 Task、Attempt、Attention、integration、Gate 和 Plan 终态。
2. 官方 `pi-subagents` lifecycle artifacts 证明 Executor 的 runId、session、cwd 和运行终态；result 只允许读取派发时绑定的唯一 output 路径。
3. `var/plan-runs/<planId>/status.json` 和 widget 是可再生投影，不能产生 `accepted`、`integrated` 或 `validated`。

RPC 格式化 status 文本只用于 reconcile 定位；typed lifecycle 必须读取官方 artifact。运行中的进程不能单独推导 Plan 成功。

## 调度、恢复与关闭

Harness 先重放活动 Attempt 的资源 claim，再按 Plan 顺序选择 frontier。路径所有权是 exclusive 资源；声明资源支持 shared 容量和 exclusive 占用。授权完成后才创建 Attempt worktree 并由 Root broker 发出 RPC spawn。

`attempt.dispatch-requested` 绑定 dispatch event 与一次性 contract hash。其后的非协议 spawn 异常直接视为不确定；若无法从 started event、spawn reply 和官方 artifact 唯一绑定 run，Plan 进入 `dispatch_uncertain` 并保留现场，禁止自动重复 spawn。已绑定 run 只在同一 Root 内依据 session file、runId、asyncDir、cwd 和授权 output 继续对账。

关闭顺序受同一 Root 管理：先停止新的派发，对 Executors 请求 `stop` 并等待各自官方 terminal proof，再对 Plan Runner 请求 `stop` 并等待 proof，最后关闭 broker transport 并 dispose upstream。`interrupt` 不是 shutdown 控制。跨 Root 请求一律拒绝，避免其他 session 改写所有权或复用运行。

Executor 完成不等于结果可接受。Attempt 必须通过以下检查：

- 基于批准 base 的单个非 merge descendant commit；
- worktree 无越界 tracked/untracked 变化；
- rename 两端、symlink 和 `.git` 边界合法；
- 只执行 Plan contract 注册的验证命令；
- stdout/stderr 和 diff hash 形成不可变证据。

## Attention

Executor 的 native supervisor request 经 broker ownership routing 只交给 owning Plan Runner，不能直接向 Root 请求输入。Plan Runner 持久化 Attention，并执行固定控制循环：

```text
pending -> 1000ms bounded wait -> pending -> plan_status
```

blocking 请求一旦持久化为 `waiting-attention`，Plan Runner 就不得再自行回复，包括计划已明确 fail-closed 结果的情况。请求正文写入 0600 Markdown 和 durable Attention event；当前 Root 的 Launcher projection 通知桥将通知发给 Main。Main 获得用户明确决策后调用 `plan_attention_reply`，该工具从当前 projection 派生并写入 taskId、attemptId、runId 完整的 durable command。Plan Runner 随后以 fenced `plan_executor_supervisor` reply 投递该命令。

command 版本绑定不可变 Attention 请求，native delivery authorization 另行绑定当前 Plan version，因此并行 Task 的无关事件不会让用户回复 stale。command 缺失、过期或不匹配时 native reply 必须拒绝；只有 native reply 成功后才能 resolve。`waiting-attention` 不是终态，同一 Root 生命周期内从 event 和 command inbox 继续处理，不重复通知、不串线。

## 集成与 Gate

只有 Integration Queue 可以写 accumulator。它按 Plan 文档顺序串行 cherry-pick validated Attempt，并校验 owner token、expected HEAD、validation hash 和 patch hash。若进程在 cherry-pick 成功后、`integration.finished` 落盘前退出，只接受“HEAD 是 expected HEAD 的单父子提交且 diff SHA 等于 validated SHA”的唯一证明；否则进入 `integration_recovery_ambiguous`。冲突会 abort 回该 item 的 expected HEAD 并保留 Attempt worktree，不自动 rebase。

只有 deterministic、plan-audit、external-review 和 final-completeness 四道 Gate 都绑定同一 clean HEAD 并通过，Plan 才能进入 `validated`。完成声明必须同时满足：

```text
lifecycle == validated
validatedHead == headCommit
```

失败、blocked、cancelled、interrupted 和 cleanup failure 均保留证据；受控 `.pi-subagents` runtime artifact 仅在授权 cleanup 阶段删除。

## 显式 Merge Back

`validated` 不会修改 origin，也不会 push。合回前重新确认 `validatedHead` 仍等于 accumulator HEAD，且 origin 工作区允许合并，然后由用户显式执行：

```bash
git merge --no-ff "pi-plan/<planId>"
```

HEAD 变化、Gate stale 或 origin 冲突时禁止合回，先处理现场。
