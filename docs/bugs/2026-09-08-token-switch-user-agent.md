# Pi Token Switch User-Agent 不匹配导致 401

## 现象

Pi 通过 Token Switch 调用三个 `mode-*` provider 时返回 `401 proxy_error`。受控转发器指出请求的 `User-Agent` 与 OpenCode 请求不匹配。

## 影响

三个已同步的 Token Switch 模型均无法从 Pi 发起对话，请求在代理鉴权阶段失败；动态获取 Key、模型清单和其他 provider 不受此问题影响。

## 真实 OpenCode 捕获证据

在受控转发器中捕获的集团版 OpenCode 1.18.4 请求使用以下 `User-Agent` 并获得 HTTP 200：

`opencode/1.18.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`

对照之下，此前 Pi 默认 `User-Agent` 对三个 mode 均返回 401，代理错误明确为 OpenCode 请求的 `User-Agent` 不匹配。本文仅记录非敏感请求元数据，不包含 Key、令牌、Cookie 或 Authorization。

## 根因

`pi/scripts/sync-token-switch-to-pi.ts` 生成 Token Switch provider 时写入了动态 `apiKey`、模型和兼容性设置，但没有写入 `headers.User-Agent`。因此 Pi 使用自己的默认值，而不是受控代理认可的 OpenCode 标识。

## 修复

同步脚本为每个生成的 Token Switch provider 固定写入已验证的完整 `headers.User-Agent`。该值按当前已验证合同固定，不随 OpenCode 版本自动变化；动态 Key、models/settings 同步及非 Token Switch provider 行为保持不变。

## 验证

1. 回归测试覆盖新生成 provider 及缺少该字段的旧受管 provider 迁移；12 个测试全部通过，`tsc --noEmit` 通过。
2. 使用真实 OpenCode 配置同步后，确认当前三个 Token Switch provider 均含目标 `User-Agent`，且 `models.json` 与 `settings.json` 不含旧 `tokenhub` 引用。
3. 已经通过 Pi 对三个当前 provider/model 各发送一次无工具、全新会话、无重试的最小 prompt `只回复 TOKEN_SWITCH_SMOKE_OK`。第二个模型精确返回固定字符串；第一和第三未精确返回。
4. smoke 记录包装脚本在每次 Pi 进程结束后因本机 `date +%s%3N` 不支持而失败，未能保留各 Pi 进程退出状态和耗时。为遵守不重试限制，未再次发起请求；临时输出和错误文件已删除，未显示其内容。
