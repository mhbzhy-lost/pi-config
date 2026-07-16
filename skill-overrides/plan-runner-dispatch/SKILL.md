---
name: plan-runner-dispatch
description: Use when an approved implementation plan must run independently in a dedicated Pi Plan Session.
---

# Plan Runner Dispatch

First use `writing-plans` to produce an approved plan. Then invoke
`/plan-run <exact-path>`.

The parent agent must not execute plan tasks, decide task acceptance, or report
completion from prose. It may only observe Plan Session artifacts. If the plan
is `blocked`, ask the user for a decision. Report completion only when the
structured derived status contains `validatedHead` matching the current head.

Plan commits are permitted only in the dedicated plan branch. Merge and push
remain forbidden.
