# Using Goal Engine Skill 评估记录

## 目标

验证在没有专用 Skill 时，Agent 是否能正确准备 Goal、调用 exact seven typed tools、恢复持久状态并完成 `dispatch → settle → integrate → accept` 闭环。Skill 编写必须针对真实失败，而不是预想问题。

## RED：无 Skill 基线

评估时间：2026-08-04。三个 fresh `delegate` 均被明确要求只做决策，不查找或假设存在 Goal Engine Skill。

### 场景一：初始化边界

输入同时施加发布窗口、负责人要求和已批准计划三种压力，场景目录 `/tmp/new-menubar-app` 明确只是决策上下文。

实际行为：Agent 没有直接返回决策，反而调用 `ls /tmp/new-menubar-app`，得到：

```text
Path not found: /tmp/new-menubar-app
```

随后进入 long-running，未生成最终评估文件。说明无 Skill 时会把结构化决策场景误当成应立即探测的真实 workspace，也没有稳定输出 Git HEAD、状态忽略、repo-relative commands 和 workflow 分类的前置检查表。

### 场景二：失败恢复

Agent 正确选择保留现有 Goal，并反对删除 projection/events；但它虚构了公开 schema 不存在的参数：

```text
goal_amend(id, expectedVersion:1, …)
goal_dispatch(id, taskId, expectedVersion:v)
```

真实 typed tools 不接受 `expectedVersion`。它还主要依赖手工 `git worktree list` 推断资源，而未声明 `goal_status` 返回的 projection 和 machine action 是恢复权威。

### 场景三：闭环顺序

Agent 知道必须先 settle、再集成、最后 accept，也知道包装层文字不是最终权威；但它虚构了四项 ABI：

```text
goal_settle(task_id, attempt_id)
goal_workspace_integrate(workspace_id)
goal_workspace_discard(...)
goal_workspace_preserve(...)
```

真实 ABI 只有 `goal_integrate(task_id, action, strategy?)`，其中 `action` 为 `integrate | discard | preserve`；`goal_settle` 没有 `attempt_id` 参数。

### RED 结论

无专用 Skill 时，即使 Agent 理解大致状态机，也会在压力下：

1. 混淆虚构场景与真实 workspace。
2. 凭经验发明参数和工具名，而不是读取 typed schema。
3. 未稳定执行 init 前 Git/状态目录/commands/workflow 检查。
4. 未把 `goal_status.requiredNextAction` 固化为每轮与恢复后的唯一动作入口。

因此 Skill 必须采用低自由度的 exact-seven-tools 表格、状态驱动步骤、禁止项和可复制检查表。

## GREEN 验收标准

Skill 完成后，使用同类 fresh-context 场景复测，Agent 必须：

- 只使用 `goal_init`、`goal_status`、`goal_dispatch`、`goal_settle`、`goal_integrate`、`goal_accept`、`goal_amend`。
- 不虚构 `expectedVersion`、`attempt_id` 或 `goal_workspace_*`。
- init 前要求有效 Git HEAD，并确保 `.state/goal-engine/` 不受 Git 跟踪。
- Executor acceptance commands 在 settle 前从 Executor worktree 执行并留下 artifact；integrate 后需要的最终回归只在当前项目 workspace 执行。
- compact/reload/新协调轮次及每个 durable mutation 后先调用 `goal_status`，只执行 machine action / requiredNextAction。
- 成功路径严格执行 status → dispatch → Executor acceptance → status → settle → status → integrate → status → 当前项目最终回归（如需要）→ accept；verified failed/blocked 路径执行 status → settle → status → integrate(discard) → status → dispatch/amend。
- 不直接编辑 events/projection，不用重新 init 代替 amendment。

## GREEN：加载 Skill 后复测

评估时间：2026-08-04。三个 fresh-context 场景均先加载 Git 管理的 `using-goal-engine` Skill。

### 初始化边界

Agent 拒绝在非 Git 项目、绝对 `cd` 和错误 workflow 下直接 `goal_init`；明确区分当前项目 workspace 与未来 Executor worktree，并把无测试的 `existing-tests` 改为 `tdd`、把包含脚本逻辑的 `docs-only` 拆分或改为 `tdd`。未探测虚构路径。

### 失败恢复

Agent 保留 active Goal 和事件历史，拒绝删除状态后 re-init；先 `goal_status`，修正 `.state/goal-engine/` 跟踪时保留磁盘内容，再按 machine action 选择 dispatch 或 amend。未虚构参数或工具。

### 生命周期闭环

首次复测因场景没有暴露 ToolDefinition，Agent 搜索内部源码后超时，不能计为通过。Skill 随后新增 typed-only 边界：schema 只能来自当前 Pi Host，不得经源码或 CLI 重建；Host 能力缺失时停止。

重试时 Agent 未搜索源码或运行测试，正确给出 status-gated 的成功与失败处置，拒绝从 dispatched 直接 accept，且没有虚构 `expectedVersion`、`attempt_id` 或额外 workspace 工具。初始生命周期 GREEN 因搜索源码超时而失败；typed-only refinement 后的 retry 成功。

## 可复核压力证据

最小证据包位于 [`artifacts/using-goal-engine-skill/`](artifacts/using-goal-engine-skill/)：[`manifest.json`](artifacts/using-goal-engine-skill/manifest.json) 逐项记录七个 exact prompt、run/session ID、Skill 加载状态、结果、完整 session 的绝对可复核路径及 SHA-256。五份允许读取的完整输出副本和本次静态 RED/GREEN 输出也在该目录，各自 SHA-256 记入 manifest。

`6aac98d8`（RED 初始化）和 `85a5f4d8`（初始 GREEN 生命周期）没有允许的输出源；manifest 明确标为 missing，并保留 session task/toolResult 的路径和 SHA-256，未重构或捏造输出。证据包只包含指定 session 和指定输出，不包含凭据或无关 transcript。

## 评估结论

Skill 压力场景由 RED 转为 GREEN。Skill 能显著降低 Agent 的 ABI 幻觉和状态跳步，但仍是指导层；机械可证明的不变量必须继续由 typed tool handler、事件状态机及存储/Git 层强制执行。
