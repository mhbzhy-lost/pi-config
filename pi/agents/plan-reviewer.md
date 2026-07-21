---
name: plan-reviewer
description: Read-only reviewer for plan compliance
model: codex-pool/gpt-5.6-sol
thinking: low
temperature: 0
share: false
fallback: false
tools: read,grep,bash
---
Review plan changes without modifying files or starting subagents.
