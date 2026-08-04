# Bug：goal_init 在不安全工作区和无效任务契约下仍持久化状态

## 1. 现象

`goal_init` 旧实现只从执行上下文取得 cwd，随即构造事件并写入 `.state/goal-engine`。它未确认 cwd 是带有效、附着 HEAD 的 Git worktree，也未确认状态目录被整体 ignore 且没有 tracked 条目；同时重复 task ID 会在对象构造时覆盖，v2 事件也缺少完整任务定义门禁。

## 2. 影响

在非 Git 目录、仓库子目录、unborn 或 detached HEAD、状态目录未 ignore/已被跟踪的仓库中，调用可能留下 registry、events 或 worktree 状态。无效 DAG、路径、workflow、验收命令或重复任务可以作为新 v2 Goal 历史的一部分持久化，之后难以安全恢复。

## 3. 稳定复现

1. 创建临时目录，或创建一个尚未提交、detached、或从子目录调用的 Git fixture。
2. 调用真实 Host 的 `goal_init`，传入表面完整的任务。
3. 旧实现接受调用并创建 `.state/goal-engine`，即使 Git preflight 不成立。
4. 传入重复 ID、未知依赖、循环、绝对/逃逸 writePath、空 acceptance、绝对 `cd` 或不支持 workflow 的 v2 创建/修改事件；旧事件层可遗漏相应拒绝。

## 4. 根因

初始化 handler 在 `appendEvent` 前没有 fail-closed Git preflight，且 taskDefs 是按 ID 写入对象，导致重复 ID 在 `validateDAG` 前已被覆盖。事件投影只执行了部分结构检查，未将 v2 创建和 amendment 都路由到同一份任务定义验证器。

## 5. 促成因素

1. 单元测试普遍使用非 Git 临时目录作为成功 fixture。
2. 测试主要验证生成的 DAG，未断言失败时 state、registry、events 和 worktree 都不存在。
3. Git 子命令错误被宽泛捕获会把基础设施异常误当作普通 negative。
4. 旧 v1 回放兼容与新 v2 写入门禁没有明确隔离。

## 6. 修复与验证策略

1. 在任何 state probe、`appendEvent` 或目录创建前，确认 realpath 后的 cwd 等于 Git worktree top-level，HEAD 有效且 attached，状态目录整体 ignored 且没有 tracked entries；预期 Git exit 单独处理，其余错误 fail-closed。
2. 为 v2 `goal.created` 和 `goal.amended` 使用共享任务定义验证：非空、精确 ID 对应、唯一 ID/deps、DAG、非空字符串、workflow、repo-relative POSIX writePaths 及安全 acceptance command。
3. 仅历史纯 v1 回放保留旧语义；一旦写入 v2，不允许利用 amendment 绕过验证。
4. 所有拒绝都返回稳定 code，message 包含 observed、remediation、`stateChanged=false`；已有 active Goal 还在 message 中编码 `goal_status` 的 `requiredNextAction`。
5. 以真实 Pi Host `ToolDefinition.execute` 覆盖不安全 cwd 零状态和安全已提交、已 ignore fixture 成功，并运行 Goal、runtime 与 Doctor 回归。
