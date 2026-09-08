# Goal executor-binding final six

## 1. Contract drift before RPC
- **Actual (RED):** a changed dispatched Goal contract reached model discovery and failed `ERR_MODULE_NOT_FOUND` before the coordinator checked the ticket.
- **Expected:** production coordinator rejects it as `EXECUTOR_CONTRACT_MISMATCH` before RPC/spawn; the attempt remains unbound.
- **Call chain:** `subagent.execute` → `executeCoding` → model discovery (incorrectly first) → coordinator/RPC.
- **Production reachability:** yes; this is the coding spawn path.
- **Fix:** perform coordinator preflight immediately after IR compilation and translate a dispatched-contract hash mismatch at the coordinator boundary.

## 2. Non-Goal coding and generic dispatch
- **Actual/expected:** unrelated dispatch must not acquire a Goal ticket or require Goal settlement proof.
- **Call chain:** `executeCoding`/`executeGeneric` → no matching coordinator ticket → detached workflow.
- **Production reachability:** yes; fixture asserts ordinary user dispatch.

## 3. Official active-handle recovery
- **Actual/expected:** only the registered Host/broker proof for the exact Goal identity may restore a missing binding; recovery only binds and never settles.
- **Call chain:** `goal_status` → `recoverUnboundRunBinding` → registered broker proof → coordinator bind.
- **Production reachability:** yes.

## 4. Runtime v2 writer
- **Actual/expected:** `goal-runtime.v2` is read-only and must fail before event/workspace side effects.
- **Call chain:** `goal_init` → generation writable preflight.
- **Production reachability:** yes; no writer restoration.

## 5. Exact coding RPC fixture
- **Actual/expected:** Goal coding uses the current `requestId === spawnKey` ABI and deterministic lifecycle adapter, not a real child.
- **Call chain:** coordinator ticket → workflow RPC spawn → lifecycle adapter → bind.
- **Production reachability:** yes.

## 6. Hand-authored terminal fixture
- **Actual/expected:** fixture validates parser recovery only; a fresh broker cannot promote a hand-authored sidecar to ownership, proof, settlement, or stop authority.
- **Call chain:** status → fresh broker terminal inspection → attention.
- **Production reachability:** fixture-only; production requires registered authorization and durable binding authority.
