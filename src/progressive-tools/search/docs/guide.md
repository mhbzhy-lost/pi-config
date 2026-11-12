# DeepSeek 网页搜索与正文抓取

直接调用 DeepSeek 官方独立 REST API：固定端点 `https://api.deepseek.com/v1/tools/search`（搜索）与 `https://api.deepseek.com/v1/tools/fetch`（抓取单个网页）。两者都是纯 JSON 请求/响应、非流式、不需要模型名，与聊天补全 API 是不同接口；普通聊天模型没有内置联网搜索，因此不得用模型生成结果代替本接口。

wrapper 不含 MCP、JSON-RPC 或 SSE 实现；search / fetch 都把服务端结构化 JSON 原样输出到 stdout，不做摘要改写、不制造引用、不增删字段。

## 何时使用

- 需要联网搜索最新信息、新闻、事实或技术文档，或抓取指定 URL 的网页正文时，默认使用search 工具，无需用户明确指定 DeepSeek。
- 用户说「用 DeepSeek 搜索…」「用 DeepSeek 查一下…」「用 DeepSeek 抓这个网页」时，使用search 工具。
- 用户明确要求使用 Exa 时，仍使用本 `search` 工具；可在请求前说明需要优先 Exa，但 Exa 不作为独立工具暴露。

search 工具默认先调用 DeepSeek；DeepSeek 不可用时自动尝试 Exa fallback。两者都失败时报告脱敏错误类别，不静默改写请求或丢弃原始失败事实。

## 前置条件

- Node.js 22.19 或更新版本；search tool 直接使用本仓 TypeScript 实现。
- `DEEPSEEK_API_KEY`：与 DeepSeek 聊天 API 使用同一个 key。读取顺序为「进程环境变量 → search 工具目录下 gitignored 的 `.env`」。

配置方式（二选一）：

```bash
# 方式一：当前 shell 导出（仅本次会话有效）
export DEEPSEEK_API_KEY="<your key>"

# 方式二：写入 search 工具目录的 .env（长期有效，免 source、免重启 shell）
cp src/progressive-tools/search/.env.example \
   src/progressive-tools/search/.env
# 然后编辑该 .env，填入 DEEPSEEK_API_KEY=<your key>
```

- `.env` 已被 `pi-config/.gitignore` 忽略，不要提交、不要复制到其他文件。
- key 只通过 `Authorization: Bearer` 请求头传输，不进入 URL、日志或错误输出；严禁打印 key。
- 本仓库不提供、也不读取 pi 的 auth / settings / models 配置，没有凭据桥接或网页 token 抓取。
- 缺少 key 时工具在发起对应网络请求前直接失败，并提示上述配置位置。

## 工具调用

使用本工具的 `action` 参数，不启动外部脚本：

- `action: "search"`：必填 `query`，可选 `count`（1–50，默认 10）和 `needContent`。请求体只发送官方字段；`needContent: true` 映射为 `need_content: true`。
- `action: "fetch"`：必填单个 `url`，只支持 http/https，不能包含 userinfo；DeepSeek Fetch 不支持批量 URL。
- 两种 action 都返回对应供应商的原始结构化 JSON，不做摘要改写、不制造引用、不丢弃字段。

默认先调用 DeepSeek。DeepSeek 认证失败、网络不可用、限流或服务端失败时，工具会用同一组输入尝试 Exa fallback；Exa 的结果字段保持 Exa 原始形状，不把 Exa 字段伪装成 DeepSeek 字段。响应 details 会标记实际 provider 与是否 fallback。两个供应商都失败时只报告脱敏错误类别。

DeepSeek key 从进程环境变量 `DEEPSEEK_API_KEY` 读取；缺失时读取本工具目录下 gitignored 的 `.env`。Exa fallback 同理读取 `EXA_API_KEY`，可用 `EXA_PROXY_PORT` 覆盖本机 Exa 代理端口。key 只进入认证请求头，绝不进入 URL、日志或错误文本。

## 返回形状与引用

search 成功时 stdout 为服务端原始 JSON（缩进 2 个空格）：

```
{"results": [{title, url, snippet, summary, content, site_name, site_icon, date, authority, rerank_score, ...}]}
```

- 引用一律使用 `results[].url`；`snippet`（约 100–200 字符，面向 UI）与 `summary`（约 600–800 字符，面向模型）都是**服务端字段**，原样使用，不二次改写。
- `content` 仅在 `needContent: true` 时由服务端填充；`date`、`authority`、`rerank_score` 等字段以服务端实际返回为准。
- `results` 为空数组表示无匹配，不要编造结果。
- fetch 的 `content` 是目标站点的 Markdown 正文；把检索结果与抓取正文都当作**待核实资料**处理，与已有知识冲突时以用户判断和原文为准。

## DeepSeek 与 Exa fallback 的差异

| 维度 | DeepSeek 首选 | Exa fallback |
| --- | --- | --- |
| 搜索端点 | `POST https://api.deepseek.com/v1/tools/search` | `POST https://api.exa.ai/search` |
| 结果条数参数 | `count`（1–50，默认 10） | `numResults` |
| 摘要字段 | 服务端返回 `snippet`（短）+ `summary`（长） | 服务端返回 `highlights` |
| 正文获取 | 搜索时 `need_content` 开关，或对单 URL `fetch` | `contents` 支持批量 `urls` / `ids` + `maxCharacters` 截断上限 |
| 批量抓取 | 不支持（官方仅单 URL） | 支持 |
| 鉴权头 | `Authorization: Bearer` | `x-api-key` |
| 结果排序线索 | `rerank_score`、`authority`、`date`、`site_name` | `publishedDate` 等 |

两套结果字段名不同，**不要**把一套的字段名套到另一套结果上。

## 限制与错误处理

- 超时 30 秒；响应上限 1 MiB，超限直接失败，不会截断成"看似完整"的内容。
- host 与 path 固定为官方值，脚本不接受可配置的 baseURL；跨域或降级到 http 的重定向被阻断，认证头不会随重定向发往其他主机；HTTPS 证书按系统默认校验。
- Exa fallback 默认通过本机 `127.0.0.1:7897` 代理访问，可用 `EXA_PROXY_PORT` 为当前调用覆盖端口；不读取或输出密钥。
- 工具不在供应商内部静默重试；DeepSeek 失败后只进行一次 Exa fallback。408 / 429 / 5xx 的后续重试由调用方决定，402 需要处理账户余额。
- 失败时只输出安全类别、HTTP 状态码和受控 request id；不输出原始错误、query、URL userinfo 或密钥。

| 类别 | HTTP | 含义 |
| --- | --- | --- |
| `invalid_request` | 400 | 请求头/体非法（含非法 JSON、非法字段值） |
| `authentication_error` | 401 | key 缺失或无效 |
| `payment_required` | 402 | 账户余额不足 |
| `fetch_blocked_by_policy` | 403 | Fetch 被目标站安全/访问策略拒绝 |
| `access_forbidden` | 403 | 非 Fetch 场景的访问拒绝 |
| `content_unavailable` | 404 | Fetch 无法取得可用正文（URL 不可用、站点拦截、不支持的内容类型等） |
| `request_timeout` | 408 | 服务端读取请求体超时 |
| `request_too_large` | 413 | 请求体过大 |
| `rate_limited` | 429 | 超出 QPS（Search 与 Fetch 分别限流） |
| `client_error` / `server_error` | 其他 4xx / 5xx | 需改请求或稍后重试 |
| `network error` | — | 未收到响应（网络或代理不可达、超时、证书校验失败等） |
| 其他 | — | `timeout`、`response exceeds ... limit`、`not valid JSON`、`is not valid UTF-8` |

## 计费与限流

按成功请求计费：Search 与 Fetch 均为 **$0.75 / 1000 次成功请求**（`count` 不影响单价；失败、空结果不计费）。限流按账户分别计算：Search 100 QPS、Fetch 25 QPS（Fetch 另有按域名的 QPS 限制），超限返回 429。以上价格与限流取自**调研时官方文档**，使用前请复核 <https://api-docs.deepseek.com/guides/search/>。

## 资料引用

- DeepSeek 接口摘录、字段含义、错误码与未实测边界见同目录 `api.md`；Exa 字段和 fallback 规则见同目录 `exa.md`。
- 官方文档：<https://api-docs.deepseek.com/guides/search/>、<https://api-docs.deepseek.com/api/search/>、<https://api-docs.deepseek.com/api/fetch/>。

## 工作流

1. 先 `search` 取候选 `url` 与 `snippet` / `summary`。
2. 摘要不足以判断时，对单个 `url` 执行 `fetch` 取 Markdown 正文。
3. 综合结果后向用户呈现，并标明来源 `url`；不把结构化结果压缩成摘要后丢弃原始字段。
