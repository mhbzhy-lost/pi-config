# Pi RPC real-canary client gap

## Scope

T9 adds a test-local JSONL RPC client rather than a production RPC library. It uses the official LF-only framing contract, response IDs, bounded stderr/event diagnostics, extension UI responses, an abort path, and hard cleanup.

## Failure handling

The real canary starts only `/opt/homebrew/bin/pi` with `openai-codex/gpt-5.6-luna`; it neither invokes auth commands nor copies authentication into its temporary settings. Any provider, child, or extension failure writes a redacted `rpc-smoke-blocked-events.json` in the temporary agent directory before cleanup and fails BLOCKED. There is intentionally no model/provider fallback or stub.

## Boundary

The temporary wrapper imports only `pi/extensions/goal-engine.ts` and calls `createGoalEngineEntry` with the temporary settings path. The actual subagent runtime is separately loaded from `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`. The root model, not this test, must perform `goal_init`, `goal_status`, `goal_dispatch`, and the returned typed `subagent` contract.

## Observed real BLOCKED result

The original real run settled in about 27 seconds. The root model complied with the required Goal call sequence (the client observed `goal_init`, `goal_status`, `goal_dispatch`, and `subagent` execution events), but the real `subagent` tool result was `SUBAGENT_RPC_FAILED: Facade run identity conflicts` and therefore contained no `runId` or `asyncDir`. The later focused production repair removed that conflict.

The parser-correction run then proved that `goal_init` returns its business JSON through the public `ToolResult.content` text blocks: it obtained `goalId` `r13-one-task-typed-subagent-bind-smoke`, and parsed matching `goal_status` and `goal_dispatch` results. The canary's invalid `contract.goalId` assertion stopped that run before subagent validation; a final authorized corrected run reached the real `subagent` end event, whose public text began `Started ex...`, so it must not be decoded as Goal JSON. The test now reads `runId` and `asyncDir` only from the typed subagent `ToolResult.details` structure. No further smoke run is authorized; that final event log was removed by the test's temp cleanup after the assertion failure, so these fields could not be retrospectively verified.
