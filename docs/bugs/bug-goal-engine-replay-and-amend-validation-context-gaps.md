# Bug：goal-engine 重放与修订校验上下文缺口

## 1. 现象

v2 `goal.created`/`goal.amended` reducer 曾读取 `process.cwd()` 编译派生 dispatch 契约；同一事件日志从不同调用目录重放会受 ambient cwd 影响。`goal_amend` 又只在 reducer 中以无 origin context 的 validator 校验任务，因而可新增或更新包含实际仓库路径的 command。可选 completed/evidence context 还以硬编码预算静默丢弃条目。

## 2. 影响

持久化 event 的 projection 和重放成败不再只由日志决定；修订可以绕过 origin cwd 的执行边界；下游 executor 失去已完成事实或相关文件却没有可见提示。

## 3. 稳定复现

1. 从两个不同 cwd 重放相同 v2 create/amend JSONL。
2. 对已创建 goal 的 amend 添加或更新 command，使其包含 lexical cwd 或其 realpath（symlink physical path）。
3. 令 accepted task 的 facts、evidence 或 writePaths 超过 item/byte 预算或出现重复。

## 4. 根因

事件 reducer 把命令边界的运行目录策略和派生 IR 验证混入 ambient process state；amend 没有对完整 candidate taskDefs 带 ctx cwd/realpath 复验；optional context 未共享 contract limits，也未为 omission summary 保留预算。

## 5. 促成因素

测试未证明跨 cwd 重放恒定、amend 的 add/update 双路径及 symlink origin 均被拒绝，且仅检查 optional context 有界而没有精确检查保留顺序、遗漏计数和多字节边界。

## 6. 修复与验证策略

reducer 使用 dispatch module 导出的稳定 absolute validation sentinel，禁止读取 ambient cwd；handler 在 append 前投影完整 candidate 并以 `ctx.cwd` 与 `realpathSync(ctx.cwd)` 复验。optional context 使用共享上限、稳定顺序和有界 omission summary。补充 Git filesystem 错误包装、精确 fixture code、v2 metadata 与 v1 replay matrix，并验证失败不会追加 events、registry 或 worktree。
