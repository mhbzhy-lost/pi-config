# Bug: 默认 pi 未进入终端独占屏幕

## 现象

用户运行 `pi` 后仍能看到启动前的 shell 历史；只有不易发现的 `pi-full` 命令会发送 alternate-screen 控制序列。

## 影响

默认交互入口没有提供约定的独占全屏体验，长会话与原 shell 输出混排；用户会误判全屏功能未安装或 iTerm2 不支持。

## 根因

`scripts/pi-shell.zsh` 的 `pi()` 只转发到上游二进制。进入 `\033[?1049h` 和退出 `\033[?1049l` 的逻辑只写在独立 `pi-full()` 中，默认入口从未调用它。

## 促成因素

1. 测试只验证 `pi-full` 输出控制序列，没有验证默认交互入口。
2. 文档把 `pi-full` 作为额外命令，但用户需求是 Pi 默认独占屏幕。
3. 缺少明确的 inline escape hatch，导致实现不敢改变默认入口。

## 修复方向

交互式 TTY 中的 `pi()` 默认进入 alternate screen；非 TTY 保持普通输出。增加 `pi-inline` 保留内联模式，`pi-full` 保留强制全屏能力。

## 防复发

测试通过可控环境开关模拟 TTY，断言 bare `pi` 的 enter/restore 序列；同时断言非 TTY 和 `pi-inline` 不输出控制字符。
