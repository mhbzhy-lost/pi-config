---
name: subagent-dispatch
description: Use when delegating a coding task to the configured executor or spark Pi subagent.
---

# Subagent Dispatch

Use the community `subagent` tool through its async lifecycle. Start every
delegation in the background, inspect artifact-backed status when needed, and
read the referenced artifact after the run reaches a terminal state. Do not
busy-poll.

Use `executor` for multi-file work or security-sensitive tasks. Use `spark` only
for a fast, focused single-file change.

```js
const run = await subagent({
  agent: "executor",
  task: "Implement the security fix and verify it.",
  async: true,
  cwd: "/workspace",
});

await subagent({ action: "status", id: run.details.runId });
```

Ordinary workers must not recursively delegate work. Their artifact-backed status
and final artifact are the only handoff mechanism.
