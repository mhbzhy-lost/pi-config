# P3 canary smoke contract and diagnostic redaction

## First deviation

The saved real-canary diagnostic showed an initial `goal_init` attempt that mixed planned `tasks` with a top-level `execution` payload. A later `goal_init` attempt succeeded, but a retry cannot safely establish that the failed attempt had no state side effect: there is no authoritative side-effect-free field in the tool event contract.

The same smoke prompt also required the dispatch contract's clean commit while telling the executor to make no file changes. That task cannot settle successfully. The saved failure diagnostic contained an expired temporary action capability nested in tool content.

## Repair

`toolEndForStart` now pairs each start with its end by `toolCallId` and fails closed unless every required Goal tool has exactly one start and one successful matching end. It records failed attempt IDs and reasons on the thrown error. Retries, duplicate ends, missing ends, and error ends therefore cannot be selected away or hide a state-changing failure.

The env-gated real smoke now tells the root model that `goal_init` contains only the objective and planned top-level tasks, not `execution`. Its single executor task is achievable in a temporary repository: it may write `src/smoke.ts` and `test/smoke.test.mjs`, writes the failing Node test first, implements the source, runs the Node test, and creates the required clean commit.

Diagnostic redaction is structural and recursive. Sensitive keys (`action_token`, `actionToken`, `token`, `apiKey`, `secret`, `password`, `authorization`, and `ownerToken`) are replaced before serialization, including inside JSON-string tool content. Non-sensitive correlation fields such as `runId`, `asyncDir`, and `phase` remain available.

## Coverage and gate

The local fixture uses a failed then successful `goal_init` with different call IDs and verifies that the retry fails closed while reporting the failed attempt. It also proves the raw capability is absent from diagnostic strings and a persisted diagnostic file while the non-sensitive correlation fields remain. No credential source is read.

The real RPC smoke remains skipped unless `PI_RUN_GOAL_REAL_CANARY=1`; this repair runs only the local canary tests. The exact expired diagnostic named in the task was removed without enumerating or touching other diagnostics.
