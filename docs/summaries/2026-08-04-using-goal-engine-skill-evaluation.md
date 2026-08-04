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
- acceptance commands 从 Executor worktree 执行，不硬编码 origin `cd`。
- compact/reload/新协调轮次先调用 `goal_status`，服从 machine action。
- 成功路径严格执行 settle → integrate → accept；失败/blocked 路径先 discard active workspace，再 redispatch 或 amend。
- 不直接编辑 events/projection，不用重新 init 代替 amendment。
