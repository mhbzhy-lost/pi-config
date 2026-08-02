# Bug: Exa 搜索工具因缺少 API Key 触发免费额度限流

## 现象

调用 `exa.py search` 时返回 HTTP 403/429，搜索功能完全不可用。

## 根因

`exa.py` 直接请求 `https://mcp.exa.ai/mcp` 公共端点，未携带任何 API Key。
Exa 对无认证的免费 MCP 端点实施了速率限制（rate limit），当前共享额度已耗尽。

服务端返回明确错误信息：
> You've hit Exa's free MCP rate limit. To continue using without limits,
> create your own Exa API key.

## 影响范围

- `exa.py search` 和 `exa.py fetch` 均不可用
- 依赖该 skill 的一切网络搜索能力失效

## 修复方案

请求 URL 仅在每次 `mcp_call()` 执行时读取环境变量 `EXA_API_KEY` 并局部构造认证参数。key 必须为 1-256 个不含控制字符的字符，避免意外粘贴文件或换行形成异常 URL。源码不提供默认 key，也不在模块级常量中持有带凭据 URL；缺少或非法变量时在发起网络请求前明确失败。

每次请求只捕获一次 key，并把该值显式传给 URL 构造和所有诊断脱敏路径，避免请求期间环境变量轮换导致旧 key 漏过 redaction。只有长度至少 8 的 literal key 才执行全文替换，短测试值不会破坏普通错误文本；URL-encoded key 和 `exaApiKey=` 参数始终按模式脱敏。

Request 构造、网络调用、响应读取和 UTF-8 replacement decode 位于同一保护区。成功响应最多读取 1 MiB，多一个字节即明确拒绝，避免异常上游耗尽内存。HTTP 错误正文读取会把可识别底层 socket 的 timeout 临时限制为 5 秒；无法可移植地设置 timeout 的未知 stream 不读取正文，只保留状态码。诊断保留经过长度限制和 key 脱敏的安全摘要；URL/DNS/TLS 错误保留同样脱敏后的 socket reason。异常使用 `from None` 隐藏包含认证 URL 的上游 exception chain。malformed SSE JSON 也转换成脱敏 RuntimeError；非 SSE 响应只输出最多 500 字符的安全摘要，截断不会留下半个 `<redacted>` marker。

本机可以通过 shell 环境或被 `.gitignore` 排除的 `skill-overrides/exa-search/.env` 管理 key，但脚本本身只读取进程环境，不自动解析凭据文件。

## 验证方式

- 缺少、空白、含控制字符或超过 256 字符的 `EXA_API_KEY`：测试确认不会发起网络请求，错误信息明确指出变量问题。
- 请求间轮换环境变量：下一次 URL 使用新 key，不冻结模块导入时的值。
- 特殊字符 key：`+`、`&`、`=` 经过 URL encoding，encoded 形式出现在响应时同样脱敏。
- HTTP 失败：可识别 socket 的异常正文读取受独立 5 秒 timeout 约束；未知 stream 跳过正文，不退化为无界等待。诊断保留状态码和脱敏后的 quota/error 摘要，不包含测试 key。
- 成功响应：最多读取 1 MiB，超限时拒绝且不回显正文。
- 截断边界：500 字符限制不会输出残缺的 `<redacted>` marker，也不误删普通单个 `<`。
- URL/DNS/TLS 失败：保留脱敏后的底层 reason，不包含认证 URL 中的 key。
- Request 构造失败：包含 key 的底层消息被转换成脱敏诊断。
- Request/JSON serialization 失败：包含不可序列化参数时也转换成脱敏 RuntimeError。
- 正常 SSE：`event:` 与合法 `data:` JSON frame 返回预期 JSON-RPC payload。
- malformed SSE JSON：错误摘要保留定位信息但移除 raw/encoded key。
- 不可字符串化异常：诊断 helper 返回固定安全 fallback，不泄露上游上下文。
- 请求中轮换 key：错误仍使用该请求捕获的原 key 脱敏。
- 非 UTF-8/read timeout：转换成可操作的脱敏诊断，不抛出二次解码或未绑定变量错误。
- 短测试 key：不破坏普通诊断文本。
- 非 SSE 大响应：异常摘要被截断，避免日志放大。
- Headers：映射只读，避免长进程导入后被意外修改。
- User-Agent：保留非 Python 标识以避免 CDN 默认客户端拦截。
- 执行 `python3 skill-overrides/exa-search/test_exa.py`，预期全部通过。

## 预防

外部服务凭据不得写入源码、测试 fixture、文档或 Git 历史。缺少凭据时必须 fail closed 并输出可操作诊断，不能回退到共享 key 或匿名公共额度。
