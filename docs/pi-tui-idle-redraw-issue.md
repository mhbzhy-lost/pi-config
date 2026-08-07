# TUI 空闲时仍每秒重绘，导致常驻 Agent 机器持续耗能

## 摘要

Pi TUI 无论内容是否变化都会每秒重绘。在终端中长期运行多个 Pi Agent 的机器上，每个空闲会话都会保留约 1 Hz 的重绘循环。该问题已在 Apple Silicon M5、macOS、Pi 0.83.0 和多个空闲会话中复现。

## 复现步骤

1. 在终端中启动一个 Pi TUI 会话。
2. 不进行交互，也不运行任务，等待会话完全空闲。
3. 观察 PTY 的写入时间：

```text
$ for i in 1 2 3 4; do date +%H:%M:%S; stat -f "%m" /dev/ttys000 /dev/ttys002 /dev/ttys003; sleep 1; done
17:10:53.496
  mtime=1786093853   mtime=1786093853   mtime=1786093853
17:10:54.506
  mtime=1786093854   mtime=1786093854   mtime=1786093854
17:10:55.516
  mtime=1786093855   mtime=1786093855   mtime=1786093855
17:10:56.527
  mtime=1786093856   mtime=1786093856   mtime=1786093856
```

三个会话均完全空闲，没有任务或输入，但其 PTY 仍每秒收到一次写入。其中一个会话运行五天只累计约 40 分钟 CPU 时间，说明业务本身基本无活动，固定重绘循环仍持续运行。

## 影响

在一台常驻 6 个 Pi 会话的 Agent 专用笔记本上，稳态测量结果如下：

- iTerm2：**17–25% CPU**，运行 9 天累计 25 小时 41 分钟 CPU 时间；
- WindowServer：约 **15.5% CPU**，持续合成终端重绘帧。

每个空闲 TUI 会话都会成为永久的 1 Hz 帧源。持续的显示链路活动还会增加电池模式下无法进入空闲睡眠的风险。

## 根因分析

- TUI bundle 的渲染循环由 spinner 或状态栏动画固定触发，没有 dirty check；即使新旧帧字节完全一致，也会写出完整帧。
- `@earendil-works/pi-tui` 的 `setProgress()` 会启动 `setInterval` keepalive，反复写入 OSC `9;4;3` 进度序列，与真实进度是否变化无关。
- 当前设置没有刷新频率选项；TUI 只暴露 `showHardwareCursor`。Extension API 也没有暂停或降低渲染频率的接口。

## 建议修复

以下任一方案都能显著改善：

1. **增加 dirty check**：当新帧与最后一次输出完全一致时跳过写入。动画内容变化时仍正常重绘，空闲时不再输出。
2. **允许配置刷新间隔**：增加 `refreshInterval` 设置或环境变量，供不需要平滑动画的常驻机器降低刷新频率。
3. **空闲时暂停 spinner**：没有活跃 LLM 或工具调用时停止动画循环，只响应真实事件重绘。

## 环境

- Pi 0.83.0（`@earendil-works/pi-coding-agent`）
- macOS 27.0，Apple M5，arm64
- iTerm2 3.6.11；tmux 和 SSH 终端预计也会受影响
