---
name: subagent-dispatch
description: Use when delegating coding work to executor or spark, or non-coding work to another configured Pi agent.
---

# Subagent Dispatch

The project-owned `subagent` tool is the only delegation entry.

## Coding

`executor` and `spark` require a complete `dispatch-ir.v1`; never send them a free-form task. If required information is missing, stop and obtain it before dispatch. Deadlines never waive this contract. Never invent `delegate(...)` or substitute `background/prompt` fields. Placeholder values are missing information, not a complete contract.

Use `spark` only for low-risk work with one declared write path and at most eight requirements. Use `executor` otherwise.

```js
subagent({
  version: "dispatch-ir.v1",
  taskId: "fix-parser",
  title: "Fix parser fallback",
  agent: "spark",
  risk: "low",
  objective: "Reject malformed fallback input.",
  workflow: { mode: "tdd" },
  requirements: ["Add a failing regression test first."],
  context: {
    knownFacts: ["The parser owns fallback validation."],
    decisions: ["Keep the public API unchanged."],
    relevantFiles: ["src/parser.ts", "test/parser.test.ts"]
  },
  boundaries: {
    writePaths: ["src/parser.ts"],
    excludedWork: ["No parser refactor."],
    forbiddenActions: ["Do not commit."]
  },
  acceptance: {
    criteria: ["Malformed input is rejected."],
    commands: ["node --test test/parser.test.ts"]
  },
  execution: { cwd: "/workspace", timeoutMs: 900000 }
});
```

## Generic

For generic non-coding delegation, use the enabled `delegate` agent with `{ agent, title, task }`. Title is a concise single-line display label; the task is forwarded unchanged.

```js
subagent({ agent: "delegate", title: "Review current diff", task: "Inspect the current diff and report findings." });
```
