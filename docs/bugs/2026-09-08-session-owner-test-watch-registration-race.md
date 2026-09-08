# Session Owner 测试 watch 注册观察竞态

## 分类

这是第 2 类：**测试制造的非预期数据/观察竞态**。受影响的是
`test/session-owner-runtime.integration.mjs` 的测试辅助函数 `waitForRecord`，不是
session-owner 的生产 registry、launcher 或 extension 数据合同。

## 实际入口与权威 identity

真实 PTY 场景从 `scripts/pi-launcher.zsh` 启动 Pi；launcher 以 owner ID 建立
registry reservation，`session_start` 再将其提交为 active。测试以
`readyPty()` 的 `PI_OWNER_READY` 输出作为 Pi 已就绪屏障，随后由
`waitForRecord()` 读取 `listLiveRecords(store)`。

权威 identity 是 registry 的 `ownerId`，并以同一 record 的 `state ===
"active"` 和非空 `sessionFile` 确认；不是 PTY 子进程 PID、输出文本、最近文件名
或测试的 `previous` 集合。生产 record 经 `prepareLaunch()` 和 extension lifecycle
写入，未发现手工拼造、错误 identity 或倒退状态。

## 事件顺序与首个偏离点

```text
waitForRecord: 首次 listLiveRecords() -> 未找到目标 record
测试 helper: fs.watch(store.root, callback) 尚在注册窗口
registry: pending/selecting -> active，并只产生这一次目录事件
测试 helper: watcher 尚未可观察该事件，后续没有事件
waitForRecord: 20 秒 watchdog 超时
```

首个偏离点是测试 helper 在首次空读取后把「已安装 watcher」误当作已覆盖该读取与
watch 注册之间的窗口；它没有在 watcher 安装后重新读取权威 registry。生产 registry
的原子 guard/publish 和 owner lifecycle 没有偏离其合同。

曾在未重新初始化的 Host 环境中观察到精确 PTY case 的空 registry timeout；该环境
状态不能用于 production 归因，已不作为本问题的证据。第二个受控 fixture 仅验证测试
观察 API 在 watcher 不交付事件且二次读取仍早于 active 时的行为，不声称真实 registry
会产生该数据。

## 受控 RED 与 GREEN 证据

新增回归 `waitForRecord 在注册 watch 窗口内变 active 且无后续事件时仍返回记录`
使用测试专用的完整观察 fixture：首次 `readRecords` 返回空；`watchDirectory` 注册时
将同一权威候选切换为 active；之后不调用 watch callback。旧 helper 不消费该受控
观察入口，测试在 250ms 以预期的 timeout RED；这不是概率性 PTY 失败。

补充回归 `waitForRecord 在 watch 不发事件且二次读取过早时周期重读 active record`：
前两次权威读取为空，第三次才返回 active，watch 永不回调。未安装周期重读时，它在
50ms 以预期 watchdog RED；这精确覆盖 macOS `fs.watch` 事件不可达的观察 fixture。

最终测试 helper 在 watcher 安装后立即再次 `ready()`，并以一个 25ms 的有界周期 timer
重读**权威 registry**，不延长原有 20 秒总 timeout，也不使用固定 sleep。`settled`
guard 统一 callback、二次读取、周期读取、timeout 与非 registry-unavailable error 的
完成路径；第一次完成时清理 watcher、timeout 和周期 timer。两条受控回归均 GREEN 并
断言 watcher 只关闭一次。

## B：fresh PTY 空 registry（来源未证实，未修复）

重新初始化并重启 Host 后，精确 `-c pins the exact free recent session` 的首次有界运行
仍有一次失败：`PI_OWNER_READY` 与 deterministic 输出已经出现，20 秒后权威
`listLiveRecords(store)` 为 `[]`，Expect wrapper 本身仍在等待输入。该现场排除了
单纯「watch 回调遗漏而 record 已存在」的解释，但没有提供 spawned Pi 的 EOF/退出码、
extension `session_start`/`session_shutdown` 标记或 launcher prepare 的完整因果链；因此
不能证明是 production 可达缺陷，也不能证明是 PTY fixture/环境污染。

按来源未证实门禁，此信号 fail closed：未修改 production，未将它归入本次已修复的
观察竞态，且真实 PTY 的重复与完整文件验收仍未满足。

## 结论

A 的已证实缺陷只在测试观察层遗漏事件，production 路径没有需要兼容的数据或 fallback。
不得修改 `src/session-owner/**`、launcher 或 extension 来掩盖 A。B 保留为独立、来源
未证实的现场，需在能保留完整 PTY/launcher/extension provenance 的后续任务中分类。
