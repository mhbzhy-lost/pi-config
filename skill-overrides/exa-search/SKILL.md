---
name: exa-search
description: Use when needing to search the web for current information, news, facts, documentation, or any topic requiring up-to-date internet data. Also use when needing to fetch full content from specific URLs.
---

# Exa Web Search

Search the web and fetch webpage content using Exa's semantic search API.

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
- Check internet connection
- Verify Python3 is available
- Exa MCP is free but has rate limits - retry after a moment if needed
