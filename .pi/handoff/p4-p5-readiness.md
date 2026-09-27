# P4/P5 readiness scan

Date: 2026-09-20  
Scope: read-only research for `P4-T7` and `P5-T8`; no implementation decision is made here.

## Preconditions and dependency graph

```text
P3-T6 fail-closed acceptance
  └─ P4-T7: recoverOrphanRun + crash/restart matrix
       ├─ P0: session content/provenance eligibility
       ├─ P2: OwnerReceipt/processBirth/generation/lease CAS
       ├─ P3: replay barrier + replay + processing ACK; supervisor fencing
       ├─ workspace public managed-workspace.v2 receipt/reference validation
       └─ real-Pi/Colima fixture lane for real crash boundaries
            └─ P5-T8: SchedulerRecoveryOutcome union + adapter consumption
                 └─ inject only accepted P4 public outcome into scheduler extension
```

P4 must not start until the P3-T6 fail-closed slice is accepted. P5 additionally requires an implemented and accepted P4 public outcome; it must not reconstruct orphan state from scheduler internals or a private durable root.

## P4-T7: current reusable entry points and gaps

### Production entry points

| Entry | Reusable behavior | P4 gap / required boundary |
| --- | --- | --- |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts` | `createRecoveryResumeOrchestrator()` has event-captured `rpc.resume`, run/asyncDir/session/pid/agent identity checks, per-intent in-flight/completed dedupe, durable `recoveryStatus()` polling, `resumeDebt()`, registration before `activateResume()`, and traces. | This is the existing integration-resume path, returning `{state: "activated"|"debt"|"skipped"}`. Its default `startTimeoutMs` is **15_000** and must remain unchanged. It has no `recoverOrphanRun`, no P0/P2/workspace composition gate, no orphan outcome union, and no 120s standalone-child path. |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` | `connectRuntimeCoordinator()` starts the coordinator, connects the root broker client, creates the recovery orchestrator only when typed `rpc.resume` exists, and disposes it on close. `beforeUpstreamSessionStart` creates `AuthorityStore` under the private root-broker authority location. | Natural runtime composition/wiring location for P4; add the independent 120s path here or through an explicitly injected dependency, without changing the existing orchestrator constructor/default. Preserve no-RPC observation behavior. |
| `root-broker-server.ts` / `authority-store.ts` | Authorized run registration captures process-birth identity, durably creates OwnerReceipt + lease; `rebindRun()` validates source/resumed receipts, generation/revision/processBirth, verified lifecycle session, then uses `AuthorityStore.associate()`; store has durable locked CAS for create/associate/issue/renew/release. `renewHeartbeats()` supplies run/lease/generation/processBirth/revision/sequence and only publishes a lease update. | P4 should consume these public owner/rebind/lease operations rather than write the authority index. Current `associate()` removes source lease and returns resumed receipt; P4 needs an explicit bounded resumed lease issuance/rebind plan and tests for expiry at durable `expiresAt`. No existing standalone child self-expiry mechanism was found in this scan. |
| `supervisor-replay.ts` | `createSupervisorReplay().replaySupervisor()` validates OwnerReceipt and cursor, starts a barrier, replays, records processing receipt before effect, makes completion idempotent, ACKs after effect, and switches live after the high-water barrier. Any error returns `blocked-unknown`. | Reuse after successful authority/workspace validation and rebind. P4 must retain evidence/provenance for failures and must not make replay/control delivery implicit in completion or lease actions. |
| `supervisor-control-plane.ts` | Typed request/intents with owner-generation/runtime fencing, reply-before-steer rule, idempotency, and `markProgressStalled()` returning only `stalled-suspected`. | P4 recovery/heartbeat must preserve this delivery protocol and not call send/turn/reply/steer/resume/followUp/spawn. Progress stall remains a control-plane state awaiting the host. |

### P4 WritePaths and test reuse

Planned P4 WritePaths are exactly:

1. `packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`
2. `test/recovery-resume-orchestrator.test.mjs` (modify)
3. `test/subagent-orphan-recovery-crash.test.mjs` (create)
4. `test/subagent-orphan-recovery.integration.test.mjs` (create)

`test/recovery-resume-orchestrator.test.mjs` is the immediate reusable fake-RPC/event-bus seam. It already covers success ordering, duplicate delivery, child-start timeout, identity mismatch, `starting` replay, root filtering, attempt cap, durable polling/debt, and trace phases. It is the correct non-real-binary RED base for:

- exported `recoverOrphanRun(input)` input/output validation;
- exact `childStartTimeoutMs: 120_000` on the new standalone route while an existing integration-created orchestrator still uses 15,000ms;
- explicit `rebound | blocked-unknown | debt` outcomes and retained provenance;
- duplicate recovery/CAS conflict/old generation failure without terminal synthesis;
- expiry decision based only on `expiresAt`, no automatic turn, and the prohibited heartbeat/renew call list.

The two new P4 files should split responsibility:

- `subagent-orphan-recovery-crash.test.mjs`: serial matrix fixtures and every required row field (`injectionPoint`, `initialFacts`, `expectedOutcome`, `retainedEvidence`, `forbiddenMutations`, `provenance`, `clockStrategy`, `processStrategy`), including trusted capture-seam same-PID/different-`processBirth` fixture.
- `subagent-orphan-recovery.integration.test.mjs`: real two-Node-process capture/rebind boundary, eligible/non-eligible session, host-crash-renew stop, and child-expiry-exit behavior. It must say that the fixture does not manipulate OS PID reuse.

### P4 minimum RED and verification

1. Create both P4 test files and add focused assertions to the existing orchestrator test. Do not import a missing module: import the existing orchestrator module and assert its missing export/new behavior so RED is an assertion/API failure, not `ERR_MODULE_NOT_FOUND`.
2. First RED command:

```sh
node --test test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs test/recovery-resume-orchestrator.test.mjs
```

3. Green command is identical. Full P4 regression:

```sh
node --test test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs test/root-subagent-broker.test.mjs test/subagent-delivery-recovery.test.mjs test/subagent-orphan-recovery-crash.test.mjs test/subagent-orphan-recovery.integration.test.mjs
```

## P5-T8: minimum typed-outcome surface

### Current entry points

| Entry | Current role | Minimal P5 change |
| --- | --- | --- |
| `src/task-scheduler/adapter.ts` | JavaScript membrane around upstream scheduler. It exports `registerTaskSchedulerAdapter`, manages session epoch/polling/footer, restricts tools/events, and guards persistent content. No recovery type, source, registry, or orphan API exists. | Export a real public `SchedulerRecoveryOutcome` union and `consumeRecoveryOutcome(outcome)`. Keep this outcome handling outside the upstream membrane and do not add a fake trigger/cancel/recover scheduler API or access a private durable root. |
| `pi/extensions/task-scheduler.ts` | Thin TypeScript entrypoint that only calls `registerTaskSchedulerAdapter(pi)`. | Once the adapter union is tested, wire a P4-produced public outcome through an explicit runtime-provided bridge/source into `consumeRecoveryOutcome`; preserve the existing default entrypoint behavior when no P4 source exists. |

No `recoverOrphanRun`, recovery-outcome type, or cross-extension bridge currently exists under `src/` or `pi/`. Therefore the P5 wiring needs a small, explicitly owned public injection seam; it cannot be implemented by importing P4 private storage from the scheduler adapter. The owner/registration point for that bridge remains a residual integration design risk to settle at P5 implementation time.

### Existing scheduler tests and their P5 allocations

| Test | Existing reusable fixture | P5 RED assertions to add |
| --- | --- | --- |
| `test/task-scheduler-adapter.test.mjs` | Direct adapter import, fake upstream extension, fake Pi host, session contexts, injected clock. | Freeze all three union variants; assert duplicate `runId` dedupe; assert terminal and `blocked-unknown` do not schedule/restart; retain session-epoch/shutdown isolation. This is the primary unit RED seam. |
| `test/task-scheduler-package-isolation.test.mjs` | Static package/settings/setup isolation checks. | Assert scheduler recovery wiring does not add package loading or a private durable-root dependency; preserve package isolation. |
| `test/task-scheduler-runtime.integration.mjs` | Exact upstream scheduler default extension exercised through restricted membrane. | Feed the extension only a public P4-shaped outcome and verify real membrane/session/shutdown behavior does not regress. Do not require real Pi. |

### P5 WritePaths, RED, and validation

P5 WritePaths are exactly:

1. `src/task-scheduler/adapter.ts`
2. `pi/extensions/task-scheduler.ts`
3. `test/task-scheduler-adapter.test.mjs`
4. `test/task-scheduler-package-isolation.test.mjs`
5. `test/task-scheduler-runtime.integration.mjs`

Minimum RED: add assertions only to those existing three tests for union acceptance/rejection, one-record-per-run dedupe, and terminal/blocked non-restart behavior. First run:

```sh
node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs
```

After the adapter surface is green, inject P4's already-accepted outcome in the extension. Final boundary validation:

```sh
npm run typecheck:subagents-enhanced && npm --prefix packages/pi-subagents-enhanced test && node --test test/recovery-resume-orchestrator.test.mjs test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs
```

## Real Pi / crash execution conditions

`test/pi-subagents-runtime.integration.mjs` reads `process.env.PI_REAL_BIN` once as `piBinary`. Its installed-runtime test requires that variable and executes `PI_REAL_BIN --version`; its top-level RPC scenarios spawn that same binary with the runtime/provider extensions. Consequently it fails rather than skips when `PI_REAL_BIN` is unset. In this scan environment `PI_REAL_BIN` is unset, although `pi` resolves to `/opt/homebrew/bin/pi`; setting the variable explicitly and checking its supported version is required before using this test as real-Pi evidence.

For P4, a real two-Node-process crash/rebind test can be developed before real Pi availability because it can use Node child processes plus the existing faked/injected RPC, event bus, clock, process-birth capture seam, broker/store, and replay interfaces. This supports a valuable RED split without `PI_REAL_BIN`:

1. unit contract RED in `recovery-resume-orchestrator.test.mjs`;
2. serial Node-process matrix fixture RED/green in the two new P4 test files;
3. later real-Pi scenario (and, if process/container isolation is required, Colima) to prove only genuine host crash/capture/rebind behavior.

`colima` resolves to `/opt/homebrew/bin/colima`, but its daemon/profile state was intentionally not queried during this read-only readiness scan. Real crash acceptance remains blocked until the executor explicitly supplies `PI_REAL_BIN` and/or a verified Colima environment. Do not treat the same-PID/different-processBirth fixture as OS PID-reuse proof.

## Commands run during readiness scan

```sh
node --test test/recovery-resume-orchestrator.test.mjs
# 14 passed, 0 failed

node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-package-isolation.test.mjs test/task-scheduler-runtime.integration.mjs
# 17 passed, 0 failed

git diff --cached --name-only
# no output (no staged files)
```

## Residual risks

1. P3-T6 fail-closed acceptance remains the prerequisite gate; P4/P5 code must not begin before it is accepted.
2. Existing recovery orchestration is integration-resume only and has no P4 standalone 120s/public-outcome implementation; preserve its 15s default exactly.
3. Durable authority supports the required receipt/generation/processBirth/lease CAS pieces, but P4 still needs composition ordering, lease-expiry/self-exit behavior, and explicit evidence retention.
4. No existing scheduler-to-P4 public bridge exists. P5 must define an injected public source/registration seam without coupling the scheduler adapter to runtime private state.
5. `PI_REAL_BIN` is unset here; real-Pi crash coverage cannot be claimed. Colima executable availability alone is not daemon/readiness evidence.
6. The repository had unrelated in-progress modifications before this scan. This report is the only scan-created file and no staged files were present.
