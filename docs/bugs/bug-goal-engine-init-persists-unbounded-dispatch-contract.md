# Bug：goal_init 未持久化有界 dispatch 契约

## 1. 现象

`goal_init` 的 task 定义未共享 dispatch IR 的 4096-byte 字符串和 32 项数组上限；`description`、验收项、命令、路径及任务/DAG 数量可在初始化时写入。绝对 `cd` 检查也只识别直接命令位置，`sh -c`、`bash -lc`、`eval`、`xargs sh -c` 等 wrapper 可绕过。

## 2. 影响

超大或过多的任务契约会先写入 Goal state，之后才在 dispatch 边界失败，造成不可执行的持久历史。wrapper 可让 executor 离开 worktree；只比较逻辑 cwd 时，origin 的 realpath alias 仍可被硬编码。

## 3. 稳定复现

1. 用 4097-byte 的 `writePath`、`command`、`description` 或 `criterion`，或 33 项 tasks/deps/writePaths/criteria/commands 调用 `goal_init`。
2. 使用 `sh -c 'cd /tmp'`、`bash -lc "cd /tmp"`、`eval 'cd /tmp'` 或 `xargs sh -c 'cd /tmp'` 作为 command。
3. 从安全 Git 仓库调用初始化，并令命令包含该 cwd 的 realpath alias。

## 4. 根因

`task-definition` 与 `dispatch-ir` 分别维护限制，且 init handler 只传入一个 cwd。命令检查使用仅覆盖直接 `cd` 的正则，不能安全解释 shell wrapper。

## 5. 促成因素

缺少 init/事件/dispatch 的同向边界测试，真实 Host 缺少非 Git cwd 拒绝覆盖，Git preflight 也没有损坏 index 的确定性基础设施 fixture。

## 6. 修复与验证策略

提取共享限制常量，使 init validator、v2 event final gate 和 dispatch IR 同向拒绝，保留 v1 replay。handler 同时传入 ctx cwd 与 realpath alias；对复杂 command 中的 absolute `cd` 采用保守 fail-closed 子集，同时保留 `echo 'cd /tmp'`、相对 cd 和 `$PWD`。以真实 Host、损坏 index 和零副作用断言覆盖 preflight。
