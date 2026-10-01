# 波 2Y coordinator / broker / queue 静默异常根因

## 根因
本轮审计发现 coordinator transport、恢复队列、持久化与 UNIX socket 启动路径把可诊断的原始异常压成静默或布尔值：协议回复解析异常未结束 pending waiter；进程活性检查把 ESRCH、EPERM、ps 故障和身份不匹配折叠为死亡；chmod 在 `listening` 事件之后异步执行且失败被忽略；持久化与 proof replay 失败未携带 cause。

## 生成调用链与安全事实
- coordinator client `socket.data` → `JSON.parse/parseCoordinatorReply` → catch；连接不关闭时 `pending` 永久保留，阻塞 Root Broker proof sink。
- integration queue `recoverClaims` → `processAlive` → `process.kill`/`ps`；原实现 false 直接回收 admitted claim，EPERM/ps 故障可抢占存活 owner。
- coordinator server `server.listen` → `listening` → 异步 chmod；事件已经表示 socket 对外监听，chmod 失败仍继续服务。
- durable storage/read/lock 和 proof outbox replay 捕获异常后重新抛出统一错误或保留 pending，却不保留 cause/诊断。

## 分类
这些路径均可由公开 coordinator/client/queue/storage 入口在正常生产事件序列触发，属于预期 production 数据未正确处理（不是测试污染）。修复只增加可诊断性或按 B7/B8/C5 已拍板决策 fail closed，不放宽既有安全判定。

## 2026-10-01 回归：旧 lock 与死 PID 的取证和分类
`test/coordinator-registry-lock.test.mjs` 是公开 registry `claim` 路径的合法生产形态：Git commonDir 下 lock 可由旧版写成无 owner 的文本，或记录合法 PID+birth 后该 PID 退出。入口 `createCoordinatorRegistry().claim` → `open(lock, "wx")` EEXIST → `lockOwnerIsDead` → `captureProcessBirthIdentity` → `ps`。测试用 `pid=999999999`；现场 `ps -ww -p 999999999 ...` 报 `ps: process id too large`、exit 1、包装的 cause.code=1，不是 ESRCH；但 `process.kill(999999999,0)` 明确抛 ESRCH。波 2Y 把 ps 错误（未再 signal 取证）归 undetermined，使 `lockOwnerIsDead` 永远返回 false，`claim` 每 10ms 重入，前一用例结束后第二用例 pending，TAP 不打印第二条；不是第一用例 cleanup 或 handle 泄漏。另：格式非法的旧 lock 属无可比身份的 legacy 数据，应按原 TTL 而非判断 identity mismatch/undetermined；只有合法身份但信号与 ps 均不能证明死亡时 fail closed。以上是生产入口可达的旧版兼容及死 PID，非 fixture 拼造的状态；精确 RED `/tmp/wave2y-regression-red.log`，GREEN `/tmp/wave2y-regression-green.log`；metadata 同源 RED `/tmp/wave2y-metadata-red.log`。

## 实施约束
B7 仅 ESRCH 视为 dead；B8 三态且 recoverClaims 对 undetermined 按 alive；C5 监听后 chmod 失败关闭 server 并抛出携 cause/path/期望与实际 mode 的错误；A6 malformed reply failPending 并销毁连接。未获决策覆盖的审计项不改变判定。
