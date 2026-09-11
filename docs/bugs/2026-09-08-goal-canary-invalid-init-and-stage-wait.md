# Canary planned.v1 init validation must fail the current stage

## Provenance and first deviation

The redacted canary diagnostic was produced through the real Pi RPC event stream. Its `goal_init` tool end returned `isError` after about seven seconds because the planned task contained an extra `agentProfile` field and `commit` in acceptance evidence. The waiter then advanced to wait for `goal_status_start` with its 120-second deadline. A tool error is a valid production event, so treating it as an absent next-stage event was a production harness defect rather than fixture-only compatibility behavior.

## Repair

The local JSONL canary client now records an error end as a failed `<tool>_end` phase and rejects that phase's waiter immediately. The failure message names only the stage and tool (for example, `stage goal_init_end failed: tool goal_init returned error`); it does not include tool-result content or any capability. A later phase cannot be awaited after that rejection. The existing attempt selector remains fail-closed: more than one attempt, including a failed attempt followed by success, is rejected.

`smokeGoalInitInput` is the single canonical planned.v1 fixture. Its task has only `id`, `description`, `deps`, `writePaths`, `acceptance`, and `workflow`; it writes `src/smoke.ts` and `test/smoke.test.mjs`, uses `tdd`, and accepts only `changed-files` and `tests` evidence. The exact JSON serialization is embedded verbatim in the env-gated smoke prompt. The prompt explicitly forbids `agentProfile`, `execution`, commit evidence, and other extra fields; the dispatch compiler owns the later clean-commit requirement.

## Local coverage

- A spawned local JSONL fixture emits `goal_init` end `result.isError` with a synthetic capability. It fails in under one second rather than consuming the five-second next-stage deadline, requests abort, and proves the public error has no capability.
- A failed-then-successful `goal_init` fixture is rejected as multiple attempts.
- The real production `goal_init` tool is loaded locally and accepts the canonical fixture on its first and only call; its ledger is then located through the isolated Goal state root.

The real RPC/model canary remains skipped unless `PI_RUN_GOAL_REAL_CANARY=1`; no real provider, model, or subagent is called by the local tests.
