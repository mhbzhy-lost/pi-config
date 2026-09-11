# Host restart dirty-origin fixture (2026-09-07)

## Provenance

The Host restart integration fixture created its Goal state directory under the
temporary Git origin before allocating a managed workspace. That untracked
directory correctly triggered `MANAGED_WORKSPACE_ORIGIN_DIRTY` in the
production origin preflight.

## Resolution

The fixture now uses an external temporary `stateRoot`, asserts that allocation
leaves the origin clean, and removes that state directory during teardown.
Production workspace lifecycle and its dirty-origin rejection remain unchanged.

## Follow-up boundary blocker

After the fixture passes allocation, the singleton reaches an independent Host
boundary mismatch: `allocateGoalWorkspaceFixture` receives the public managed
workspace receipt, whose exact fields are `schemaVersion`, `workspaceId`,
`leaseId`, `owner`, `originRoot`, `requestedCwd`, `originRef`, `baseCommit`,
`path`, `dispatchCwd`, `branchRef`, `state`, `run`, `disposition`, and
`cleanupDebt` (`packages/pi-subagents-enhanced/src/workspace/contract.ts`).
It therefore has no `ownerToken`. The first divergence is the restart fixture's
`hash(lease.ownerToken)` request construction, followed by production Host
checks of `sha(lease.ownerToken)` in
`src/goal-engine/production-runtime-host.ts`. The private ledger keeps that
token (`packages/pi-subagents-enhanced/src/workspace/ledger.ts`), while the
workspace public receipt boundary intentionally exposes only `leaseId`.

This fixture must not leak the private token to bridge that boundary. A separate
production Host TDD change must consume public owner authority instead.
