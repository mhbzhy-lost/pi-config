# Goal Engine 接受依赖 Executor 忽略文件的 workspace

## 现象
旧流程可在 Executor worktree 上直接执行验收，忽略或未跟踪文件、遗留子进程会影响结果；`lsof` 返回 status=1 但 stdout 仍含 PID 时被 catch 当作 clear。

## 影响
同一提交在干净环境不可复现，且释放时可能删除仍被进程占用的资源，任意 command 与继承环境还可能泄露宿主能力。

## 根因
验收没有 durable validation plan/lease/capacity/release fence；runner 接受任意 command 并继承 env；旧终止证明只检查 leader，未证明整个 process group；lsof 的非空输出被错误忽略。

## 复现
在 Executor worktree 创建被 `.gitignore` 忽略的输入或后台进程后运行验收；或令 lsof 以 status=1 输出 PID，再尝试 release。

## 修复
从 current integrated full SHA 创建独立 managed validation workspace，先原子记录 0600 lease intent 并绑定计划 hash/owner/identity。run 只接受 actionId，使用 allowlist 环境和 worktree 外的 runtime；执行前后核对 Git identity/cleanliness，并以 PID birth 与完整进程组终止证明 fail closed。release 对 status=1 的 stdout 仍按活动资源处理。

## 防回归
覆盖 plan 边界及副作用前拒绝、ignored 文件不可见、环境隔离、超时/后代进程组清理、调用者 receipt 篡改、容量与活动 cwd 阻止释放，以及 criteria-only contract。
