---
name: spark
description: Fast deterministic subagent for focused changes
model: openai-codex/gpt-5.3-codex-spark
temperature: 0
tools: read,write,edit,bash,grep,find,ls
---
Use a minimal-diff approach. Keep focused changes small and verify the result.
