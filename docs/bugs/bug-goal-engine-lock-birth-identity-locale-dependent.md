# Bug：writer lock 出生身份受 locale/TZ 影响

## 1. 现象

持有 writer lock 的进程仍存活时，来自不同 locale 或时区的竞争者把它隔离为陈旧锁并取得 replacement。

## 2. 触发条件

owner 在非 `C` locale 或非 UTC 时区发布由 `ps -o lstart=` 得到的原始字符串，竞争者在另一套环境中比较该字符串。

## 3. 根因

`lstart` 是展示格式而不是环境无关的身份；`LC_ALL` 与 `TZ` 会改变同一 PID 的输出。把调用环境相关的原始值持久化导致 live/dead 判断不一致。

## 4. 影响范围

writer lock 与 recovery guard 都可能误删存活 owner，破坏单 writer 与事件日志原子性。

## 5. 修复方案

查询 `ps` 时显式使用 `LC_ALL=C`、`TZ=UTC`，只持久化该规范值；本进程身份模块级安全缓存一次。探测失败保持 unknown/fail closed。

## 6. 验证方案

真实子进程 A 在非 UTC（locale 可用时亦非 C）环境持锁，C/UTC 子进程 B 竞争必须超时，最终 token 仍属于 A；保留 PID 重用与 crash 恢复测试。
