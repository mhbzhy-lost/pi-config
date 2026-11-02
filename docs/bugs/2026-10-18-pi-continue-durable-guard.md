# pi -c 恢复已有会话时报 DURABLE_LOCK_HELD

## 现场与来源分类

用户报告：`pi -c` 加载 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 失败，错误 `DURABLE_LOCK_HELD`；直接 `pi` 新会话正常。

旧版生产可达链：`beforeUpstreamSessionStart → supervisorControlPlane.ready(rootSessionId) → transaction → DurableStorage.acquireLock → withLockMutation`。锁 key 为 `supervisor-` 加 rootSessionId 的 SHA-256，恢复同一会话复用同一 key，新会话分配新的 key。

初次调查仅投影锁文件类型、大小、修改时间、PID 是否存在及 birth 格式；未读 session、Supervisor state JSON、authority 或凭据正文。发现三个空 `.lock.guard`：

- `supervisor-c44af50e408ede807e40f6abe280890a73d3e01ff7b3deb3252d45d491bda1cb.lock.guard`：同 key 主锁的 PID 28390 已不存在。
- `supervisor-f3ec8129db9a1e87f02e52372d0b5b3d71bd708a225d346267465021d96fafb7.lock.guard`：同 key 主锁的 PID 5312 已不存在。
- `supervisor-3cd2459c064408fafdd93183eceb0e43be2d9ea7cd2104e7fdca9cae49219f97.lock.guard`：无对应主锁。

初次调查主会话 `PI_SESSION_ID=01a14831-e247-7044-a36d-676dd611aed1` 对应 key 为 `supervisor-59e71ef4e0a3b76960f9752d864d9edb23fbac78ed5ceffd7f8dfdce9bbeb785`，不在上述残留中，因此不能把用户报错会话等同于调查主会话。

## 首个偏离点

旧版 `withLockMutation()` 通过 `open(wx)` 创建零字节 guard，然后执行读/建/删主锁。finally 才关闭并 unlink guard。进程在此窗口退出会留下 guard；后续恢复在 open 的 EEXIST 分支立即抛 `DURABLE_LOCK_HELD`，5 秒事务重试结束后失败。guard 没有 owner/PID，不能验证创建进程是否已死亡；主锁 PID 已死亡也不能证明没有另一进程正在操作 guard。

这一路径是合法 production writer 的已知恢复缺口，不是测试制造。初次调查未取得 incident 的精确 key，不能断言就是上述某一个 guard；仍可能存在真实活跃持锁进程。历史记录 `docs/bugs/2026-10-13-durable-lock-restart-owner.md` 已明确把 guard 崩溃窗口保留为 fail-closed 边界。iTerm2 关闭或 reboot 的历史中断点没有日志证据，不据此断言具体触发信号。

## 后续获授权的永久修复

新版在 macOS/Linux 使用精确版本 `fs-ext@2.1.1` 的 `flock(fd, "exnb")`。每个 key 使用稳定的 `.flock-v1.<key>.lock` 文件，打开时使用 `O_RDWR | O_CREAT | O_NOFOLLOW` 和 `0600`，并通过 fd 校验普通文件、当前 uid 与私有权限。文件名标识新协议，创建后即使立即崩溃留下空文件，也不会与旧空 `.lock` 混淆。

锁覆盖既有事务，revision 检查、临时文件写入及 fsync、原子 rename 和目录 fsync 保持不变。acquire 成功后持有 `FileHandle`；release 通过共享 Promise 幂等关闭该句柄，不 unlink、不 rename、不写 PID 或 uptime，也不按年龄回收或生成 quarantine。进程异常终止后由内核释放锁，后续 acquire 可以立即重获同一 key，锁文件 inode 保持稳定。

真实竞争 `EAGAIN`/`EWOULDBLOCK` 映射为 `DURABLE_LOCK_HELD`，其他 flock、打开、权限和类型错误均 fail closed 并保留 cause。不支持的平台和 `fs-ext` 缺失/加载失败分别报告 `DURABLE_LOCK_UNSUPPORTED_PLATFORM`、`DURABLE_LOCK_UNAVAILABLE`。`staleLockMs` 仅为构造合同兼容保留，不再影响所有权。

## 旧现场与迁移

新 writer 会先检查旧 `<key>.lock` 和 `<key>.lock.guard`。发现任一文件时报告 `DURABLE_LOCK_MIGRATION_REQUIRED` 并保留现场，不读取旧 PID、不按年龄清理，也不把旧空锁误判为新版稳定锁。新旧 writer 不支持在线混跑；锁行为仅面向 macOS/Linux 本地文件系统，不承诺 NFS/SMB 等共享文件系统语义。

迁移前必须停止同一存储根的全部旧 Host/child writer，保留 JSON 状态，针对该 scope 归档旧协议文件后统一启动新版，不能仅 `/reload`。新版 `.flock-v1.<key>.lock` 在运行或维护期间不得删除。代码修复与临时目录验证不等于历史生产现场已迁移，本次没有操作上述生产锁或状态。

## 验证记录

通过官方 npm registry 安装 `fs-ext@2.1.1`，在 darwin arm64 的 Node v26.8.1 和 Node v22.19.0 下分别执行原生 rebuild 与 addon 加载验证；安装链保持 `--ignore-scripts`，仅显式 rebuild `fs-ext`。Node 版本切换后必须重新构建，不能复用另一 ABI 的二进制。

既有 durable 生命周期测试用真实 public acquire 创建锁，父进程确认竞争后向持锁子进程发送 `SIGKILL` 并等待退出，随后立即 acquire 并断言同一 inode、无 guard/quarantine；还覆盖并发及重复 release、旧协议现场保留和权限/类型拒绝。没有新增测试文件或 `test()` 条目。Node 22.19.0 与 Node 26.8.1 均通过生命周期 9/9；Node 26 上调用方 focused 回归 28/28、package 回归 8/8、根/package typecheck 及 `git diff --check` 通过。Linux 实机尚未验证。
