---
name: exa-search
description: Use when needing to search the web for current information, news, facts, documentation, or any topic requiring up-to-date internet data. Also use when needing to fetch full content from specific URLs.
---

# Exa Web Search

Search the web and fetch webpage content using Exa's semantic search API.

## Prerequisite

Python 3.9 or newer is required. The script automatically loads `EXA_API_KEY` from the gitignored `.env` in its own directory when the process environment does not provide a non-empty value. A non-empty process environment value takes precedence. Users do not need to source the file or restart their shell. There is no anonymous fallback; never commit the key to this repository.

## When to Use

- User asks about current events, recent news, or time-sensitive information
- Need to find documentation, tutorials, or technical references
- Research people, companies, or specific topics
- Fetch full content from URLs for detailed reading
- Verify facts or gather information not in training data

## Commands

**Search the web:**
```bash
python3 ~/pi-config/skill-overrides/exa-search/exa.py search "your query" [num_results]
```

**Fetch full webpage content:**
```bash
python3 ~/pi-config/skill-overrides/exa-search/exa.py fetch "url1" ["url2" ...]
```

## 独立代理

Exa 请求单独使用本机 HTTP 代理 `127.0.0.1:7897`，不会修改宿主或其他工具的代理设置，也不会沿用宿主的 `https_proxy` 或系统代理。宿主代理端口不是 `7897` 时，agent 可在**该次调用**前通过 `EXA_PROXY_PORT` 覆盖（仅接受十进制端口 `1`–`65535`）：

```bash
EXA_PROXY_PORT=8888 python3 ~/pi-config/skill-overrides/exa-search/exa.py search "your query" 5
EXA_PROXY_PORT=8888 python3 ~/pi-config/skill-overrides/exa-search/exa.py fetch "https://example.com"
```

端口覆盖只对这条命令生效；不设置时仍使用 `7897`。若代理不可用，应核对宿主实际端口并在调用时覆盖；不要为此设置全局代理，也不要读取或输出密钥。程序调用 `search`、`fetch` 时可传入 `proxy_port` 整数参数覆盖。

## Query Tips

Write queries as **descriptive phrases**, not keywords:
- Good: "blog post comparing React and Vue performance 2024"
- Bad: "React vs Vue"

For people/company searches, use category filters:
- `category:people John Doe software engineer`
- `category:company Stripe payment processing`

## Output Format

Both commands return JSON with:
- `result.content[0].text` - Main content (markdown format)
- Search results include titles, URLs, and highlights
- Fetch results include full page content

## Workflow

1. **Search first** to find relevant URLs
2. **Review highlights** from search results
3. **Fetch full content** only if highlights are insufficient
4. **Synthesize** information for the user

## Examples

```bash
# Search for recent AI news
python3 ~/pi-config/skill-overrides/exa-search/exa.py search "latest AI breakthroughs 2024" 5

# Fetch specific documentation
python3 ~/pi-config/skill-overrides/exa-search/exa.py fetch "https://docs.example.com/api"
```

## Error Handling

If the script fails:
- Confirm that either the process environment has a non-empty `EXA_API_KEY`, or the gitignored `.env` beside the script contains a valid `EXA_API_KEY` assignment. The script reads that file automatically; do not source it or restart the shell, and never print the key.
- Check internet connection
- Verify each requested URL is valid and reachable
- Verify Python3 is available
- If Exa reports a rate limit, inspect the quota for the configured personal key
