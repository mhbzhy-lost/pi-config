---
name: exa-search
description: Use when needing to search the web for current information, news, facts, documentation, or any topic requiring up-to-date internet data. Also use when needing to fetch full content from specific URLs.
---

# Exa Web Search

Search the web and fetch webpage content using Exa's semantic search API.

## Prerequisite

Python 3.9 or newer is required. Set a personal Exa API key in the process environment:

```bash
export EXA_API_KEY="<your-exa-api-key>"
```

The script intentionally has no built-in or anonymous fallback. Never commit the key to this repository. `skill-overrides/exa-search/.env` is ignored for local secret management, but the script does not parse it; load it into bash/zsh first with `set -a; source skill-overrides/exa-search/.env; set +a`.

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
- Confirm `EXA_API_KEY` is exported in the process environment
- Check internet connection
- Verify Python3 is available
- If Exa reports a rate limit, inspect the quota for the configured personal key
