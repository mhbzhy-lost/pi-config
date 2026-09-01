# Playwright 持久认证 profile 与 AF_UNIX 路径问题

## 现象

Playwright MCP wrapper 仅能启动 MCP 默认的临时 profile，无法通过安全名称创建并复用专用持久 profile。需要跨 headed/headless 会话保留站点认证状态时，调用方没有一等入口。

同时，wrapper 把任意 `--instance` 原样拼入临时状态目录，再在其下创建 `server.sock`。macOS 的 AF_UNIX socket 路径有较短的字节上限；当临时目录前缀与 instance 名组合后超过限制，`bind` 会抛出 `OSError: AF_UNIX path too long`。当前失败发生在 daemon 启动之后，既不稳定，也可能留下状态文件。

## 根因与修复边界

- instance 缺少集中式字符、长度和最终 socket 编码长度校验。
- start/daemon 参数模型没有持久 profile；MCP 因而收不到 `--user-data-dir`。
- profile 必须由安全名称解析到仓库外的 `~/.pi/playwright-profiles/<name>`，不存在时以 `0700` 创建；复用时必须验证它是当前用户拥有、mode 精确为 `0700` 的真实目录且不是 symlink。
- 同一 profile 同时只能由一个 daemon 使用；stop、idle 回收和 state 清理都不得删除持久 profile。
- stop、stopall 和 idle 回收发送 SIGTERM 后必须等待 daemon 确认退出，才可清理对应 instance state；stopall 中单个实例未确认退出时保留其全部 state、继续处理其他实例，最终固定以 `stop-failed` 非零退出，且不升级为 SIGKILL。
- 所有拒绝信息使用固定 reason，不输出 profile 绝对路径、目录内容、MCP 原始 stderr 或认证材料。

## 无凭据边界

本修复只管理新命名目录本身及一个不承载认证数据的互斥锁，不会自动采用、读取、遍历、扫描、复制或修改 Chrome、Edge、既有 Playwright profile、Cookie 数据库、storage state、Token、Authorization 或其他凭据。本记录不包含浏览器数据或凭据。

## RED 预期

1. 合法 profile：当前实现不识别 `--profile`，不会创建 `0700` 目录，也不会向 MCP 传 `--user-data-dir`。
2. 非法名称及不安全目录：当前实现没有 profile 校验，无法拒绝 symlink、错误 owner 或错误 mode。
3. 生命周期：当前实现没有持久 profile，因此无法证明 stop 后目录保留。
4. 并发：当前实现没有按 profile 加锁，两个 daemon 可同时尝试使用同一目录。
5. instance：当前实现接受非法或过长名称，并会在校验前创建 state，长路径最终在 AF_UNIX `bind` 失败。
