# executor binding durable-then-throw fixture hang

## Observation

The focused `durable-then-throw executor binding append` singleton produced no
TAP, spawn, or Broker output for 60.012 seconds before its watchdog stopped it.
A follow-up bounded diagnostic was stopped at 20 seconds and likewise produced
no TAP output.

## Static timeline

1. The test's fake RPC advertised `sessionFile: "/tmp/s"`.
2. `executeCoding()` derives the collector session identity from that file and
   calls `spawnWorkflowLeaf()`.
3. The fake `workflowSpawnReply()` emitted the leaf start with
   `sessionId: "root-session-1"` before the RPC reply returned.
4. `createWorkflowChildStartCollector()` discarded that event because its
   session identity did not equal `"/tmp/s"`, then `collector.waitFor(root)`
   waited for its production 120-second child-start timeout.

This is a test-fixture identity mismatch, not evidence of a production hang.
The production child-start timeout and fail-closed behavior are intentionally
unchanged.

## Fix boundary

The singleton now uses a Host-owned deterministic RPC fixture: its advertised
session identity matches the synthetic leaf binding, it emits a synthetic root
completion after the buffered leaf start, and it counts Host authorization and
spawn calls. The test has a 10-second Node test timeout and continues to assert
the durable binding acknowledgement with exactly one spawn (no replacement).
