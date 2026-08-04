# Bug：writer lock 的 PID 重用误判旧 owner 存活

## 1. 现象

遗留的 writer lock 或 recovery guard 的 `owner.pid` 被操作系统重用后，后续 append 持续等待并以锁超时失败。

## 2. 触发条件

owner 进程退出后锁文件未清理，且该 PID 在后续进程中被重用；旧协议只以 `process.kill(pid, 0)` 判断 owner。

## 3. 根因

PID 不是跨进程生命周期的唯一身份。旧 owner 元数据没有稳定的进程出生身份，因此存活探测把重用 PID 的新进程错误视为原 owner。

## 4. 影响范围

writer lock 和 recovery guard 的陈旧恢复都会永久误判为 live，阻塞同一 state root 的全部事件追加。

## 5. 修复方案

owner 原子发布 `pid`、token、时间和稳定出生身份；恢复同时验证 PID 与出生身份。PID 存活但身份不匹配才可判定 dead。出生身份查询失败、元数据缺失或损坏均为 unknown，保持 fail closed，不隔离删除。

## 6. 验证方案

确定性构造 PID 等于当前存活进程、但出生身份不匹配的 writer lock 和 guard，append 必须恢复；真实匹配 owner 与 malformed owner 必须超时保留。并运行 20 轮陈旧并发和组合回归。
