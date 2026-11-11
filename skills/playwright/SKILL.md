---
name: playwright
description: Use when automating browser UI/E2E tasks, starting headed or headless Chrome, navigating pages, performing browser interactions, handling manual SSO, or diagnosing browser startup and profile conflicts.
---

# Playwright 浏览器自动化

本 skill 通过相邻的 `playwright.ts` 直接调用 Playwright SDK；实现、依赖和二级文档均在本目录内。最低 Node `22.19.0`，使用系统 Google Chrome，不经过 MCP，不自动下载 bundled browser。

## 最小生命周期（直接使用）

```bash
# SKILL_DIR 是本 SKILL.md 所在目录的绝对路径。
CLI="$SKILL_DIR/playwright.ts"

# 普通任务：默认 headless，不会弹出窗口。
node "$CLI" --instance task-browser start
node "$CLI" --instance task-browser command '{"op":"navigate","url":"https://example.com/"}'
node "$CLI" --instance task-browser status
node "$CLI" --instance task-browser stop

# 只有用户明确要求前台或需要手动登录时才使用 headed。
node "$CLI" --instance task-login --profile task-sso start --headed --auth
node "$CLI" --instance task-login stop
```

`start` 只有在 SDK 实际创建 browser/context/page 并完成 `about:blank` smoke 后才成功；无可见窗口不是 headless 失败。跨命令操作共享同一 instance。每个操作必须指定自己拥有的 `--instance`；只 stop 自己的实例，不停止其他任务浏览器。全部命令输出单行 JSON，失败返回非零。

未安装 skill 依赖时，在 skill 目录执行：

```bash
(cd "$SKILL_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts)
```

## 按需加载二级文档

普通启动/停止只需阅读本页。遇到下列场景，再按需 read 对应文件；不要为普通页面启动任务预先加载全部文档：

| 场景 | 继续读取 |
|---|---|
| snapshot、locator、表单、tabs、截图、错误返回 | `docs/operations.md` |
| SSO、手动登录、认证 profile、headed→headless 交接 | `docs/authentication.md` |
| Chrome 缺失、启动失败、profile 锁、daemon 清理 | `docs/diagnostics.md` |
| 修改或验证本 skill、安装依赖、运行测试 | `docs/maintenance.md` |

认证流程已并入本 skill；不再加载或寻找独立的 `browser-auth-session` skill。认证任务必须先 read `docs/authentication.md`，其中的凭据最小化规则优先于普通操作说明。

## 总是适用的安全边界

- 默认 headless；`--headed` 仅用户明确要求前台或手动登录时使用。
- 不扫描、猜测、复制个人 Chrome profile；profile 只接受安全名称，目录必须当前用户所有、真实目录、`0700`。
- named profile 的并发使用会 fail closed；stop 保留 named profile。临时 profile 只由本次 instance 创建并在确认关闭后删除。
- 不输出 cookie、token、授权头、storageState、密码、MFA、签名 URL 或页面中的凭据材料。
- 不提供任意 `evaluate`/`run-file`、MCP 工具或跨进程凭据交接；遇到超出当前能力边界的需求停止并报告。
