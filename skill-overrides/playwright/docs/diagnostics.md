# Playwright 启动与清理诊断

## 先区分模式

- 默认是 headless，不弹窗是预期行为。
- headed 只在用户明确要求或手动登录时使用。
- `start` 成功的依据是 browser/context/page/about:blank/title smoke，不是 PID、socket 或“进程存在”。

## 常见错误

| 错误 | 处理 |
|---|---|
| `chrome-unavailable` | 准备系统 Google Chrome；不自动下载、换 browser 或把升级 SDK 当作修复 |
| `instance-in-use` | 选择自己新的 instance；不覆写或接管未知实例 |
| `profile-in-use` | 等 owner 正常 stop 或请求 owner 确认；不删租约、不因 PID 消失抢占 |
| `socket-path-too-long` | 报告私有状态根过长；不放宽安全预算或换公共 socket |
| `instance-unreachable` | 保留现场，先确认 owned instance 的状态；不停止其他浏览器 |
| `stop-unconfirmed` | 不宣称清理成功；保留 authoritative state/lease，交由 owner 处理 |

## 安全诊断顺序

1. 记录实际 CLI 命令、instance、profile 名称和错误阶段；不要记录页面内容或认证材料。
2. 确认是否使用了本 skill 的 `playwright.ts` 和 skill 自有依赖；不要调用旧 Python 文件、MCP、`npx` 或 `_npx` 缓存。
3. 检查目标 profile 是否是明确批准的 named profile、owner 当前用户、真实目录、`0700`；不要扫描其他 profile。
4. 只检查本次 owned instance 的状态和清理结果；不使用 stopall、不发送裸 PID 信号。
5. 如果仍无法确认来源，fail closed，报告首个偏离点和调用链，不添加自动 fallback。

## 版本和浏览器资源

Playwright SDK 版本由本目录 `package-lock.json` 固定。升级包不会自动安装系统 Chrome，也不会解决 profile、socket、权限或架构问题；先收集错误证据，再单独评估升级。
