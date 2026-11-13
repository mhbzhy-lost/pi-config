# browser 浏览器自动化

本工具使用本机系统 Google Chrome 和受限 Playwright runtime，默认 headless，不经过 MCP，不下载 bundled browser。所有操作都通过 `browser` tool 的 action/参数完成；不运行外部 CLI，不允许任意脚本或页面 JavaScript。

## 最小生命周期

1. 使用 `action: "start"` 创建自己拥有的 instance；普通任务不传 `headed`/`auth`。
2. 使用 `action: "command"` 并传安全命令对象，例如 `{"op":"navigate","url":"https://example.com/"}`。
3. 页面交互先 `snapshot`，再使用已确认的 locator；页面跳转后重新 snapshot。
4. 任务结束使用 `action: "stop"` 停止自己拥有的 instance；不停止其他任务的浏览器。
5. 需要查看所有实例时使用 `action: "instances"`，不通过文件、PID 或 socket 猜测实例。

`start` 只有 SDK 实际创建 browser/context/page 并完成 `about:blank` smoke 后才成功；无可见窗口是 headless 的正常表现。跨命令操作共享同一 instance。

## 按场景读取详细文档

- snapshot、locator、表单、tabs、截图、Aone 只读导出：`docs/operations.md`
- SSO、手动登录、认证 profile、headed→headless 交接：`docs/authentication.md`
- Chrome 缺失、启动失败、profile 锁、daemon 清理：`docs/diagnostics.md`
- 修改或验证 browser runtime、安装依赖、运行测试：`docs/maintenance.md`

## 总是适用的安全边界

- 默认 headless；headed/auth 仅用户明确要求前台或手动登录时使用。
- 不扫描、猜测、复制个人 Chrome profile；profile 只接受安全名称，目录必须当前用户所有、真实目录、`0700`。
- named profile 并发使用时 fail closed；stop 保留 named profile。临时 profile 只由本次 instance 创建并在确认关闭后删除。
- 不输出 cookie、token、授权头、storageState、密码、MFA、签名 URL 或页面中的凭据材料。
- 不提供任意 `evaluate`/`run-file`、同源 fetch、网络详情、MCP 或跨进程凭据交接；超出当前安全命令边界时停止并报告。

## 结果与故障

返回值是固定安全结果 schema；snapshot/title 可能包含业务页面文字，不是秘密检测器。`stop-unconfirmed` 时保留权威现场和租约，不抢占、不按裸 PID 清理。认证完成、签名/导出完成、安装完成和业务运行正常是不同阶段，报告实际完成阶段。
