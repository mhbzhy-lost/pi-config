---
name: exa-search
description: 仅在用户明确要求使用 Exa 搜索或抓取网页时使用（例如「用 Exa 搜索…」「用 Exa 抓取这个链接」）。未指定供应商的联网搜索与网页抓取默认使用 deepseek-search；基于 Exa 官方 REST API 的直接 HTTP 调用。
---

# Exa 网页搜索与正文抓取

直接调用 Exa 官方 REST API：固定端点 `https://api.exa.ai/search`（搜索）与 `https://api.exa.ai/contents`（抓取正文）。wrapper 不包含 MCP、JSON-RPC 或 SSE 相关实现，也不暴露任何旧网关工具名；search/fetch 均原样返回服务端的结构化 REST JSON，不做摘要改写，数据展示由调用方处理。

## 何时使用

仅在用户明确要求使用 Exa 时使用本 skill。未指定供应商时，使用 `deepseek-search`；不要因其他搜索工具失败而自动切换到 Exa。

## 前置条件

- Python 3.9 或更新版本。
- `EXA_API_KEY`：优先读取进程环境变量；为空时脚本自动读取本 skill 目录下 gitignored `.env` 中的 `EXA_API_KEY`，无需 source 或重启 shell。没有匿名回退。
- key 只通过 `x-api-key` 请求头传输，不进入 URL、日志或错误输出；严禁打印 key、把 key 写入其他文件或提交到仓库。

## 命令

**搜索：**

```bash
python3 ~/pi-config/skill-overrides/exa-search/exa.py search "your query" [num_results]
```

- `query`：原样透传为请求体 `query` 字段，保留 `category:people ...` / `category:company ...` 前缀写法。
- `num_results`：可选，默认 `10`，映射为请求体 `numResults`。
- 请求体固定包含 `type: "auto"` 与 `contents: {"highlights": true}`。

**抓取正文：**

```bash
python3 ~/pi-config/skill-overrides/exa-search/exa.py fetch "url1" ["url2" ...]
```

- 请求体为 `urls` + `text: {"maxCharacters": 3000}`。
- `maxCharacters`（Python 参数 `max_characters`，默认 `3000`）是每个 URL 返回正文的**字符上限，超长即截断**，不是全文保证；需要更多内容时调大该值，或先用搜索结果定位再分段抓取。
- Python API：`fetch(urls=[...])` 或 `fetch(ids=[...])`（二选一，不可同时提供），可另传 `max_characters` 与 `proxy_port`。

## 返回形状

- search：服务端结构化 JSON 原样返回，顶层常见字段 `requestId`、`results`（每条含 `title`、`url`、`publishedDate`、`highlights` 等；字段以服务端实际返回为准）。
- fetch：顶层常见字段 `results`（每 URL 的正文与元数据）与逐 URL 的 `statuses`。`statuses` 为每个目标保留独立成功/失败状态，必须逐条检查，不要假定全部成功。
- 旧版网关调用会把结果压缩成单段 markdown 文本（`result.content[0].text`）；现在返回结构化 JSON 字段，调用方自行读取所需字段。

## 与旧版网关调用的行为差异

- `category:people/company` 前缀随 `query` 原样提交，由 REST 服务端解释；其对过滤组合的解释与旧网关可能存在差异，结果不符预期时可改写 query 或调整 `num_results`。
- 旧文档中"抓取全文"的表述不再成立：fetch 返回正文始终受 `maxCharacters` 截断上限约束。

## Query Tips

用描述性短语而非关键词：

- 推荐：`blog post comparing React and Vue performance 2024`
- 不推荐：`React vs Vue`

人物/公司搜索可用 category 前缀：

- `category:people John Doe software engineer`
- `category:company Stripe payment processing`

## 独立代理

Exa 请求单独使用本机 HTTP 代理 `127.0.0.1:7897`（每次调用构建独立 opener），不读取宿主 `https_proxy` 等环境代理，也不影响其他工具的代理设置。宿主代理端口不是 `7897` 时，agent 可在**该次调用**前通过 `EXA_PROXY_PORT` 覆盖（仅接受十进制端口 `1`–`65535`）：

```bash
EXA_PROXY_PORT=8888 python3 ~/pi-config/skill-overrides/exa-search/exa.py search "your query" 5
EXA_PROXY_PORT=8888 python3 ~/pi-config/skill-overrides/exa-search/exa.py fetch "https://example.com"
```

端口覆盖只对这条命令生效；不设置时仍使用 `7897`。程序调用 `search`、`fetch` 时可传入 `proxy_port` 整数参数覆盖。若代理不可用，应核对宿主实际端口并在调用时覆盖；不要为此设置全局代理，也不要读取或输出密钥。

## 限制与错误处理

- 请求超时 30 秒；响应上限 1 MiB，超限直接报错。
- 目标 host 固定为 `api.exa.ai`，不接受任何输入改写；跨域重定向会被直接阻断，认证头不会随重定向发往其他主机。
- 失败时 stderr 只输出安全类别、HTTP 状态码与受控格式的 request id（如存在），不包含 key、请求头、URL userinfo 或响应原文；wrapper 不打印日志。
- 常见类别：`authentication_error`（401/403，检查 key 有效性）、`payment_required`（402，检查配额/计费）、`rate_limited`（429，稍后重试）、`client_error` / `server_error`（检查参数或稍后重试）、`network error`（代理或网络不可达，核对 `EXA_PROXY_PORT`）。

## 工作流

1. 先 `search` 获取候选 URL 与 highlights
2. highlights 不足以判断时，再 `fetch` 正文（注意 `maxCharacters` 截断上限）
3. 综合结果后向用户呈现；不把原始结果改写成摘要再丢弃结构
