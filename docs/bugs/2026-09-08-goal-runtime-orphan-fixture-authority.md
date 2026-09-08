# Runtime orphan fixture authority

## Provenance

The runtime-host orphan fixture previously called the workspace service directly
after `goal_init`.  That receipt had no durable `task.dispatch_requested` and
used the synthetic `fixture-root` owner, so `goal_status` correctly returned
`REINSPECTION_REQUIRED`; production was already fail-closed.

## Fixture sequence

The fixture now records the RED case first, then releases its test receipt and
uses public `goal_status` followed by `goal_dispatch`.  It reads the durable
dispatch request and allocates the service receipt with its exact workspace ID,
contract hash, attempt, origin fields, base commit, Host root session ID, and
projection execution revision.  The verified inventory then persists a
session-bound orphan challenge and returns `AWAITING_USER_DECISION`.
