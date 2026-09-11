# DAG amendment offer 被 generic dispatch 抢占

## 现象

production `goal_status` 在合法 `planned.v1` DAG 中，已释放的 blocked source 应获得绑定的 `goal_amend`（`resolve_blocked`），却先签发 `goal_dispatch`。source 被 supersede 并由 replacement 接受后，依赖 source 的 pending task 同样会被 replacement 的 generic `goal_dispatch` 抢占，而不是得到绑定 `patch_active` offer。

## 复现链

`goal_init(source -> dependent)` → dispatch/settle `source` 为 blocked → discard 已释放 workspace → `goal_amend(resolve_blocked, supersede)` 新增 replacement → replacement dispatch/settle/integrate/accept。该链只使用公开 `planned.v1` 事件与工具。

## 调用链与首偏离

`goal_status` 调用 `machineActionForProjection`。该函数先调用每个 task 的 `taskActionState`：released 的 pending task 返回 `requiredNextAction = goal_dispatch`，随后循环立即返回。superseded dependency 的 pending-task 检测位于这个循环之后，永远到不了；首偏离就是该 generic `goal_dispatch` 的早返回。由于 status 已签发 dispatch token，随后调用 bound `goal_amend` 会在 `verifyAndConsumeActionOffer` 因 tool mismatch 失败。

另一个 production 可达的状态丢失使该 offer 不可执行：`task.managed_disposition_applied` 在 blocked task 的 discard/preserve receipt released 后无条件改写为 pending，而 `task.block_resolved` 只接受 blocked task。资源必须先处置，业务 blocked 状态则必须保留到显式 resolve_blocked。

## 修复原则

仅延后 generic `goal_dispatch`：保留 dispatch-request recovery 的既有优先级，以及 orphan/resource disposition、settle/integrate、blocked amendment 等安全门禁。随后只为没有 active 或未释放 workspace 的 pending task检查 superseded dependency，签发 exact `goal_amend patch_active`；最后才返回普通 dispatch。managed disposition receipt 仅将非-blocked failed/retry 状态转为 pending，blocked 的 reason 与显式 amendment authority 保留。既有 action offer 的 projection version、goal、tool 和 exact params 绑定及一次性 consume 语义不变。
