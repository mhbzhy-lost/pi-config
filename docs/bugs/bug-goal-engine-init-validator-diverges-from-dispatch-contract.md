# Bug：goal_init 校验器与 dispatch 契约漂移

## 1. 现象

`goal_init` 的 task command 和 `writePaths` 校验与 `compileCodingDispatchIR` 不一致：前者曾允许 glob、NUL 等路径，并错误拒绝运行时 `$PWD`；同时 command 可把 origin 的绝对 cwd 以引用或控制操作符后的 `cd` 形式带入 executor。

## 2. 影响

无效任务可能在初始化时写入 Goal state，或在 dispatch 时才以另一套语义失败。硬编码 origin 路径会让 executor 在 worktree 外执行；不一致的路径规则会扩大写入范围或产生不可重放的契约。

## 3. 稳定复现

1. 用 `writePaths: ["src/**/x\u0000"]`、`src\\x` 或 `src/*` 调用 `goal_init`。
2. 用 `cd "/tmp"`、`cd -- /tmp`、`true && cd '/tmp'` 或包含实际 origin absolute cwd 的命令调用。
3. 旧校验会漏过其中部分输入，且会拒绝应由 Executor worktree 解析的 `$PWD`。

## 4. 根因

`task-definition` 自己维护了较弱的路径正则，而 dispatch IR 另有 parser；command validator 没有接收真实 `ExtensionContext.cwd`，并将动态 `$PWD` 与 origin 硬编码混为一谈。

## 5. 促成因素

缺少 init 到 dispatch 的差分矩阵，缺少 quoted/`--`/控制操作符 `cd` 覆盖，也缺少 NUL 与 glob 的 preflight 零副作用断言。

## 6. 修复与验证策略

提取无循环依赖的 repo-relative POSIX parser，供 task-definition 和 dispatch IR 共用；将实际 ctx cwd 传给 task validator，包装为带 `INVALID_TASK_CONTRACT`、observed、remediation 和 `stateChanged=false` 的错误。补充 Host unsafe cwd、Git preflight 与 task/dispatch 差分测试，并确认失败前没有 events、registry 或 worktrees。
