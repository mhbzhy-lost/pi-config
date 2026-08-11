---
name: subagent-dispatch
description: Use when delegating coding work to executor or spark, or non-coding work to another configured Pi agent.
---

# Subagent Dispatch

Use only the project-owned `subagent` tool.

## Coding

`executor` and `spark` require complete `dispatch-ir.v1`, never a free-form task. Deadlines never waive: missing information, placeholders, and guesses are incomplete; never invent `delegate(...)` or substitute `background/prompt`.

First verify cwd, relevant paths, and facts; fill required slots from the schema. Unknown information must not become `knownFacts`, placeholders, or guesses.

Mechanical preflight: exact top-level/nested shape; no extra fields; repo-relative POSIX `relevantFiles`/`writePaths`; supported enumeration; non-empty required arrays; positive integer timeout; criteria-only acceptance. `tdd` reason forbidden; `existing-tests` and `docs-only` reason required.

Use `spark` only for low-risk work with one write path and at most eight requirements; otherwise use `executor`.

禁止 raw git worktree add/remove/prune/move/repair/lock/unlock：只可走 managed lifecycle CLI `node scripts/worktree-lifecycle.mjs ...` 或 typed Goal disposition，并须 owner CAS 与明确授权；不得 `--force` remove、raw branch cleanup，`/tmp`、TTL、clean 均不构成删除授权。

```js
subagent({
  version: "dispatch-ir.v1", taskId: "harden-dispatch-skill", title: "Harden example",
  agent: "executor", risk: "normal", objective: "Compile example.",
  workflow: { mode: "tdd" }, requirements: ["Test first."],
  context: {
    knownFacts: ["Source is verified."], decisions: ["Keep safety rules."],
    relevantFiles: ["skill-overrides/subagent-dispatch/SKILL.md", "test/subagent-dispatch-skill.test.mjs"]
  },
  boundaries: { writePaths: ["skill-overrides/subagent-dispatch/SKILL.md"], excludedWork: ["No schema changes."], forbiddenActions: ["Do not commit."] },
  acceptance: { criteria: ["Example compiles."] },
  execution: { timeoutMs: 900000 }
});
```

## Generic

For generic delegation, use enabled `delegate` with `{ agent, title, task }`. Title is a concise label; task is forwarded unchanged.

```js
subagent({ agent: "delegate", title: "Review current diff", task: "Inspect the current diff and report findings." });
```
