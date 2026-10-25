---
name: deepseek-search
description: 需要联网搜索最新信息、新闻、事实或技术文档，或需要抓取指定 URL 的网页正文时使用，无需用户明确指定 DeepSeek。默认使用 DeepSeek 官方独立 REST API；用户明确要求使用 Exa 时改用 exa-search。
---

# DeepSeek 网页搜索与正文抓取

直接调用 DeepSeek 官方独立 REST API：固定端点 `https://api.deepseek.com/v1/tools/search`（搜索）与 `https://api.deepseek.com/v1/tools/fetch`（抓取单个网页）。两者都是纯 JSON 请求/响应、非流式、不需要模型名，与聊天补全 API 是不同接口；普通聊天模型没有内置联网搜索，因此不得用模型生成结果代替本接口。

wrapper 不含 MCP、JSON-RPC 或 SSE 实现；search / fetch 都把服务端结构化 JSON 原样输出到 stdout，不做摘要改写、不制造引用、不增删字段。

## 何时使用

- 需要联网搜索最新信息、新闻、事实或技术文档，或抓取指定 URL 的网页正文时，默认使用本 skill，无需用户明确指定 DeepSeek。
- 用户说「用 DeepSeek 搜索…」「用 DeepSeek 查一下…」「用 DeepSeek 抓这个网页」时，使用本 skill。
- 用户明确要求使用 Exa 时，使用 `exa-search` skill。

本 skill 只调用 DeepSeek。失败时向用户报告错误类别，不自动改用 Exa 或其他搜索供应商；只有用户明确要求使用 Exa 时才调用 `exa-search`。

## 前置条件

- Python 3.9 或更新版本，只用标准库。
- `DEEPSEEK_API_KEY`：与 DeepSeek 聊天 API 使用同一个 key。读取顺序为「进程环境变量 → 本 skill 目录下 gitignored 的 `.env`」，脚本按自身所在目录定位 `.env`，与当前工作目录无关。

配置方式（二选一）：

```bash
# 方式一：当前 shell 导出（仅本次会话有效）
export DEEPSEEK_API_KEY="<your key>"

# 方式二：写入本 skill 目录的 .env（长期有效，免 source、免重启 shell）
cp ~/pi-config/skill-overrides/deepseek-search/.env.example \
   ~/pi-config/skill-overrides/deepseek-search/.env
# 然后编辑该 .env，填入 DEEPSEEK_API_KEY=<your key>
```

- `.env` 已被 `pi-config/.gitignore` 忽略，不要提交、不要复制到其他文件。
- key 只通过 `Authorization: Bearer` 请求头传输，不进入 URL、日志或错误输出；严禁打印 key。
- 本仓库不提供、也不读取 pi 的 auth / settings / models 配置，没有凭据桥接或网页 token 抓取。
- 缺少 key 时脚本在发起任何网络请求前直接以非 0 退出，并提示上述两种配置方式。

## 命令

`<skill-dir>` 指本文件所在目录（源仓库 `~/pi-config/skill-overrides/deepseek-search/`，安装后 `~/.agents/skills/deepseek-search/` 是同一目录的 symlink）。安装后可直接运行：

```bash
python3 ~/.agents/skills/deepseek-search/deepseek.py search 'DeepSeek 官方 Search API site:api-docs.deepseek.com' 5
```

**搜索：**

```bash
python3 <skill-dir>/deepseek.py search [--need-content] [--] "your query" [count]
```

- `--` 是选项终止符：其后的参数全部按位置参数（`query`、`count`）原样传入，连 `--need-content` 与 `--help` 也不再按选项解析。查询本身以 `-` 开头时（官方排除算子 `-site:`、`-term`）必须使用它，否则会被当作未知选项拒绝：

```bash
python3 ~/.agents/skills/deepseek-search/deepseek.py search -- '-site:example.com DeepSeek' 5
# 需要正文时把 --need-content 放在 -- 之前
python3 ~/.agents/skills/deepseek-search/deepseek.py search --need-content -- '-site:example.com DeepSeek' 5
```

- `query`：1–128 个 Unicode 字符，不可全空白；原样透传，支持官方算子 `site:`、`-site:`、`-term`、`"exact phrase"`、`-"exact phrase"`、`lang:`、`after:`、`before:`，例如 `"DeepSeek V4 site:github.com lang:en after:2025"`。
- `count`：整数 1–50，默认 `10`，映射请求体 `count`。
- `--need-content`：让服务端同时填充 `results[].content`。默认不携带该字段（默认不取正文，正文优先走 `fetch`）。
- 请求体只含官方字段：`query`、`count`，以及显式开启时的 `need_content`。

**抓取单个网页：**

```bash
python3 <skill-dir>/deepseek.py fetch "https://example.com/article"
```

- `url`：字符串，不超过 8192 字符，仅 `http` / `https`，必须有 host，不得包含 userinfo（`user:pass@host`）。
- 官方没有批量抓取、没有正文字符上限参数、也没有分页；脚本不虚构 `maxCharacters` 之类的参数，也不编造分页。
- 返回 `{"title": ..., "content": <Markdown>}`；`title` 不可得时为空串。

**帮助：**

```bash
python3 <skill-dir>/deepseek.py --help
python3 <skill-dir>/deepseek.py search --help
python3 <skill-dir>/deepseek.py fetch --help
```

## 返回形状与引用

search 成功时 stdout 为服务端原始 JSON（缩进 2 个空格）：

```
{"results": [{title, url, snippet, summary, content, site_name, site_icon, date, authority, rerank_score, ...}]}
```

- 引用一律使用 `results[].url`；`snippet`（约 100–200 字符，面向 UI）与 `summary`（约 600–800 字符，面向模型）都是**服务端字段**，原样使用，不二次改写。
- `content` 仅在 `--need-content` 时由服务端填充；`date`、`authority`、`rerank_score` 等字段以服务端实际返回为准。
- `results` 为空数组表示无匹配，不要编造结果。
- fetch 的 `content` 是目标站点的 Markdown 正文；把检索结果与抓取正文都当作**待核实资料**处理，与已有知识冲突时以用户判断和原文为准。

## 与 exa-search 的差异

| 维度 | deepseek-search | exa-search |
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
- 代理：脚本不硬编码任何本地代理，`HTTPS_PROXY` / `NO_PROXY` 等环境代理由 Python `urllib` 默认行为处理；也不提供额外的代理参数体系。
- 无静默重试。按官方指引，HTTP 408 / 429 / 5xx 可等待后重试，402 需充值，其他 4xx 不改请求不要重试；重试与否由调用方决定。
- 失败时 stderr 只输出安全类别、HTTP 状态码与受控格式的 request id（若服务端返回），退出码非 0；不输出原始服务端 `error.message`、traceback、query、URL 或密钥。

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

- 接口摘录、字段含义、错误码与未实测边界见同目录 `references/api.md`。
- 官方文档：<https://api-docs.deepseek.com/guides/search/>、<https://api-docs.deepseek.com/api/search/>、<https://api-docs.deepseek.com/api/fetch/>。

## 工作流

1. 先 `search` 取候选 `url` 与 `snippet` / `summary`。
2. 摘要不足以判断时，对单个 `url` 执行 `fetch` 取 Markdown 正文。
3. 综合结果后向用户呈现，并标明来源 `url`；不把结构化结果压缩成摘要后丢弃原始字段。
