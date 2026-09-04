# Goal 与 Subagent Workspace 生命周期分叉

## 问题

普通 subagent 与 Goal executor 都通过合法的公开入口启动，并最终使用同一个 Git linked worktree primitive，但 workspace 分配、资源身份、持久化 ledger、run 绑定和 disposition 分别由两套状态机管理。这使同一种资源事实出现两个权威来源，也迫使 typed subagent 针对 Goal workspace 增加特殊禁止分支。

## 数据来源与 production 可达性

两条输入都来自正常 production 入口，不是手工拼装 event、projection 或测试 fixture：

1. 普通任务通过 typed `subagent` tool 传入 `execution.worktree=true`。`executeCoding`/`executeGeneric` 创建 workspace 请求，调用 `workspaceController.allocateManagedSubagentWorkspace`，随后由 standalone ledger 记录分配、run binding 和 disposition。
2. Goal 任务先通过 `goal_dispatch` 选中 pending task，再把返回的 `dispatch-ir.v1` contract 交给同一个 typed `subagent` tool。`goal_dispatch` 在返回 contract 前调用 `allocateExecutorWorkspace`，把已分配 workspace path 写入 `execution.cwd`；typed tool 通过 Goal coordinator ticket 识别已有 workspace，并禁止再次请求 managed workspace。

两条链的权威身份都来自 live root session、合法 tool call、当前 Git origin/ref/HEAD 和正常事件顺序，因此属于“预期 production 数据未被正确统一处理”。问题不是非法 fixture 触发的兼容缺口。

## 首个偏离点

首个偏离点发生在 workspace allocation owner 的选择：

- Goal 路径在 `goal_dispatch` 内直接调用 `allocateExecutorWorkspace`；
- standalone 路径在 typed tool execute 内调用 `allocateManagedSubagentWorkspace`。

从这里开始，两边分别生成不同 workspace identity、lease/owner 表达和 durable ledger。Goal contract hash 还依赖提前生成的 workspace cwd，standalone contract 则先 hash source contract、再生成 runtime cwd。

## 完整生成调用链

Goal 路径：

```text
goal_dispatch
  -> allocateExecutorWorkspace
  -> createManagedWorktree
  -> 写 Goal 私有 workspace lease
  -> compileTaskContract(workspace.path)
  -> task.dispatched event
  -> subagent(contract)
  -> Goal coordinator prepareSpawn
  -> upstream workflow/leaf spawn(worktree=false)
  -> Goal coordinator bindSpawn
  -> Goal 私有 inspect/integrate/release
```

Standalone 路径：

```text
subagent(execution.worktree=true)
  -> compileCodingDispatchIR(source contract)
  -> createWorkspaceRequest
  -> allocateManagedSubagentWorkspace
  -> standalone allocateWorkspaceIntent
  -> createSubagentWorkspace
  -> createManagedWorktree
  -> standalone activate/bind ledger
  -> upstream workflow/leaf spawn(worktree=false)
  -> standalone status/dispose/release
```

## 修复边界

保留 harness 自动分配 worktree 的能力。统一 `dispatch-ir.v1` source contract、managed workspace request/receipt 和 coordinator 四阶段接口，使 Goal 与 standalone 后续都由 typed subagent 调用同一个 workspace service。运行时生成的 `dispatchCwd`、owner secret 和 lease secret 不进入 source contract hash；Goal 只持有业务 request/receipt 事件，不再成为 Git workspace 资源 owner。
