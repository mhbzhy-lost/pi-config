# Goal extension fixture migration blocked by canonical orphan recovery

## Current RED evidence (2026-09-07)

A fresh complete run:

```sh
node --test test/goal-engine-extension.integration.mjs
```

completed in `132295.509333ms`: **138 tests, 81 pass, 57 fail**.  No test-name
pattern exceeded 60 seconds.

The retained fixture migration makes the public coordinator allocate and bind a
real `ManagedWorkspaceService` receipt.  The helper now returns only that
canonical receipt; it does not add legacy `branch`, `attempt`, `phase`, or
`released` aliases.  Test resource inspection obtains a ledger record path
only after a receipt exists, so invalid-record tests do not call filesystem
APIs with `undefined` paths.

Focused GREEN evidence:

```sh
node --test --test-name-pattern='(historical tracked state dispatch|goal_dispatch before-durable append failure|goal_dispatch durable-then-throw)' test/goal-engine-extension.integration.mjs
# 3 pass, 0 fail, 3092.796083ms
```

## Blocking production path

The remaining orphan and preserved-release tests currently manufacture orphan
state by rolling back `events.jsonl` and `projection.json`.  That is not a
legal fixture under the canonical public lifecycle and is explicitly excluded
from this migration.  When these tests subsequently invoke the legal public
path, it fails at:

```
goal_integrate
  -> src/goal-engine/extension.ts:3115 workspaceMutationError
  -> GIT_INFRASTRUCTURE_ERROR: workspace snapshot mismatch for task t1
```

This blocks orphan recovery, preserved release, and orphan human-challenge
coverage.  The fixture cannot accept that generic infrastructure error: doing
so would remove the required target-dimension identity/orphan assertion.

A second production divergence appears for identity negatives after a legal
receipt is allocated and exactly one workspace identity dimension is mutated:

```
goal_settle / goal_integrate
  -> src/goal-engine/extension.ts:2184 workspaceMutationError
  -> GIT_INFRASTRUCTURE_ERROR: managed worktree Git identity changed
```

rather than the target identity classification expected by those tests.

## Required follow-up

The production owner must provide a legal orphan construction path: create a
real managed-service terminal side effect and inject the Goal append failure,
rather than rolling back projection files.  It must also preserve the specific
identity/orphan classification through the canonical workspace inspection
boundary.  Fixture work must then build each negative from a legal receipt and
mutate exactly its target record/Git dimension.

No production fallback or legacy receipt fields were introduced here.
