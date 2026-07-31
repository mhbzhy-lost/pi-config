# Bug: Goal Engine 将 Subagent 运行时产物判为未提交代码

## 症状
真实 executor 在独立 worktree 完成代码并提交后，`goal_integrate` 报错 `Workspace must be clean before integration`。`git status --porcelain` 只显示未跟踪目录 `.pi-subagents/`。

## 影响
所有通过 Pi subagent 执行的真实任务都会在 worktree 生成 `.pi-subagents/artifacts/*`。Goal Engine 因此无法合回任何真实 executor 成果；仅手工模拟、未经过 subagent runtime 的冒烟测试能够通过。

## 复现
在 Goal Engine 分配的 worktree 中派发 delegate/executor，完成并提交业务文件后调用 `goal_integrate`。`inspectExecutorWorkspace` 返回 `clean=false`，其中 `untrackedFiles` 全部位于 `.pi-subagents/`。

## 根因
`workspace.mjs` 使用 `git ls-files --others --exclude-standard` 收集全部未跟踪文件，没有排除 Pi subagent runtime 的工作目录 `.pi-subagents/`。Plan Runner 已验证实现会排除该目录，但 Goal Engine 的独立副本漏掉了这一规则。

## 修复
`inspectExecutorWorkspace` 过滤 `.pi-subagents/` 下的未跟踪文件，使运行时诊断产物不参与代码 worktree 清洁度判定。释放 worktree 前由 `git worktree remove --force` 一并清理该目录；如果 `.pi-subagents/` 文件被 git 跟踪，则仍按正常代码变更处理。

## 验证
新增 workspace 单测：在干净且有提交的 executor worktree 中创建未跟踪 `.pi-subagents/artifacts/run.json`，检查结果仍为 `clean=true` 且 `untrackedFiles=[]`；普通未跟踪业务文件仍应令 `clean=false`。重跑 workspace 与 extension 测试，再重试 crash-analyzer 的 `goal_integrate(stats-core)`。
