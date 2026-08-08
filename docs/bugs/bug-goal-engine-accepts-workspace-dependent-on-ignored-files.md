# Goal Engine 接受依赖 Executor 忽略文件的 workspace

## 现象
旧流程可在 Executor worktree 上直接执行验收，忽略或未跟踪文件、遗留子进程会影响结果。

## 影响
同一提交在干净环境不可复现，且释放时可能删除仍被进程占用的资源。

## 根因
验收没有独立的 managed workspace、固定 integrated HEAD 与进程身份/进程组终止证明。

## 复现
在 Executor worktree 创建被 `.gitignore` 忽略的输入或后台进程后运行验收，结果会依赖该本地状态。

## 修复
从 integrated full SHA 创建独立 managed validation workspace；执行前后核对 Git identity/cleanliness，命令置于受控进程组，以 PID birth identity 轮询并在成功、失败、超时后确认终止。发现活动 cwd/process、部分资源或 identity 冲突时 fail closed。

## 防回归
覆盖 ignored 文件不可见、超时清理进程组、活动 cwd 阻止释放及 criteria-only contract。
