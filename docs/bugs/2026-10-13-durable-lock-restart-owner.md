# 重启后 supervisor 持久锁误判与 owner 回收边界

## 来源分类

**类别1：预期 production 入口下的资源恢复缺陷。** 用户提供真实Host重启的 extension_error：`beforeUpstreamSessionStart → supervisorControlPlane.ready(rootSessionId) → transaction → DurableStorage.acquireLock → DURABLE_LOCK_HELD`。不是手工拼接projection/event，也不是fixture缺字段。

## 现场与首个偏离点

- 当前 `PI_SESSION_ID=01a128bd-09eb-768f-8f24-bcad08e9f7cc`，sha256为 `6a6adb0e46ac338ffd1c1e0a2dc9b11db4477aaf24ee0166bd903d3ec0da41d0`，对应 `var/workspaces/supervisor-control/supervisor-<该digest>.lock`。
- 只读锁元数据：owner `2e1312bb-7ccb-4701-80e7-738cce78f0b8`，processBirth `9780:191881.090653083`，mode 0600；诊断时mtime已老化数分钟。`kill(pid,0)` 对9780得到ESRCH，ps亦无该PID。
- 数据生成链：DurableStorage通过`writeFile(wx)`创建包含随机owner与`pid:uptime`的锁；公开supervisor事务finally调用release；进程异常退出或未完成release时文件可以正常残留。用户重启沿同session hash进入相同持久目录。
- 失败栈证明报错时锁mtime尚处60秒窗口；无法反推出具体异常退出时间或为何原owner未release。原进程日志未读取，不猜测是何种退出原因。
- 首个偏离：`durable-storage.ts` EEXIST分支只根据mtime分类：<=60秒拒绝，>60秒rename隔离，未核实owner是否存活；supervisor事务只重试5秒，因此正常快速重启可能无法恢复。反面风险：仍存活的长事务也可能仅因mtime过期而被抢锁。

## 最小修复

- 新锁显式记录pid，保持读取既有合法`processBirth: pid:uptime`的路径；无法解析/权限不符/无存活证明一律fail closed。
- 仅 `process.kill(pid,0)` 明确ESRCH时回收；PID仍活（包括复用）或EPERM/其他探测失败不抢，不用mtime代替死亡证明。
- 创建、回收和释放共用独立exclusive mutation guard，取得后读取当前lock；避免两个回收者把替换锁移走。guard本身来源不明或残留时保留并报阻塞，不盲删；中途进程退出可能留下guard，首版对此fail closed，不虚称全部崩溃窗口自动恢复。
- 隔离而不删除旧锁；release只删除本owner文件，失败不能悄悄当成功。

## 验收

使用生产公开API生成临时锁：活子进程acquire后由测试明确结束子进程，立即让fresh supervisor plane.ready恢复；验证新鲜死锁可恢复、老化活锁拒绝、未知/损坏锁拒绝、并发回收最多一个持有者、旧release不能删除新锁。非法fixture只验证拒绝，不为之新增production兼容。

## 未知/处置限制

当前错误重复来自两个startup handler等待同一ready，不证明双Host同时持有同session。现场有多个Pi进程，但未扫描其session内容、未停止任何进程。仅授权处理当前session、owner已证实死亡的精确锁；其他session锁及零字节不明锁保留。不增加无限等待、PID杀进程、全局锁清理或上游fallback。

## 实现与验收记录

- production只改 `packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts`，supervisor业务状态/身份围栏未改；原生Node TS入口与package/root noEmit均通过。
- `test/durable-lifecycle.test.mjs` 通过真实子进程public acquireLock创建残留锁，再明确结束该子进程（内核ESRCH），验证fresh supervisor.ready即时恢复、活锁老化拒绝、并发恢复/nonce释放、旧writer合法schema与坏数据拒绝。
- `test/subagent-authority-retry.test.mjs` 原fixture伪造`parallel-birth`触发3项失败。数据来源分类2：只修fixture为public DurableStorage实际创建活锁，不增加production假birth兼容。test.after顺序必须release后rm临时目录，也只修harness。
- durable/authority/supervisor/replay/broker六文件专项 **68/68** 通过，日志 `/tmp/durable-lock-fix-regression.log`。
- 全仓`npm test`仍有4项既有失败（init-pi、joint-upgrade write返回对象、两项英文工具文案断言），同此前HEAD基线；本次为1162 tests/1157 pass/4 fail，无新增相关锁失败。日志 `/tmp/durable-lock-fix-full.log`，不称全仓GREEN。
- 恢复现场前再次read精确锁得ENOENT：原锁已由另一次运行隔离到 `...lock.quarantine-1791877210089-8387d648-05b9-4410-a9e6-4dd76f20b611`，其中仍为owner `2e1312bb-7ccb-4701-80e7-738cce78f0b8`/PID9780。不能把此隔离归因于本轮手工操作；首次恢复脚本在read阶段停止，没有删/改资源。
- 随后仅对当前session的精确key调用修复后的public acquire/release探针，通过；supervisor状态JSON字节前后相同，`.lock/.lock.guard`不存在，quarantine未删除。其他session资源未动。
- 实际完整Host extension重新加载未在本轮执行；需要用户fresh Host核验，不把public ready临时测试或精确lockProbe冒充真实Host启动成功。未提交commit。
