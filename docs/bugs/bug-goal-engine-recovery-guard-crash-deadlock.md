# Bug：recovery guard owner 崩溃造成永久死锁

## 1. 现象

进程取得 `.writer.recovery.guard` 后若在 unlink 前退出，后续 `appendEvent` 只会等待 500ms，最终持续抛出 `GOAL_ENGINE_STORE_LOCK_TIMEOUT`。

## 2. 触发条件

任一 writer 在取得 recovery guard 后崩溃、被杀死或异常退出，且 guard 文件保留在 state root。

## 3. 根因

旧协议用 `writeFileSync(..., flag: "wx")` 先创建最终 guard，owner 元数据不含 `createdAt`，竞争者也不读取或判定 owner 是否死亡。因此崩溃遗留 guard 没有恢复路径；先创建最终路径再填 owner 还存在发布窗口。

## 4. 影响范围

同一 state root 的 writer lock 获取、发布、陈旧锁清理和释放均被永久阻塞，所有后续 append 失败；事件、projection 和 registry 不会继续推进。

## 5. 修复方案

在同一文件系统创建写完 `pid`、`token`、`createdAt` 的 candidate 文件，再以原子 no-clobber link 发布 guard；每次调用清理自己的 candidate。竞争者仅隔离可证明死亡的合法 owner，或不可能由合法发布产生的元数据；新鲜且身份不明或存活 owner 保持 fail closed。释放按 token 复核。

## 6. 验证方案

子进程取得 guard 后不释放即退出，父进程 append 必须恢复成功，并且 guard、candidate、quarantine、tmp 均无残留；旧 receipt 不得删除 replacement guard，live guard 必须有界超时且保留原 owner。
