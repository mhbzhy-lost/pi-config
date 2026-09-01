---
name: playwright
description: Use for browser UI/E2E automation, manual login, headed/headless browser workflows, or Playwright MCP interactions; also when needing to navigate, click, fill forms, take screenshots, extract content, or seeing "Server not running" or "No running instances" from playwright.py.
---

# Playwright Browser Automation

## Overview

Control a persistent Playwright MCP browser through `playwright.py` and its Unix-socket proxy.

**Core principle:** `start` -> discover runtime tools -> interact with `call` -> stop the exact instance you own. After authentication is complete, snapshot before element interaction.

## Auto-Recleaning (safety net)

Callers that crash or forget `stop` no longer leak processes forever. Two automatic layers keep stray daemons from piling up:

- **Idle timeout:** a daemon with no client connections for the idle threshold exits on its own and tears down the MCP/Chrome chain. Threshold resolution: `_daemon --idle-timeout <seconds>` > env `PI_PLAYWRIGHT_IDLE_TIMEOUT` > default **1800s (30 min)**.
- **Reap on start:** every `start` first stops other instances whose daemon is alive but idle past the threshold, then starts the new one.

You should still call `stop` explicitly when you are done — the safety net is a fallback, not a replacement.

## Lifecycle

```bash
SCRIPT=~/pi-config/skill-overrides/playwright/playwright.py
PROFILE=work-sso
AUTH_INSTANCE=my-task-auth
RUN_INSTANCE=my-task-headless

# Headed: navigate to a normal, unsigned application URL, then let the user complete SSO.
python3 "$SCRIPT" --instance "$AUTH_INSTANCE" --profile "$PROFILE" start
python3 "$SCRIPT" --instance "$AUTH_INSTANCE" call browser_navigate \
  '{"url":"https://app.example.com/"}'
# During authentication, validate only exact origin and non-sensitive business structure.
python3 "$SCRIPT" --instance "$AUTH_INSTANCE" call browser_evaluate \
  '{"function":"() => ({ onExpectedOrigin: location.origin === \"https://app.example.com\", authenticatedView: Boolean(document.querySelector(\"[data-testid=app-shell]\")) })"}'
python3 "$SCRIPT" --instance "$AUTH_INSTANCE" stop

# Headless: only after the headed instance has stopped, reuse the same profile.
python3 "$SCRIPT" --instance "$RUN_INSTANCE" --profile "$PROFILE" start --headless
python3 "$SCRIPT" --instance "$RUN_INSTANCE" tools
python3 "$SCRIPT" --instance "$RUN_INSTANCE" call browser_navigate \
  '{"url":"https://app.example.com/"}'
python3 "$SCRIPT" --instance "$RUN_INSTANCE" call browser_snapshot
python3 "$SCRIPT" --instance "$RUN_INSTANCE" stop
```

## Browser Mode Policy

- 默认使用 `headless` 模式。
- 仅当用户需要手动登录，或用户明确要求使用 headed/前台模式时，才可使用 headed 模式。
- **REQUIRED SUB-SKILL:** 需要建立、刷新、验证或交接认证状态时，必须使用 `browser-auth-session`；此处不重复其凭据最小化与安全交接流程。获取登录态后，立即使用 headless 模式继续任务。
- 已有登录态，或无需用户干预时，禁止自行使用 headed/前台模式。
- 交接过程不得输出或返回 cookie、token、授权头或其他凭据；只返回脱敏状态、计数或业务结果。

## Persistent Auth Profiles / SSO

- `--profile <safe-name>` 接受安全名称而不是路径；不得猜测或传入 `--user-data-dir`。wrapper 将名称解析到仓库外的私有目录，并要求目录由当前用户拥有、mode 精确为 `0700`、为真实目录且不是 symlink。
- profile 是持久认证材料：`stop` 只停止 owned instance，不删除 profile。wrapper 对每个 profile 加锁；同一 profile 的 headed 与 headless instance 绝不能并发，锁冲突必须 fail closed。
- 没有 approved profile 时，停止尝试并建立任务专用的命名 profile。不得扫描或采用现有 profile，不得使用个人 Chrome 主 profile，不得复制 profile 目录，也不得默认导出 `storageState`、Cookie 或 localStorage。
- 认证阶段只导航到正常、非签名 URL，并由用户手动完成 SSO。不得请求或自动填写密码、MFA、恢复码或安全密钥；认证失败时停止，不得继续自动尝试。
- SSO/登录阶段禁止 snapshot、截图、HAR、network request details、console 以及任何 storage/Cookie 导出。先仅以 exact origin 和非敏感业务结构做 sanitized 验证；认证完成后，停止 headed instance，才可用同一 profile 启动新的 headless instance 并进行普通页面交互。

`npx -y @playwright/mcp` is not version-pinned. The target instance's `tools` output is authoritative. If a documented name is absent, do not guess an alias; inspect `tools` and the installed `@playwright/mcp` README.

When there is only one instance, the wrapper auto-selects it. With multiple instances, every `call`, `tools`, `status`, and `stop` must include `--instance <name>`. Use `instances` to discover names. Do not use `stopall` when another task may own a browser.

## Interaction Pattern

```bash
python3 "$SCRIPT" --instance "$INSTANCE" call browser_snapshot
# Use refs from that snapshot; re-snapshot after page transitions.
python3 "$SCRIPT" --instance "$INSTANCE" call browser_click \
  '{"element":"Submit","target":"e123"}'
```

Use `browser_wait_for` on a page condition before re-snapshotting slow pages. Never guess refs.

## JavaScript Vs Playwright API

`browser_evaluate` runs JavaScript in the page. It can access `document` and same-origin `fetch`, but not `page.context()`:

```bash
python3 "$SCRIPT" --instance "$INSTANCE" call browser_evaluate \
  '{"function":"() => document.title"}'
```

Current MCP `0.0.78` names arbitrary Playwright execution `browser_run_code_unsafe` (not `browser_run_code`). It receives `{"code":"async (page) => ..."}` or `{"filename":"/abs/script.js"}`:

```bash
python3 "$SCRIPT" --instance "$INSTANCE" call browser_run_code_unsafe \
  '{"code":"async (page) => ({ title: await page.title(), cookieCount: (await page.context().cookies()).length })"}'
```

This tool is RCE-equivalent in the MCP server process. Prefer structured browser tools. Use it only when page/context APIs are required, keep code bounded, and never return cookie values, authorization headers, tokens, or other credentials in the tool result. Return counts or status only and transfer secrets directly to an approved in-memory consumer.

## Runtime Tools

Always verify names with `tools`. The current MCP exposes these groups:

| Purpose | Tools |
|---|---|
| Navigate and inspect | `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_find`, `browser_tabs` |
| Interact | `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_drag`, `browser_drop` |
| Browser state | `browser_wait_for`, `browser_resize`, `browser_handle_dialog`, `browser_file_upload`, `browser_close` |
| Evidence | `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_network_request` |
| Code | `browser_evaluate`, `browser_run_code_unsafe` |

`browser_network_request` can expose request headers and bodies. Do not retrieve or print credential-bearing request details unless the output path is approved and redaction is enforced.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Calling `browser_run_code` from older examples | Run `tools`; current name is `browser_run_code_unsafe` |
| Using `browser_evaluate` for `page.context()` | Use the runtime's Playwright code tool |
| Calling element tools before a snapshot | Snapshot first and use its exact ref |
| Using headed mode without user interaction | Start with `--headless` |
| Omitting `--instance` with multiple browsers | Select the owned instance explicitly |
| Stopping all instances after one task | Stop only the exact instance you started |
| Returning cookies or auth headers | Keep values in memory; return only sanitized status |
