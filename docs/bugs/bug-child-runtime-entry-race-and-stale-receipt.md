# Bug: child runtime 入口并发失败并可能误删替换文件

## 1. 现象

Task 1 候选提交 `9540bef` 的自主复验发现四个问题：

1. `materializeChildRuntimeEntry()` 把 `targetUrl` 限定为字符串；后续 Launcher 计划传入 `new URL(...)`，调用会抛出 `TypeError: targetUrl must be a file: URL`。
2. 对同一入口并发执行 8 次相同 materialize 时，只有 1 次成功，其余 7 次因 hard-link `EEXIST` 失败；连续 50 轮均可复现。
3. 入口创建后若被删除，再以相同字节和 `0600` 权限创建新文件，旧 receipt 会通过 hash 校验并删除这个替换文件。
4. hard link 已发布后，若临时文件 unlink 报错，函数向调用方报告失败，但已发布入口仍留在命名空间中，调用方没有 receipt 可安全清理。

## 2. 影响

Plan Launcher 和 typed Executor 都会依赖该原语生成启动入口。URL 类型不兼容会直接阻断接入；并发失败会让相同 Plan/Executor 启动出现非幂等错误；旧 receipt 误删会破坏其他启动方接管后的入口；发布后假失败会留下无法归属的 runtime artifact，并使后续补偿无法判断是否应删除。

因此 `9540bef` 不能合入主分支，也不能作为 Task 2/3 的可信基础。

## 3. 稳定复现

在 `9540bef` worktree 中使用真实临时目录和文件系统：

- 把 `pathToFileURL(target)` 直接作为 `targetUrl` 传入，稳定得到 `TypeError`。
- 对相同 `{ cwd, fileName, targetUrl }` 执行 `Promise.allSettled()`，8 个调用稳定出现 1 fulfilled / 7 rejected。
- 保存首次 receipt，删除其入口，再写入相同源码与 `0600` 权限，调用 `removeChildRuntimeEntry(receipt)`，替换文件被删除。
- 通过 Node module mock 让临时文件 unlink 在实际 unlink 后抛出 `EIO`，materialize rejected，但 published entry 仍存在。

前三项由主 agent 在真实文件系统中直接复现；第四项由超时 reviewer 会话留下的故障注入输出证实。

## 4. 根因

四个问题来自三个合同缺口：

1. **输入合同不一致**：实现把“file URL”误解释为“file URL 字符串”，而计划和 Node 标准 API 使用 `URL` 对象。
2. **发布状态机不完整**：实现先检查目标不存在，再创建临时文件并 hard-link；并发 loser 收到 `EEXIST` 后没有重新验证 winner 的入口，也没有把相同内容收敛为幂等成功。hard link 成功后仍执行可能失败的步骤，但错误分支只清临时文件，不对已经发布的同 inode 入口做身份安全补偿。
3. **receipt 没有真实身份**：公开字段只有路径和内容 hash，未在模块私有状态中保存 receipt 对象与已发布 inode/device 的绑定。相同字节的替换文件或伪造对象因此可冒充原入口。

## 5. 本次处置

候选提交保留在隔离 worktree `/private/tmp/pi-config-plan-runner/task-1`，尚未 cherry-pick 到主分支。主分支 dirty worktree 和其他并行任务未被修改。

外部 review provider 因三个 API key 均未配置而无法运行；替代的独立 reviewer 超时，但其会话证实了 hard link 发布后 unlink 报错会留下 orphan。当前以自主复验的真实文件系统证据作为修复输入，不把超时 reviewer 视为通过。

## 6. 修复与防回归要求

修复必须继续严格 TDD，并满足：

- 同时接受 `URL` 对象和合法 `file:` URL 字符串，receipt 仍记录 canonical URL 字符串。
- 多个相同并发调用全部成功，且恰好一个 `created:true`；竞争者在 `EEXIST` 后重新验证 winner，返回 `created:false`。
- 冲突 target 的并发调用只允许匹配 winner 的一方成功，另一方 fail closed；命名空间不得残留临时文件。
- 使用模块私有 `WeakMap` 或等价不可伪造状态，把真实 receipt 对象绑定到发布时的 `dev`/`ino`；复制字段、旧 receipt、同字节替换文件均不得删除入口。
- hard link 成功后的错误处理必须区分“尚未发布”和“已发布”；只在当前路径仍指向本次 inode 时补偿删除，绝不删除竞争者或未知文件。
- 保留 namespace/entry 非 symlink、`0700`/`0600`、canonical target、no-clobber 和 foreign 文件保护等既有测试。
