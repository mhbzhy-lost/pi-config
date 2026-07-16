# Bug：External Review Runner 协议不兼容

## 1. 现象

外部审查门禁无法按共享 hook 协议执行，导致真实 hook 不能获得待审查命令，或无法识别拒绝决策。

## 2. 影响

`git push` 前的外部审查可能被错误地 fail-open，审查日志也可能写入调用方项目目录而非 `pi-config` 根目录。

## 3. 稳定复现

使用 `.sh` hook 输出 `hookSpecificOutput.permissionDecision=deny`，并从标准输入读取 JSON 请求；旧 runner 通过 Node 启动该 hook、忽略 stdin 且只读取顶层字段，因此不会正确阻断。

## 4. 证据

当前 `external-review-runner.mjs` 使用 `spawn(process.execPath, [hookPath])` 和 `stdio: ["ignore", ...]`，决策解析为 `payload.permissionDecision`；`security-gates-extension.mjs` 未传递命令且将日志路径设为 `ctx.cwd/var/logs`。

## 5. 根因

迁移时保留了 Node 测试假 hook 协议，没有按共享 shell hook 的 stdin 请求格式、嵌套响应格式和配置根目录边界实现适配。

## 6. 修复与验证策略

改用 `bash <hookPath>` 执行并写入 `{tool_name:"Bash",tool_input:{command}}`；解析 `hookSpecificOutput` 决策，注入 hook、日志和配置根目录以便测试，补充脱敏、超时和有界缓冲测试，并回归 Node 与 Python uv 测试。
