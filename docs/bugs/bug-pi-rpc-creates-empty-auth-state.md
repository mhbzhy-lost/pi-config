# Bug：真实 Pi RPC 验证产生空 auth 状态未被报告

## 1. 现象

真实 Pi `0.80.6` RPC 集成测试通过后，`pi/auth.json` 被创建为权限 `0600`、内容为空对象
的本地状态文件。该路径已被 `.gitignore` 忽略，因此 `git status` 没有显示它，执行报告
错误声称未产生 `auth.json`。

## 2. 影响

- 验证报告与磁盘真实状态不一致。
- 使用 Git status 证明“没有运行时文件”会漏掉所有被忽略路径。
- 如果未来测试脚本尝试清理该文件，可能误删用户真实登录凭据。

## 3. 稳定复现

在不存在 `pi/auth.json` 时运行：

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:integration
```

测试通过后，Pi 配置根出现 mode `0600` 的 `pi/auth.json`。当前未登录环境中的 JSON 为
空对象。

## 4. 证据

- Shell 集成固定 `PI_CODING_AGENT_DIR=<repo>/pi`，真实 RPC 测试通过同一入口启动 Pi。
- 文件创建时间与真实 RPC 测试执行时间一致。
- 文件大小为 2 bytes，JSON 顶层对象没有键。
- `.gitignore` 明确忽略 `/pi/auth.json`，所以 Git status 不展示它。
- `var/sessions` 仍不存在，`--no-session` 生效。

## 5. 根因

Pi 的认证存储在启动时会初始化 `auth.json`，即使 API key 来自环境变量且没有执行登录。
问题不在 Pi 行为，而在验收方法错误地用 Git status 推断被忽略运行时路径不存在。

## 6. 处理与验证策略

- 将 `pi/auth.json` 视为 Pi 配置根中的预期本地状态，继续保持 Git 忽略。
- 集成测试和清理脚本禁止删除或覆盖该文件，避免破坏真实凭据。
- 文档明确真实启动可能创建 `auth.json`，但不会提交。
- 验证 session 时直接检查 `var/sessions`，不再使用 Git status 代替磁盘检查。
