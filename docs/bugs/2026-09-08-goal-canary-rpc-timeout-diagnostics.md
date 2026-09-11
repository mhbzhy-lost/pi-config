# Canary RPC timeout diagnostics retained outside cleanup

## Reproduction

The local JSONL fixture accepts `prompt` but never emits `agent_settled`. The historical failure path wrote `rpc-smoke-blocked-events.json` below the temporary `agentDir`; the `finally` cleanup removes that directory, making the diagnostic unrecoverable.

## Repair

The test-local RPC client now records a bounded, redacted phase timeline using monotonic nanoseconds for:

- prompt response;
- `goal_init`, `goal_status`, `goal_dispatch`, and `subagent` start/end; and
- `agent_settled`.

Failures write a bounded JSON diagnostic to `/tmp/goal-r13-canary-failures/<run-id>.json` (or `GOAL_R13_CANARY_FAILURE_ROOT` for a test-provided owner root). The owner directory is mode `0700` and the file is mode `0600`. Diagnostics are passed through `redactRpc`; no credentials are copied or persisted.

Each RPC stage has one deadline. A deadline invokes RPC `abort`, terminates the child, and the existing `finally` removes the temporary cwd and agent directory. Timers are unreferenced and cleared. The 900-second settled deadline remains a single terminal-stage deadline, rather than an additional post-stage wait.

## Coverage

Local fixtures cover no-settled cleanup survival, all phase timeline entries, a missing subagent end, extension UI response, abort/terminate, and permissions. The actual model smoke remains skipped unless `PI_RUN_GOAL_REAL_CANARY=1` is explicitly set.
