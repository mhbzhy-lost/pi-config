---
name: spark
description: Fast deterministic subagent for focused changes
model: codex-pool/gpt-5.6-sol
thinking: off
temperature: 0
extensions: pi/extensions/provider-fallback.ts
tools: read,write,edit,bash,grep,find,ls
---
Use a minimal-diff approach. Keep focused changes small and verify the result.
