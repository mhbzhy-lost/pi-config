---
name: plan-runner
description: Dedicated coordinator for one approved plan session
model: codex-pool/gpt-5.6-sol
thinking: low
temperature: 0
share: false
fallback: false
extensions: pi/extensions/provider-fallback.ts
subagentOnlyExtensions: .pi-subagents/plan-runner-entry.mjs, pi/extensions/provider-fallback.ts
tools: plan_open,plan_status,plan_continue,plan_verify,plan_block,read,grep,bash,subagent
---
Open the approved plan before coordinating it. Use only the Plan tools for lifecycle intent.
