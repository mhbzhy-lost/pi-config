# goal_dispatch public result identity contract

## Provenance and first deviation

The latest redacted real P3 diagnostic completed `goal_init`, `goal_status`, `goal_dispatch`, typed `subagent`, and `agent_settled` successfully. The only failed assertion read `dispatched.goalId`. That field is not part of the public `goal_dispatch` result. The authoritative Goal locator is `goal_init`'s `goalId`; dispatch identity is `task_id`, `contract.taskId`, and `contract_hash`.

An in-process SDK attempt to reproduce the full dispatch path stopped before result creation with `WORKSPACE_SERVICE_UNAVAILABLE`. This is the known local child/runtime suppression boundary, not a production dispatch failure: it must not be bypassed by rebuilding or injecting a workspace service. The env-gated root RPC smoke remains the composition test.

## Frozen public contract

For init result `init` and dispatched task `taskId`, a successful public dispatch result has these facts:

- it has no top-level `goalId`;
- `task_id === taskId`;
- `contract.taskId` equals the concatenation `${init.goalId}.${taskId}`.
- `contract_hash` is a lowercase 64-character SHA-256 hexadecimal string.

The test's local RED fixture proves the historical `initialized.goalId === dispatched.goalId` assertion fails when the public result has this shape. `assertCanaryDispatchIdentity` then freezes the replacement identity contract without inferring fields from assistant prose or changing production API.

## Real smoke verification order

The env-gated real smoke uses `init.goalId` only to locate the ledger. It validates the dispatch task/contract identity, then validates typed subagent ToolResult `details.runId`, `details.asyncDir`, and `details.contractHash` against `contract_hash`, and only then reads the ledger's `executorBinding` for the same task. Attempt selection remains exactly one successful call per tool; redaction, deadlines, diagnostics, termination, and cleanup are unchanged.

No local test calls a model, provider, or subagent. The real RPC smoke remains skipped unless `PI_RUN_GOAL_REAL_CANARY=1`.
