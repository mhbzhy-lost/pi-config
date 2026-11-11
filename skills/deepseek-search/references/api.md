# DeepSeek Search / Fetch API 摘录

本文只摘录本 skill 依赖的官方接口事实，供实现核对使用。完整契约以官方文档为准：

- Search & Fetch 指南：<https://api-docs.deepseek.com/guides/search/>
- Search API 参考：<https://api-docs.deepseek.com/api/search/>
- Fetch API 参考：<https://api-docs.deepseek.com/api/fetch/>
- 错误码：<https://api-docs.deepseek.com/quick_start/error_codes/>

调研边界：以下内容来自调研时的官方文档；本仓库**未使用真实 key 实测成功响应**，行为细节以实测为准（见文末"未实测边界"）。

## 鉴权与形态

- 端点：`POST https://api.deepseek.com/v1/tools/search`、`POST https://api.deepseek.com/v1/tools/fetch`。
- 鉴权：请求头 `Authorization: Bearer <DEEPSEEK_API_KEY>`，与聊天 API 同一个 key。
- 形态：纯 JSON 请求/响应，**非流式**（无 `stream` 参数、无 SSE），**不需要模型名**，不是聊天补全，也不是 tool calling。
- 普通 Chat Completions 的 `tools` 仅支持 `type: "function"`，因此聊天模型侧没有内置联网搜索；不得用模型生成结果代替本接口。

## Search 请求字段

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `query` | string | 是 | 1–128 个 Unicode 字符，不可全空白；支持检索算子（下） |
| `count` | integer | 否 | 1–50，默认 `10` |
| `need_content` | boolean | 否 | 默认 `false`；为 `false` 时 `content` 恒为空串 |

官方另有 `ori_question`（1–128 字符）与 `localization`（官方描述为用于结果本地化的 IP 地址）两个可选字段；本 skill 不使用它们（`localization` 的语义在第三方 SDK 文档中另有说法，存在文档冲突）。官方注明请求体中未知字段会被忽略，被忽略的字段不会产生任何额外效果；wrapper 因此只发送上表字段。

query 算子（原样透传给服务端）：`site:`、`-site:`、`-term`、`"exact phrase"`、`-"exact phrase"`、`lang:`、`after:`、`before:`。

示例：`{"query": "DeepSeek V4 site:github.com lang:en after:2025", "count": 10}`

## Search 响应字段

`{"results": [ ... ]}`，`results` 为空数组表示无匹配。

| 字段 | 说明（官方） |
| --- | --- |
| `title` | 网页标题 |
| `url` | 网页地址；**引用即此字段** |
| `snippet` | 约 100–200 字符，面向 UI 的短摘要 |
| `summary` | 约 600–800 字符，面向模型的长摘要 |
| `content` | 正文，仅在 `need_content: true` 时填充 |
| `site_name`、`site_icon` | 站点名与图标 URL |
| `date` | RFC 3339 UTC 时间或 `null` |
| `authority` | 0–4，`-1` 表示未知，≥3 视为权威 |
| `rerank_score` | 0–3，≥1.5 视为高质量 |

## Fetch 请求与响应

- 请求体：`{"url": "..."}`。`url` 必填，不超过 8192 字符，必须 `http`/`https` 且有 host，**不得包含 userinfo**。
- 响应：`{"title": "...", "content": "<Markdown 正文>"}`；`title` 不可得时为空串。
- 官方无批量抓取、无正文字符上限参数、无分页；抓取结果受目标站点可用性与访问策略限制。

## 错误码（官方）

| HTTP | 含义 |
| --- | --- |
| 400 | 请求头/体非法，含非法 JSON 或非法字段值 |
| 401 | key 缺失或无效 |
| 402 | 账户余额不足 |
| 403 | Fetch 被安全策略拒绝 |
| 404 | Fetch 无法取得可用页面内容（URL 不可用、站点策略拦截、目标站错误、不支持的内容类型、无可提取 Markdown） |
| 408 | 服务端读取请求体超时 |
| 413 | 请求体过大 |
| 429 | 超出 Search 或 Fetch 的 QPS |
| 500 / 504 | 内部错误 / 下游超时 |

重试指引（官方）：408、429、5xx 可等待后重试；402 需充值后再试；其他 4xx 在改变请求前不要重试。Search 与 Fetch 都是只读操作。

## 计费与限流（调研时官方文档）

- Search、Fetch 均按**成功请求**计费：**$0.75 / 1000 次**；失败、空结果、超时不计费；`count` 不影响单价。
- 限流按账户计，Search **100 QPS**、Fetch **25 QPS**（Fetch 另有按域名 QPS 限制），超限返回 429。
- 价格与限流属会变动的商业条款，使用前请复核官方指南。

## 与 exa-search 的字段差异

| 概念 | deepseek-search | exa-search |
| --- | --- | --- |
| 结果条数 | `count` | `numResults` |
| 短摘要 / 长摘要 | `snippet` / `summary` | `highlights` |
| 正文 | `results[].content`（需 `need_content`）或 fetch 的 `content` | `text` + `maxCharacters` 截断上限 |
| 抓取范围 | 单 URL | 批量 `urls` 或 `ids` |
| 鉴权头 | `Authorization: Bearer` | `x-api-key` |
| 时间字段 | `date`（RFC 3339 或 null） | `publishedDate` |
| 质量线索 | `rerank_score`、`authority` | 本 skill 不对两者评分字段作映射 |

## 未实测边界

- `need_content: true` 时 `content` 的实际长度与截断行为、超大页面对 1 MiB 响应上限的影响，均未实测。
- `snippet` / `summary` / `content` 的中文质量与字段完整性未实测。
- `authority`、`rerank_score` 在真实查询中的分布与阈值可用性未实测。
- 401/402/403/404/429 等错误路径在本机只验证过"未携带认证头 → 401"，其余错误类别的真实响应体未实测。
- 账户层面可能存在的限制（例如某个 key 只能用于聊天、不能调用 `/v1/tools/*`）官方文档未提及，需实测确认。
