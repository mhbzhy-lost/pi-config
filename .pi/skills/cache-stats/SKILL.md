---
name: cache-stats
description: Use when needing to check cache hit rates, token usage, or cost efficiency across pi sessions and models.
---

# Cache Statistics

查询 pi session 的缓存命中率和 token 使用统计。

## Commands

```bash
# 最近 1 天的统计（默认）
python3 .pi/skills/cache-stats/cache-stats.py

# 最近 7 天
python3 .pi/skills/cache-stats/cache-stats.py --days 7

# 指定 provider
python3 .pi/skills/cache-stats/cache-stats.py --provider anthropic-idealab

# 按 session 细分
python3 .pi/skills/cache-stats/cache-stats.py --per-session

# 查找特定 session
python3 .pi/skills/cache-stats/cache-stats.py --session 019f69
```

## Output

```
provider/model                                turns    input   cached    write    hit%
------------------------------------------------------------------------------------
anthropic-idealab/claude-opus-4-6                 2       4   257.3K   260.5K   49.7%
anthropic-idealab/claude-opus-4-6-200k            1       3    15.2K        0  100.0%
openai-idealab/Qwen3.7-Max-DogFooding          293    1.4M    24.4M        0   94.5%
------------------------------------------------------------------------------------
TOTAL                                           296    1.4M    24.7M   260.5K   93.7%
```

## Fields

| 字段 | 说明 |
|------|------|
| `input` | 未命中缓存的 input tokens |
| `cached` | 命中缓存的 input tokens（`cacheRead`） |
| `write` | 写入缓存的 tokens（`cacheWrite`，首次请求产生） |
| `hit%` | 缓存命中率 = `cached / (input + cached + write)` |

## Notes

- 数据来源：`var/sessions/*.jsonl` 中每个 assistant turn 的 `usage` 字段
- Anthropic 缓存：由 `anthropic-request-rewriter` extension 注入 `cache_control` markers
- OpenAI/Qwen 缓存：由 provider 端自动管理（server-side implicit caching）
