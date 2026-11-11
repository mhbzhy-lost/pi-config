# Playwright 认证会话

本文件合并了原 `browser-auth-session` skill 的规则。

## 能力边界

支持：明确批准的 named profile、用户手动登录、exact origin 与非敏感业务壳验证、停止 headed 后复用 headless。

不支持：提取或导出 cookie/token/storageState、跨进程凭据交接、任意页面脚本、同源 fetch、自动填写密码/MFA。遇到这些需求停止并报告，不绕过本 skill 的安全边界。

## 认证流程

1. 明确目标 origin、任务专用 profile 名称和非敏感业务壳 locator。不扫描或猜测已有 profile。
2. 认证状态未知时，不能用 HTTP 200、页面标题或进程存活判断已登录。
3. 需要人工操作时，先停止同 profile 的 headless instance，再使用 `--headed --auth`。密码、MFA、恢复码和安全密钥必须由用户在浏览器中手动输入。
4. `--auth` 模式只允许 `navigate`、`auth-check`、固定 `aone-config-readonly` 的 `verify`、`status`、`stop`；硬拒绝 snapshot、title、截图、tabs、fill 和 Aone `export`。登录阶段禁止截图、HAR、console、网络详情和 storage 导出。
5. 只导航正常的非签名 URL。认证完成后，仅验证 exact origin 和非敏感业务结构；`auth-check` 返回两个布尔值，不代表账号、租户或下游权限已验证。
6. 用户确认认证完成后，停止 headed instance，再用同一个 named profile 启动普通 headless；两个 instance 不得并发使用同 profile。
7. 任务结束 stop 自己的 instance。named profile 保留，不复制到其他机器、不擅自删除。

```bash
node "$CLI" --instance auth-task --profile task-sso start --headed --auth
node "$CLI" --instance auth-task command '{"op":"navigate","url":"https://app.example.com/"}'
node "$CLI" --instance auth-task command '{"op":"auth-check","origin":"https://app.example.com","authenticatedView":{"kind":"testId","value":"app-shell"}}'
node "$CLI" --instance auth-task stop
node "$CLI" --instance work-task --profile task-sso start
```

Aone 的登录完成检查可在固定 management 页面调用 `{"op":"aone-config-readonly","action":"verify"}`，仅返回固定成功状态或错误分类。该检查要求 app `332260` 的固定 top/唯一允许 schema frame 和唯一管理控件，不代表账号身份或导出权限。导出配置必须停止认证 instance，复用获批准的 profile 启动普通 instance，再按 [只读操作合同](operations.md) 指定单一环境；不读取或传递 profile、cookie、storageState 内容。

## 认证证据

只报告认证模式、批准的 origin、两个验证布尔值、关闭结果和残留风险。永远不报告 credential 值、headers、storage、签名 URL 或 profile 内容。若凭据进入输出、参数、日志或未授权进程，停止传播并报告影响与处理建议，不自动轮换或撤销。
