# Pi Adapter 安装状态并发写入损坏或丢失目录

## 1. 现象

两个进程同时向同一 r2cRoot 安装 adapter 时，state 可能出现 JSON 半写、最后写入覆盖前一目录，或残留临时路径。

## 2. 触发条件

不同 `PI_CODING_AGENT_DIR` 的安装请求并发执行，且它们读取旧 state 后交错写入。

## 3. 根因

state 通过直接写文件更新，且 install/remove 之间没有同一 r2cRoot 的跨进程互斥；读取、合并、写入不是一个临界区。

## 4. 影响范围

安装状态无法被后续卸载完整消费，可能遗漏已注册目录；进程在写入中断时还会留下不可解析 state。

## 5. 修复方案

state 先写同目录临时文件，再使用 rename 原子替换；以带过期恢复和有界等待的独占 lock 串行同一 r2cRoot 的 install/remove，释放时清理 lock 与临时文件。

## 6. 验证方案

并发安装两个不同目录，持续读取 state 均可解析，结束后包含两个目录且 integrations 下无 state tmp 或 lock；模拟 state 写失败时断言旧 state 不变。
