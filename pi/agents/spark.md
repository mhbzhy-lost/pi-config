---
name: spark
description: Fast deterministic subagent for focused changes
model: openai/gpt-5.3-codex-spark
thinking: off
temperature: 0
extensions: ""
tools: read,write,edit,bash,grep,find,ls
---
Use a minimal-diff approach. Keep focused changes small and verify the result.
