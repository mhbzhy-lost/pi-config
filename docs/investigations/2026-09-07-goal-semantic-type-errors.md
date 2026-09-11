# Goal semantic type-error investigation (T7)

## Reproduction

`npm run typecheck:goal-engine` was run on 2026-09-07 against
`tsconfig.goal-engine.json`. It exited 2 with **750** diagnostics; the complete
untruncated command output was retained at `/tmp/goal-typecheck-initial.log`
for this work session. The config's `include` explicitly covers
`src/goal-engine/**/*.ts`, `pi/extensions/goal-engine.ts`, and enhanced package
`src`, `extensions`, `child-extensions`, and `scripts`; this is therefore not a
root-check coverage gap.

## Grouping

| Root cause / owner | Diagnostics | Primary files |
| --- | ---: | --- |
| Goal extension option/service contracts (`createGoalEngineExtension`, legacy workspace host, disposition and settlement return shapes) | 150 | `src/goal-engine/extension.ts` |
| Broker extension composition, canonical envelope and error contracts | 74 | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` |
| Managed validation runtime-host service contracts | 66 | `src/goal-engine/managed-validation.ts` |
| Repair/observation/human-decision input contracts | 100 | `src/goal-engine/repair-policy.ts`, `observation-runner.ts`, `human-decision.ts` |
| Event/projection settlement discriminated union | 50 | `src/goal-engine/events.ts` |
| Managed-workspace public service / git / ledger contracts | 84 | `packages/pi-subagents-enhanced/src/workspace/{service,git-worktree,ledger}.ts` |
| Goal finalization/final review result union | 29 | `src/goal-engine/{finalization,final-review}.ts` |
| Runtime host, generation capability literals, remaining Goal boundaries | 113 | `src/goal-engine/**` |
| Broker protocol, authorization, dispatch IR and supporting UI contracts | 34 | `packages/pi-subagents-enhanced/src/**` |

Error-code totals: TS2339 527, TS2554 126, TS2353 38, TS2367 20,
TS2345 15, TS2322 8, TS2365 6, TS2698 3, TS2349 2, TS2769 2,
TS1345 2, TS2538 1.

The high-fanout diagnosis is declaration loss at existing JavaScript-shaped
TypeScript boundaries: default `{}` parameters infer an empty object and
legacy throw-only service stubs infer zero-argument `void` functions. The
proper correction is owner-level exact input/result declarations and narrowing
at dynamic JSON/host boundaries—not compiler suppression or broad assertions.

## Ownership constraints

* Generation capability values belong to `generation-capabilities.ts`; they
  require one explicit literal-union matrix.
* Final-review callers must narrow the provider-failure result before accessing
  recorded-result fields.
* Workspace methods must expose their already validated public receipt shapes;
  Goal adapters must consume those shapes without altering ledger validation.
* Broker envelope fields and ExtensionAPI composition options belong to the
  enhanced package owner interfaces, rather than individual call-site casts.

## Final bounded round and owner handoff

The post-change bounded semantic run remains fail-closed at **713** errors
(down 37 from 750). Its complete, unabridged compiler output is appended below
under `Final tsc output`; no diagnostics were suppressed.

### Owner slices

| Slice | Files/errors | Error codes | Shared dependency edge |
| --- | --- | --- | --- |
| A: Goal core | 21 files / 467 | TS2339 372; TS2554 54; TS2353 30; TS2345 4; TS2365 2; TS1345 2; TS2322/TS2538/TS2698 1 each | `extension` consumes event projection/settlement, runtime-host facade and managed-validation receipts. |
| B: subagent-dispatch | 15 files / 130 | TS2339 98; TS2345 9; TS2554 8; TS2353 5; TS2322 3; TS2365/TS2349/TS2698 2 each; TS2769 1 | canonical Broker envelope feeds Goal dispatch/run-binding and workspace authority. |
| C: goal-support | 1 file / 9 | TS2339 8; TS2554 1 | normalized settlement evidence is consumed by A events/finalization. |
| D: workspace | 4 files / 89 | TS2554 62; TS2339 26; TS2353 1 | public receipt/service contract feeds A managed workspace/runtime host and B broker. |
| pi entry/scripts and other package entrypoints | 6 files / 18 | TS2339 7; TS2322 4; TS2353/TS2345/TS2365 2 each; TS2554 1 | ExtensionAPI composition connects A and B. |

A file counts: `extension.ts` 134, `managed-validation.ts` 66,
`repair-policy.ts` 51, `events.ts` 32, `finalization.ts` 27,
`observation-runner.ts` 24, `continuity.ts` and `human-decision.ts` 19 each,
`production-runtime-host.ts` 16. B file counts: dispatch `extension.ts` 74,
`workflow-spawn.ts` 14, `root-broker-protocol.ts` and `runtime-membrane.ts` 7
each. D file counts: `service.ts` 34, `git-worktree.ts` 27, `ledger.ts` 23,
`administration.ts` 5.

### Classification

The 126 remaining TS2554 diagnostics and most TS2339/TS2353 clusters are
missing declarations for already runtime-validated shapes (default `{}` options,
throw-only legacy stubs, and public service receipts). They are type-contract
work. Potential runtime-boundary investigations—not to be silently typed
through—are: Goal legacy workspace stubs currently throw while callers expect
receipts; Broker canonical envelope argument-count mismatches; and all union
branches where a failure/attention result is consumed as a successful receipt.
These need owner-local RED tests if runtime shape is not already covered.

### Final tsc output

```text

> typecheck:goal-engine
> tsc --noEmit -p tsconfig.goal-engine.json

packages/pi-subagents-enhanced/extensions/custom-footer.ts(22,42): error TS2322: Type 'number' is not assignable to type '1'.
packages/pi-subagents-enhanced/extensions/subagent-runtime.ts(154,11): error TS2322: Type '(_event: any, ctx: any) => Promise<void>' is not assignable to type '() => Promise<void>'.
  Target signature provides too few arguments. Expected 2 or more, but got 0.
packages/pi-subagents-enhanced/extensions/subagent-runtime.ts(170,11): error TS2353: Object literal may only specify known properties, and 'terminalProofProvider' does not exist in type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/extensions/subagent-runtime.ts(218,15): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(33,10): error TS2339: Property 'code' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(34,10): error TS2339: Property 'detail' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(35,37): error TS2339: Property 'keypath' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(188,40): error TS2339: Property 'worktree' does not exist on type '{ cwd: string; timeoutMs: any; }'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(209,50): error TS2339: Property 'cwd' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts(269,39): error TS2554: Expected 4 arguments, but got 3.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(66,32): error TS2554: Expected 2 arguments, but got 1.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(75,62): error TS2339: Property 'expectedIdentity' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(76,43): error TS2339: Property 'expectedCriteria' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(96,15): error TS2339: Property 'outcome' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(97,17): error TS2339: Property 'outcome' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(97,52): error TS2339: Property 'outcome' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(99,18): error TS2339: Property 'outcome' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(99,109): error TS2339: Property 'outcome' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/goal-support/settlement-evidence.ts(132,62): error TS2339: Property 'directory' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts(5,10): error TS2339: Property 'code' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts(6,10): error TS2339: Property 'detail' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts(7,37): error TS2339: Property 'keypath' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(194,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(200,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(247,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(258,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(267,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(285,5): error TS2353: Object literal may only specify known properties, and 'workflowKey' does not exist in type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(309,5): error TS2353: Object literal may only specify known properties, and 'workflowKey' does not exist in type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(341,53): error TS2339: Property 'runId' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(400,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(407,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(442,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(452,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(499,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(507,72): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(511,72): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(535,32): error TS2339: Property 'model' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'model' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(535,85): error TS2339: Property 'model' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'model' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(544,13): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(550,13): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(575,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(599,15): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(604,15): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(612,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(620,73): error TS2339: Property 'runId' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(620,124): error TS2339: Property 'asyncDir' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(622,13): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(627,34): error TS2339: Property 'runId' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(635,5): error TS2698: Spread types may only be created from object types.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(641,91): error TS2339: Property 'warnings' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'warnings' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(641,124): error TS2339: Property 'warnings' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'warnings' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(647,12): error TS2554: Expected 4 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(652,35): error TS2339: Property 'model' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'model' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(652,114): error TS2339: Property 'model' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'model' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(675,52): error TS2345: Argument of type '{ workflowKey: string; agent: any; sessionId: any; timeoutMs: any; params: { artifacts: boolean; worktree: boolean; mission: boolean; chatProgress: string; timeoutMs?: any; workflowScript: string; cwd: any; context: any; async: boolean; }; titleRegistry: any; onBinding: (observed: any) => void; }' is not assignable to parameter of type '{ workflowKey: any; agent: any; sessionId: any; timeoutMs: any; params: any; identity: any; titleRegistry: any; onBinding: any; }'.
  Property 'identity' is missing in type '{ workflowKey: string; agent: any; sessionId: any; timeoutMs: any; params: { artifacts: boolean; worktree: boolean; mission: boolean; chatProgress: string; timeoutMs?: any; workflowScript: string; cwd: any; context: any; async: boolean; }; titleRegistry: any; onBinding: (observed: any) => void; }' but required in type '{ workflowKey: any; agent: any; sessionId: any; timeoutMs: any; params: any; identity: any; titleRegistry: any; onBinding: any; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(687,17): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(697,13): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(703,34): error TS2339: Property 'runId' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(705,92): error TS2339: Property 'runId' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(707,16): error TS2698: Spread types may only be created from object types.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(707,129): error TS2339: Property 'warnings' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'warnings' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(707,162): error TS2339: Property 'warnings' does not exist on type '{ source: string; } | { warnings?: ModelSelectionWarning[]; model: string; source: "default" | "qualified" | "agent-candidates" | "global-catalog"; requestedModel: any; }'.
  Property 'warnings' does not exist on type '{ source: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(712,12): error TS2554: Expected 4 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(735,12): error TS2554: Expected 4 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(848,15): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(876,5): error TS2339: Property 'supervisorAdapter' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(881,5): error TS2339: Property 'renderSubagentCall' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(882,5): error TS2339: Property 'renderSubagentResult' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(883,5): error TS2339: Property 'renderSupervisorCall' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(884,5): error TS2339: Property 'renderSupervisorResult' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(886,5): error TS2339: Property 'resolveCodingSpawnIdentity' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(887,5): error TS2339: Property 'goalExecutorCoordinator' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(888,5): error TS2339: Property 'workflowChildStartTimeoutMs' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(893,5): error TS2339: Property 'onSupervisorRequest' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(894,5): error TS2339: Property 'workspaceService' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(895,5): error TS2339: Property 'resolveRootSessionId' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(896,5): error TS2339: Property 'registerAuthorizedRun' does not exist on type '{ rpc?: Readonly<{ ping(options: any): Promise<unknown>; spawn(params: {}, options: any): Promise<unknown>; status(params: any, options: any): Promise<unknown>; resume(params: any, options: any): Promise<...>; steer(params: any, options: any): Promise<...>; interrupt(params: any, options: any): Promise<...>; stop(pa...'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(978,68): error TS2339: Property 'code' does not exist on type 'CodingDispatchContractError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(984,5): error TS2353: Object literal may only specify known properties, and 'renderCall' does not exist in type '{ name?: string; label?: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1015,29): error TS2554: Expected 0 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1016,34): error TS2554: Expected 0 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1042,34): error TS2554: Expected 0 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1063,15): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1082,3): error TS2339: Property 'bootstrap' does not exist on type '{ beforeUpstreamSessionStart?: () => Promise<void>; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1083,3): error TS2339: Property 'completionNotifierFactory' does not exist on type '{ beforeUpstreamSessionStart?: () => Promise<void>; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1084,3): error TS2339: Property 'resolveSessionId' does not exist on type '{ beforeUpstreamSessionStart?: () => Promise<void>; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1085,3): error TS2339: Property 'beforeRuntimeDispose' does not exist on type '{ beforeUpstreamSessionStart?: () => Promise<void>; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1093,33): error TS2339: Property 'titleRegistry' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1093,75): error TS2339: Property 'cleanupStore' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1098,32): error TS2339: Property 'cleanupStore' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1162,5): error TS2353: Object literal may only specify known properties, and 'supervisorAdapter' does not exist in type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1201,11): error TS2353: Object literal may only specify known properties, and 'titleRegistry' does not exist in type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1225,11): error TS2322: Type '(event: any, ctx: any) => Promise<void>' is not assignable to type '() => Promise<void>'.
  Target signature provides too few arguments. Expected 2 or more, but got 0.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1226,40): error TS2554: Expected 0 arguments, but got 2.
packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts(1230,11): error TS2322: Type '(event: any, ctx: any) => Promise<void>' is not assignable to type '() => Promise<void>'.
  Target signature provides too few arguments. Expected 2 or more, but got 0.
packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts(251,40): error TS2339: Property 'worktree' does not exist on type '{ cwd: string; timeoutMs: any; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts(276,50): error TS2339: Property 'cwd' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(142,53): error TS2345: Argument of type 'string | ((source: any, path: any) => any)' is not assignable to parameter of type 'string'.
  Type '(source: any, path: any) => any' is not assignable to type 'string'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(146,96): error TS2345: Argument of type 'string | ((source: any, path: any) => any)' is not assignable to parameter of type 'string'.
  Type '(source: any, path: any) => any' is not assignable to type 'string'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(159,75): error TS2345: Argument of type 'string | ((source: any, path: any) => any)' is not assignable to parameter of type 'string'.
  Type '(source: any, path: any) => any' is not assignable to type 'string'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(159,144): error TS2349: This expression is not callable.
  Not all constituents of type 'string | ((source: any, path: any) => any)' are callable.
    Type 'string' has no call signatures.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(160,97): error TS2345: Argument of type 'string | ((source: any, path: any) => any)' is not assignable to parameter of type 'string'.
  Type '(source: any, path: any) => any' is not assignable to type 'string'.
packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts(160,166): error TS2349: This expression is not callable.
  Not all constituents of type 'string | ((source: any, path: any) => any)' are callable.
    Type 'string' has no call signatures.
packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts(18,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts(29,11): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts(80,11): error TS2554: Expected 4 arguments, but got 3.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts(177,65): error TS2339: Property 'error' does not exist on type 'BrokerResponse'.
  Property 'error' does not exist on type '{ schemaVersion: "pi-root-subagent-broker-response.v1"; requestId: string; rootSessionId: string; callerRunId: string; success: true; data: unknown; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts(177,89): error TS2339: Property 'error' does not exist on type 'BrokerResponse'.
  Property 'error' does not exist on type '{ schemaVersion: "pi-root-subagent-broker-response.v1"; requestId: string; rootSessionId: string; callerRunId: string; success: true; data: unknown; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(412,41): error TS2345: Argument of type '(message: any) => void' is not assignable to parameter of type '(message: string) => never'.
  Type 'void' is not assignable to type 'never'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(419,13): error TS2339: Property 'some' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(422,15): error TS2769: No overload matches this call.
  Overload 1 of 2, '(iterable?: Iterable<unknown>): Set<unknown>', gave the following error.
    Argument of type 'unknown' is not assignable to parameter of type 'Iterable<unknown>'.
      Property '[Symbol.iterator]' is missing in type '{}' but required in type 'Iterable<unknown>'.
  Overload 2 of 2, '(values?: readonly any[]): Set<any>', gave the following error.
    Argument of type 'unknown' is not assignable to parameter of type 'readonly any[]'.
      Type '{}' is missing the following properties from type 'readonly any[]': length, concat, join, slice, and 26 more.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(422,37): error TS2339: Property 'length' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(423,70): error TS2339: Property 'includes' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(424,34): error TS2339: Property 'length' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts(464,42): error TS2345: Argument of type '(message: any) => void' is not assignable to parameter of type '(message: string) => never'.
  Type 'void' is not assignable to type 'never'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts(325,20): error TS2365: Operator '&' cannot be applied to types 'number | bigint' and 'number'.
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts(336,30): error TS2345: Argument of type 'OwnedRun' is not assignable to parameter of type 'FacadeRun'.
  Type 'OwnedRun' is missing the following properties from type 'FacadeRun': agent, kind
packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts(458,41): error TS2345: Argument of type 'OwnedRun' is not assignable to parameter of type 'FacadeRun'.
  Type 'OwnedRun' is missing the following properties from type 'FacadeRun': agent, kind
packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts(12,10): error TS2339: Property 'code' does not exist on type 'TypedSubagentRpcError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts(71,49): error TS2339: Property 'requestId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts(99,39): error TS2365: Operator '<=' cannot be applied to types 'unknown' and 'number'.
packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts(100,3): error TS2322: Type 'unknown' is not assignable to type 'number'.
packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts(185,194): error TS2339: Property 'expectedCriteria' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(84,3): error TS2339: Property 'supervisorAdapter' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(85,3): error TS2339: Property 'titleRegistry' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(87,3): error TS2339: Property 'suppressSuccessfulCompletion' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(89,3): error TS2339: Property 'captureSessionShutdown' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(90,3): error TS2339: Property 'captureSessionStart' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(91,3): error TS2339: Property 'captureEventSubscription' does not exist on type '{ suppressCompletionNotifications?: boolean; forceCompletionDisplay?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts(140,19): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts(17,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts(43,110): error TS2339: Property 'renderCall' does not exist on type '{ name?: string; label?: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts(43,122): error TS2339: Property 'renderResult' does not exist on type '{ name?: string; label?: string; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts(15,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(10,10): error TS2339: Property 'code' does not exist on type 'WorkflowSpawnError'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(61,3): error TS2339: Property 'workflowKey' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(62,3): error TS2339: Property 'agent' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(63,3): error TS2339: Property 'task' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(64,3): error TS2339: Property 'cwd' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(65,3): error TS2339: Property 'context' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(66,3): error TS2339: Property 'timeoutMs' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(68,3): error TS2339: Property 'acceptance' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(69,3): error TS2339: Property 'child' does not exist on type '{ artifacts?: boolean; }'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(129,3): error TS2339: Property 'workflowKey' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(130,3): error TS2339: Property 'agent' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(131,3): error TS2339: Property 'sessionId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(132,3): error TS2339: Property 'timeoutMs' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts(133,3): error TS2339: Property 'onBinding' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/tui/compact-rendering.ts(22,57): error TS2322: Type 'string' is not assignable to type 'boolean'.
packages/pi-subagents-enhanced/src/tui/compact-rendering.ts(141,78): error TS2339: Property 'trim' does not exist on type 'unknown'.
packages/pi-subagents-enhanced/src/tui/native-conversation.ts(197,51): error TS2345: Argument of type '{ role: string; customType: any; content: any; display: boolean; timestamp: any; }' is not assignable to parameter of type 'CustomMessage<unknown>'.
  Types of property 'role' are incompatible.
    Type 'string' is not assignable to type '"custom"'.
packages/pi-subagents-enhanced/src/tui/native-conversation.ts(234,35): error TS2353: Object literal may only specify known properties, and 'type' does not exist in type '{ content: { type: string; text?: string; data?: string; mimeType?: string; }[]; details?: any; isError: boolean; }'.
packages/pi-subagents-enhanced/src/tui/native-conversation.ts(251,59): error TS2345: Argument of type '{ truncated: true; }' is not assignable to parameter of type 'TruncationResult'.
  Type '{ truncated: true; }' is missing the following properties from type 'TruncationResult': content, truncatedBy, totalLines, totalBytes, and 6 more.
packages/pi-subagents-enhanced/src/workspace/administration.ts(27,95): error TS2339: Property 'originRoot' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/administration.ts(62,96): error TS2339: Property 'originRoot' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/administration.ts(63,61): error TS2353: Object literal may only specify known properties, and 'originRoot' does not exist in type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/administration.ts(71,97): error TS2339: Property 'plan' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/administration.ts(71,103): error TS2339: Property 'authorizations' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(17,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(53,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(56,63): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(73,47): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(75,62): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(77,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(79,44): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(121,39): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(123,59): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(130,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(134,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(147,45): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(150,41): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(164,34): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(171,47): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(175,13): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(185,64): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(186,46): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(232,41): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(241,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(243,47): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(246,43): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(251,16): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(263,54): error TS2339: Property 'expectedHead' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(267,47): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(270,69): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/git-worktree.ts(275,69): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(41,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(48,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(54,34): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(65,67): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(81,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(105,59): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(154,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(158,18): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(232,33): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(241,9): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(306,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(310,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(355,59): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(365,97): error TS2339: Property 'fault' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(383,37): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(400,17): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(411,32): error TS2339: Property 'originRoot' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(416,42): error TS2339: Property 'originRoot' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(416,54): error TS2339: Property 'leaseId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(420,71): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(432,19): error TS2339: Property 'originRoot' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(441,63): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/ledger.ts(444,62): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(20,9): error TS2339: Property 'code' does not exist on type 'Error'.
packages/pi-subagents-enhanced/src/workspace/service.ts(38,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(53,11): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(60,67): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(65,61): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(68,9): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(81,98): error TS2339: Property 'terminalProofProvider' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(81,121): error TS2339: Property 'fault' does not exist on type '{ stateRoot?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(112,50): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(113,54): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(114,77): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(133,55): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(135,48): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(137,47): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(148,60): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(174,21): error TS2339: Property 'workspaceId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/service.ts(174,34): error TS2339: Property 'terminalProof' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/service.ts(182,48): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(186,31): error TS2339: Property 'workspaceId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/service.ts(186,44): error TS2339: Property 'terminalProof' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/service.ts(188,48): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(204,63): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(225,22): error TS2339: Property 'workspaceId' does not exist on type '{ strategy?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(225,35): error TS2339: Property 'terminalProof' does not exist on type '{ strategy?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(225,50): error TS2339: Property 'disposition' does not exist on type '{ strategy?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(225,89): error TS2339: Property 'reason' does not exist on type '{ strategy?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(225,97): error TS2339: Property 'actionToken' does not exist on type '{ strategy?: string; }'.
packages/pi-subagents-enhanced/src/workspace/service.ts(228,87): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(231,48): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(236,13): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(239,13): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(260,22): error TS2339: Property 'workspaceId' does not exist on type '{}'.
packages/pi-subagents-enhanced/src/workspace/service.ts(262,51): error TS2554: Expected 3 arguments, but got 2.
packages/pi-subagents-enhanced/src/workspace/service.ts(274,24): error TS2339: Property 'originRoot' does not exist on type '{}'.
pi/extensions/goal-engine.ts(45,319): error TS2365: Operator '<' cannot be applied to types 'unknown' and 'number'.
pi/extensions/goal-engine.ts(45,343): error TS2365: Operator '>' cannot be applied to types 'unknown' and 'number'.
pi/extensions/goal-engine.ts(46,63): error TS2322: Type 'unknown' is not assignable to type 'number'.
src/goal-engine/condition-evidence.ts(11,54): error TS2339: Property 'expectedIdentity' does not exist on type '{}'.
src/goal-engine/condition-evidence.ts(11,72): error TS2339: Property 'resolvedClassifier' does not exist on type '{}'.
src/goal-engine/condition-evidence.ts(15,48): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/condition-evidence.ts(15,59): error TS2339: Property 'evidence' does not exist on type '{}'.
src/goal-engine/condition-evidence.ts(15,69): error TS2339: Property 'expectedIdentity' does not exist on type '{}'.
src/goal-engine/condition-validity.ts(35,42): error TS2339: Property 'projection' does not exist on type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/condition-validity.ts(35,54): error TS2339: Property 'worldSnapshot' does not exist on type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/continuity.ts(80,45): error TS2339: Property 'projections' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(80,58): error TS2339: Property 'cwd' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(80,75): error TS2339: Property 'sessionId' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(100,39): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/continuity.ts(100,51): error TS2339: Property 'sessionId' does not exist on type '{}'.
src/goal-engine/continuity.ts(100,62): error TS2339: Property 'leafId' does not exist on type '{}'.
src/goal-engine/continuity.ts(105,34): error TS2339: Property 'userText' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(105,44): error TS2339: Property 'userEntryId' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(105,69): error TS2339: Property 'sessionId' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(105,80): error TS2339: Property 'source' does not exist on type '{ paths?: undefined[]; }'.
src/goal-engine/continuity.ts(123,45): error TS2339: Property 'projection' does not exist on type '{ modifiedFiles?: undefined[]; }'.
src/goal-engine/continuity.ts(123,57): error TS2339: Property 'sessionId' does not exist on type '{ modifiedFiles?: undefined[]; }'.
src/goal-engine/continuity.ts(123,68): error TS2339: Property 'reason' does not exist on type '{ modifiedFiles?: undefined[]; }'.
src/goal-engine/continuity.ts(123,96): error TS2339: Property 'userEntryId' does not exist on type '{ modifiedFiles?: undefined[]; }'.
src/goal-engine/continuity.ts(146,42): error TS2339: Property 'status' does not exist on type 'unknown'.
src/goal-engine/continuity.ts(147,33): error TS2339: Property 'id' does not exist on type 'unknown'.
src/goal-engine/continuity.ts(147,56): error TS2339: Property 'id' does not exist on type 'unknown'.
src/goal-engine/continuity.ts(148,44): error TS2339: Property 'id' does not exist on type 'unknown'.
src/goal-engine/continuity.ts(148,83): error TS2339: Property 'summary' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(25,258): error TS2339: Property 'identity' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,237): error TS2339: Property 'capacity' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,254): error TS2339: Property 'capacity' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,289): error TS2339: Property 'holders' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,305): error TS2339: Property 'holders' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,443): error TS2339: Property 'holders' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(26,475): error TS2339: Property 'capacity' does not exist on type 'unknown'.
src/goal-engine/current-world.ts(28,39): error TS2339: Property 'repoRoot' does not exist on type '{ resourceRegistry?: {}; runInventory?: undefined[]; gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/current-world.ts(28,49): error TS2339: Property 'adapterRegistry' does not exist on type '{ resourceRegistry?: {}; runInventory?: undefined[]; gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/current-world.ts(28,66): error TS2339: Property 'environmentRegistry' does not exist on type '{ resourceRegistry?: {}; runInventory?: undefined[]; gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/current-world.ts(28,87): error TS2339: Property 'fixtureRegistry' does not exist on type '{ resourceRegistry?: {}; runInventory?: undefined[]; gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/current-world.ts(34,279): error TS2339: Property 'available' does not exist on type '{ ref: string; }'.
src/goal-engine/current-world.ts(34,317): error TS2339: Property 'available' does not exist on type '{ ref: string; }'.
src/goal-engine/events.ts(265,123): error TS2698: Spread types may only be created from object types.
src/goal-engine/events.ts(265,163): error TS2339: Property 'paths' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2190): error TS2339: Property 'description' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2225): error TS2339: Property 'deps' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2266): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2330): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2375): error TS2339: Property 'workflow' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2462): error TS2339: Property 'description' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2497): error TS2339: Property 'deps' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2538): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2602): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(531,2647): error TS2339: Property 'workflow' does not exist on type 'unknown'.
src/goal-engine/events.ts(1182,14): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(1182,33): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(1184,24): error TS2339: Property 'description' does not exist on type 'unknown'.
src/goal-engine/events.ts(1184,47): error TS2339: Property 'deps' does not exist on type 'unknown'.
src/goal-engine/events.ts(1184,75): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(1184,103): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(1185,21): error TS2339: Property 'workflow' does not exist on type 'unknown'.
src/goal-engine/events.ts(1185,48): error TS2339: Property 'metadata' does not exist on type 'unknown'.
src/goal-engine/events.ts(1185,91): error TS2339: Property 'metadata' does not exist on type 'unknown'.
src/goal-engine/events.ts(1194,17): error TS2339: Property 'description' does not exist on type 'unknown'.
src/goal-engine/events.ts(1194,57): error TS2339: Property 'description' does not exist on type 'unknown'.
src/goal-engine/events.ts(1195,17): error TS2339: Property 'deps' does not exist on type 'unknown'.
src/goal-engine/events.ts(1195,43): error TS2339: Property 'deps' does not exist on type 'unknown'.
src/goal-engine/events.ts(1196,17): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(1196,55): error TS2339: Property 'writePaths' does not exist on type 'unknown'.
src/goal-engine/events.ts(1197,17): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(1197,55): error TS2339: Property 'acceptance' does not exist on type 'unknown'.
src/goal-engine/events.ts(1198,17): error TS2339: Property 'workflow' does not exist on type 'unknown'.
src/goal-engine/events.ts(1198,65): error TS2339: Property 'workflow' does not exist on type 'unknown'.
src/goal-engine/events.ts(1454,89): error TS2339: Property 'status' does not exist on type 'unknown'.
src/goal-engine/extension.ts(114,62): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(117,23): error TS2339: Property 'kind' does not exist on type 'void'.
src/goal-engine/extension.ts(124,32): error TS2339: Property 'resources' does not exist on type 'void'.
src/goal-engine/extension.ts(151,11): error TS2339: Property 'requiredNextAction' does not exist on type 'Error & { code: any; }'.
src/goal-engine/extension.ts(217,34): error TS2345: Argument of type '{ operation: string; stateStorage: any; }' is not assignable to parameter of type '{ operation: any; requiredNextAction: any; stateStorage?: string; }'.
  Property 'requiredNextAction' is missing in type '{ operation: string; stateStorage: any; }' but required in type '{ operation: any; requiredNextAction: any; stateStorage?: string; }'.
src/goal-engine/extension.ts(222,5): error TS2353: Object literal may only specify known properties, and 'cwd' does not exist in type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
src/goal-engine/extension.ts(453,114): error TS2339: Property 'status' does not exist on type 'unknown'.
src/goal-engine/extension.ts(466,58): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(470,19): error TS2339: Property 'kind' does not exist on type 'void'.
src/goal-engine/extension.ts(477,60): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(480,21): error TS2339: Property 'kind' does not exist on type 'void'.
src/goal-engine/extension.ts(499,72): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(601,25): error TS2339: Property 'store' does not exist on type '{}'.
src/goal-engine/extension.ts(602,36): error TS2339: Property 'appendEvent' does not exist on type '{}'.
src/goal-engine/extension.ts(603,41): error TS2339: Property 'appendEventBatch' does not exist on type '{}'.
src/goal-engine/extension.ts(604,18): error TS2339: Property 'appendEvent' does not exist on type '{}'.
src/goal-engine/extension.ts(615,75): error TS2339: Property 'goalStateEnv' does not exist on type '{}'.
src/goal-engine/extension.ts(620,72): error TS2339: Property 'goalStateEnv' does not exist on type '{}'.
src/goal-engine/extension.ts(626,94): error TS2353: Object literal may only specify known properties, and 'root' does not exist in type '{ clock?: () => string; }'.
src/goal-engine/extension.ts(626,132): error TS2339: Property 'runtimeTrace' does not exist on type '{}'.
src/goal-engine/extension.ts(626,167): error TS2339: Property 'runtimeTraceEnv' does not exist on type '{}'.
src/goal-engine/extension.ts(657,31): error TS2339: Property 'runtimeHost' does not exist on type '{}'.
src/goal-engine/extension.ts(661,32): error TS2339: Property 'goalStateEnv' does not exist on type '{}'.
src/goal-engine/extension.ts(662,57): error TS2339: Property 'goalId' does not exist on type '{ operation?: string; }'.
src/goal-engine/extension.ts(669,15): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(694,39): error TS2339: Property 'enforceActionTokens' does not exist on type '{}'.
src/goal-engine/extension.ts(700,46): error TS2339: Property 'inspectExecutorWorkspace' does not exist on type '{}'.
src/goal-engine/extension.ts(701,37): error TS2339: Property 'inspectExecutionProof' does not exist on type '{}'.
src/goal-engine/extension.ts(704,29): error TS2339: Property 'workspaceService' does not exist on type '{}'.
src/goal-engine/extension.ts(705,25): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(710,64): error TS2339: Property 'inspectOrphanedExecutorWorkspace' does not exist on type '{}'.
src/goal-engine/extension.ts(713,162): error TS2345: Argument of type '(request: any) => any' is not assignable to parameter of type '() => void'.
  Target signature provides too few arguments. Expected 1 or more, but got 0.
src/goal-engine/extension.ts(714,122): error TS2345: Argument of type '(request: any) => any' is not assignable to parameter of type '() => void'.
  Target signature provides too few arguments. Expected 1 or more, but got 0.
src/goal-engine/extension.ts(715,142): error TS2322: Type '(request: any) => any' is not assignable to type '() => void'.
  Target signature provides too few arguments. Expected 1 or more, but got 0.
src/goal-engine/extension.ts(716,55): error TS2339: Property 'inspectExecutorProofForSettlement' does not exist on type '{}'.
src/goal-engine/extension.ts(717,16): error TS2339: Property 'inspectExecutorProof' does not exist on type '{}'.
src/goal-engine/extension.ts(721,50): error TS2339: Property 'allowMissingRootBrokerForTests' does not exist on type '{}'.
src/goal-engine/extension.ts(722,58): error TS2339: Property 'beforePreservedWorkspaceCleanupBarrier' does not exist on type '{}'.
src/goal-engine/extension.ts(723,59): error TS2339: Property 'inspectOrphanedExecutorWorkspaceBarrier' does not exist on type '{}'.
src/goal-engine/extension.ts(724,51): error TS2339: Property 'betweenOrphanInventoriesBarrier' does not exist on type '{}'.
src/goal-engine/extension.ts(739,101): error TS2339: Property 'goal_id' does not exist on type '{}'.
src/goal-engine/extension.ts(739,135): error TS2339: Property 'goal_id' does not exist on type '{}'.
src/goal-engine/extension.ts(777,46): error TS2339: Property 'finalReviewProviderFactory' does not exist on type '{}'.
src/goal-engine/extension.ts(1172,58): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(1175,37): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(1180,72): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(1185,17): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(1211,72): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(1216,15): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(1222,72): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(1231,65): error TS2554: Expected 4 arguments, but got 3.
src/goal-engine/extension.ts(1422,42): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(1532,54): error TS2353: Object literal may only specify known properties, and 'cwd' does not exist in type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
src/goal-engine/extension.ts(1576,73): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(1774,59): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/extension.ts(1835,55): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ taskId?: any; taskDefHash?: any; }'.
src/goal-engine/extension.ts(1865,189): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/extension.ts(1953,84): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2061,75): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2083,24): error TS2339: Property 'runProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2088,30): error TS2339: Property 'executorProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2094,24): error TS2339: Property 'attempt' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2095,24): error TS2339: Property 'executionHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2111,67): error TS2339: Property 'runProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2119,21): error TS2554: Expected 6 arguments, but got 5.
src/goal-engine/extension.ts(2140,52): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(2159,24): error TS2339: Property 'attempt' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2160,47): error TS2339: Property 'executionHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2161,29): error TS2339: Property 'executorHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2164,60): error TS2339: Property 'runProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2164,86): error TS2339: Property 'executorProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2174,26): error TS2339: Property 'settlementEvidence' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2175,26): error TS2339: Property '_artifact' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2178,15): error TS2339: Property '_artifact' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2180,32): error TS2339: Property 'attempt' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2180,41): error TS2339: Property 'executorHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2180,55): error TS2339: Property 'executorProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2180,70): error TS2339: Property 'settlementEvidence' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2183,107): error TS2339: Property 'runProof' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2185,67): error TS2339: Property 'executionHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2185,116): error TS2339: Property 'executorHead' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2186,46): error TS2339: Property 'settlementEvidence' does not exist on type '{ taskId: any; outcome: any; evidence: any; evidenceSource: any; nextAction: any; reason: any; }'.
src/goal-engine/extension.ts(2219,70): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2229,48): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/extension.ts(2258,17): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/extension.ts(2308,15): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/extension.ts(2328,73): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2351,180): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/extension.ts(2369,196): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/extension.ts(2397,75): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2461,54): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(2462,108): error TS2339: Property 'preservationReceipt' does not exist on type 'void'.
src/goal-engine/extension.ts(2598,13): error TS2353: Object literal may only specify known properties, and 'cwd' does not exist in type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
src/goal-engine/extension.ts(2670,11): error TS2353: Object literal may only specify known properties, and 'cwd' does not exist in type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
src/goal-engine/extension.ts(2709,75): error TS2353: Object literal may only specify known properties, and 'goalId' does not exist in type '{ operation?: string; }'.
src/goal-engine/extension.ts(2822,12): error TS2554: Expected 2 arguments, but got 3.
src/goal-engine/extension.ts(2846,53): error TS2339: Property 'choices' does not exist on type '{ code: string; resources: any; } | { code: string; requiresHumanDecision: boolean; choices: { tool: string; params: { task_id: any; action: string; }; }[]; }'.
  Property 'choices' does not exist on type '{ code: string; resources: any; }'.
src/goal-engine/extension.ts(2927,57): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(2974,38): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(2980,59): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(3017,61): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(3020,27): error TS2339: Property 'workspaceExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3020,56): error TS2339: Property 'branchExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3020,82): error TS2339: Property 'leaseExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3087,63): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(3088,27): error TS2339: Property 'workspaceExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3088,56): error TS2339: Property 'branchExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3088,82): error TS2339: Property 'leaseExists' does not exist on type 'void'.
src/goal-engine/extension.ts(3091,36): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3102,67): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(3105,13): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3113,66): error TS2554: Expected 0 arguments, but got 1.
src/goal-engine/extension.ts(3141,45): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3147,46): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3156,44): error TS2339: Property 'currentHead' does not exist on type 'void | { currentHead: string; }'.
  Property 'currentHead' does not exist on type 'void'.
src/goal-engine/extension.ts(3162,40): error TS1345: An expression of type 'void' cannot be tested for truthiness.
src/goal-engine/extension.ts(3162,70): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3163,38): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3186,40): error TS1345: An expression of type 'void' cannot be tested for truthiness.
src/goal-engine/extension.ts(3186,70): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3187,67): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3192,30): error TS2339: Property 'rebased' does not exist on type 'void'.
src/goal-engine/extension.ts(3197,48): error TS2339: Property 'currentHead' does not exist on type 'void'.
src/goal-engine/extension.ts(3204,38): error TS2554: Expected 0 arguments, but got 2.
src/goal-engine/extension.ts(3358,40): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ affectedIds?: {}; inventories?: {}; }'.
src/goal-engine/extension.ts(3504,52): error TS2353: Object literal may only specify known properties, and 'projections' does not exist in type '{ paths?: any[]; }'.
src/goal-engine/extension.ts(3506,78): error TS2339: Property 'goalIds' does not exist on type '{ status: string; goalId: unknown; reason: any; goalIds?: undefined; } | { status: string; goalIds: unknown[]; reason: any; goalId?: undefined; } | { status: string; reason: string; }'.
  Property 'goalIds' does not exist on type '{ status: string; reason: string; }'.
src/goal-engine/extension.ts(3507,115): error TS2339: Property 'goalIds' does not exist on type '{ status: string; goalId: unknown; reason: any; goalIds?: undefined; } | { status: string; goalIds: unknown[]; reason: any; goalId?: undefined; } | { status: string; reason: string; }'.
  Property 'goalIds' does not exist on type '{ status: string; reason: string; }'.
src/goal-engine/extension.ts(3510,86): error TS2339: Property 'goalId' does not exist on type '{ status: string; goalId: unknown; reason: any; goalIds?: undefined; } | { status: string; goalIds: unknown[]; reason: any; goalId?: undefined; } | { status: string; reason: string; }'.
  Property 'goalId' does not exist on type '{ status: string; reason: string; }'.
src/goal-engine/extension.ts(3512,44): error TS2353: Object literal may only specify known properties, and 'userText' does not exist in type '{ paths?: any[]; }'.
src/goal-engine/extension.ts(3553,46): error TS2353: Object literal may only specify known properties, and 'projections' does not exist in type '{ paths?: any[]; }'.
src/goal-engine/extension.ts(3567,112): error TS2339: Property 'status' does not exist on type 'unknown'.
src/goal-engine/extension.ts(3581,46): error TS2353: Object literal may only specify known properties, and 'projections' does not exist in type '{ paths?: any[]; }'.
src/goal-engine/extension.ts(3595,7): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ modifiedFiles?: any[]; }'.
src/goal-engine/finalization.ts(62,7): error TS2339: Property 'binding' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(63,7): error TS2339: Property 'executorProof' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(64,7): error TS2339: Property 'executorProofIdentity' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(65,7): error TS2339: Property 'settlement' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(66,7): error TS2339: Property 'settlementEvidence' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(67,7): error TS2339: Property 'settlementHash' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(67,32): error TS2339: Property 'settlement' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(68,7): error TS2339: Property 'workspaceProof' does not exist on type '{ id: any; applicability: any; status: any; attempts: any; contractHash: any; acceptanceCriteria: any; coordinatorCriteria: any; acceptanceVerification: any; }'.
src/goal-engine/finalization.ts(86,74): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(87,91): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(88,29): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(89,131): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(90,96): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(90,150): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(91,329): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(92,61): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(92,159): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(93,67): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(110,25): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(110,86): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(110,234): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/finalization.ts(114,55): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/finalization.ts(114,67): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/finalization.ts(114,82): error TS2339: Property 'conditionValidity' does not exist on type '{}'.
src/goal-engine/finalization.ts(114,101): error TS2339: Property 'resourceInventory' does not exist on type '{}'.
src/goal-engine/finalization.ts(123,46): error TS2353: Object literal may only specify known properties, and 'stateHash' does not exist in type '{ goalId: any; revision: any; contractHash: any; head: any; worldHash: any; tasks: any; conditions: any; debts: any; }'.
src/goal-engine/finalization.ts(139,174): error TS2339: Property 'code' does not exist on type 'Error'.
src/goal-engine/graph.ts(103,57): error TS2339: Property 'observed' does not exist on type '{ code: string; resources: any; }'.
src/goal-engine/graph.ts(104,54): error TS2339: Property 'error' does not exist on type '{ code: string; resources: any; }'.
src/goal-engine/human-decision.ts(32,37): error TS2339: Property 'inputEvent' does not exist on type '{}'.
src/goal-engine/human-decision.ts(32,49): error TS2339: Property 'challenge' does not exist on type '{}'.
src/goal-engine/human-decision.ts(32,60): error TS2339: Property 'sessionId' does not exist on type '{}'.
src/goal-engine/human-decision.ts(84,52): error TS2339: Property 'goalId' does not exist on type '{}'.
src/goal-engine/human-decision.ts(84,60): error TS2339: Property 'contractHash' does not exist on type '{}'.
src/goal-engine/human-decision.ts(84,74): error TS2339: Property 'baseHead' does not exist on type '{}'.
src/goal-engine/human-decision.ts(84,84): error TS2339: Property 'sessionId' does not exist on type '{}'.
src/goal-engine/human-decision.ts(84,95): error TS2339: Property 'proposalId' does not exist on type '{}'.
src/goal-engine/human-decision.ts(98,53): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/human-decision.ts(98,65): error TS2339: Property 'proposal' does not exist on type '{}'.
src/goal-engine/human-decision.ts(106,48): error TS2339: Property 'challenge' does not exist on type '{}'.
src/goal-engine/human-decision.ts(106,59): error TS2339: Property 'decision' does not exist on type '{}'.
src/goal-engine/human-decision.ts(106,69): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/human-decision.ts(106,81): error TS2339: Property 'proposal' does not exist on type '{}'.
src/goal-engine/human-decision.ts(106,91): error TS2339: Property 'nonce' does not exist on type '{}'.
src/goal-engine/human-decision.ts(113,44): error TS2339: Property 'objective' does not exist on type '{}'.
src/goal-engine/human-decision.ts(113,55): error TS2339: Property 'scope' does not exist on type '{}'.
src/goal-engine/human-decision.ts(113,62): error TS2339: Property 'nonGoals' does not exist on type '{}'.
src/goal-engine/human-decision.ts(113,72): error TS2339: Property 'dod' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,325): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,336): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,346): error TS2339: Property 'goalId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,353): error TS2339: Property 'taskId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,360): error TS2339: Property 'attempt' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,368): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,383): error TS2339: Property 'validationPlan' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(29,398): error TS2339: Property 'originRef' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(58,107): error TS2339: Property 'lease' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(58,161): error TS2339: Property 'actionId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(59,100): error TS2339: Property 'actionId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(59,223): error TS2339: Property 'lease' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(59,336): error TS2339: Property 'actionId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(59,395): error TS2554: Expected 3 arguments, but got 1.
src/goal-engine/managed-validation.ts(61,47): error TS2339: Property 'expectedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(61,703): error TS2353: Object literal may only specify known properties, and 'workspaceId' does not exist in type '{ strategy?: string; }'.
src/goal-engine/managed-validation.ts(89,30): error TS2339: Property 'ownerKind' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(89,74): error TS2339: Property 'ownerId' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(89,125): error TS2339: Property 'resourceClaims' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(90,62): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(90,100): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(91,29): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(92,81): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(93,31): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(94,121): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(94,150): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(94,183): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(94,227): error TS2339: Property 'plan' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(97,74): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(97,103): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(97,184): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(97,222): error TS2339: Property 'plan' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(116,206): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(116,253): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(116,296): error TS2339: Property 'onTerminalBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(116,344): error TS2339: Property 'onTerminalBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(117,11): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(117,27): error TS2339: Property 'onTerminalBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(145,91): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(145,138): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(157,20): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(158,21): error TS2339: Property 'onProcessBound' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(172,58): error TS2339: Property 'expectedHead' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(186,23): error TS2339: Property 'readReceipt' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(190,399): error TS2353: Object literal may only specify known properties, and 'workspaceId' does not exist in type '{ strategy?: string; }'.
src/goal-engine/managed-validation.ts(204,47): error TS2339: Property 'readReceipt' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(206,36): error TS2339: Property 'readClosure' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(206,80): error TS2339: Property 'readClosure' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(210,25): error TS2339: Property 'writeClosure' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(211,20): error TS2339: Property 'writeClosure' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(214,23): error TS2339: Property 'preserveManagedWorktree' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(214,81): error TS2339: Property 'markValidationLeaseDebt' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(214,139): error TS2339: Property 'writeRecord' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(214,185): error TS2339: Property 'recover' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(215,38): error TS2339: Property 'recover' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(220,38): error TS2339: Property 'preserveManagedWorktree' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(222,20): error TS2339: Property 'markValidationLeaseDebt' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(224,20): error TS2339: Property 'writeRecord' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(227,23): error TS2339: Property 'recover' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(227,65): error TS2339: Property 'preserveWorkspace' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(227,117): error TS2339: Property 'preserveResource' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(228,36): error TS2339: Property 'recover' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(231,36): error TS2339: Property 'preserveWorkspace' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(232,35): error TS2339: Property 'preserveResource' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(235,23): error TS2339: Property 'writeClosure' does not exist on type '{}'.
src/goal-engine/managed-validation.ts(236,18): error TS2339: Property 'writeClosure' does not exist on type '{}'.
src/goal-engine/managed-workspace.ts(13,24): error TS2339: Property 'observed' does not exist on type '{ kind: string; resources: any; }'.
src/goal-engine/managed-workspace.ts(14,21): error TS2339: Property 'error' does not exist on type '{ kind: string; resources: any; }'.
src/goal-engine/managed-workspace.ts(26,14): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/managed-workspace.ts(40,47): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/managed-workspace.ts(43,39): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/managed-workspace.ts(47,56): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/managed-workspace.ts(59,41): error TS2554: Expected 3 arguments, but got 2.
src/goal-engine/obligation-policy.ts(95,30): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/obligation-policy.ts(95,42): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/obligation-policy.ts(95,64): error TS2339: Property 'taskActions' does not exist on type '{}'.
src/goal-engine/obligation-policy.ts(95,77): error TS2339: Property 'observationInventory' does not exist on type '{}'.
src/goal-engine/obligation-policy.ts(185,49): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/obligation-policy.ts(185,61): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(23,268): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(23,281): error TS2339: Property 'conditionId' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(23,296): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(23,312): error TS2339: Property 'services' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(23,399): error TS2339: Property 'cycle' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(26,228): error TS2339: Property 'loadProjection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(27,105): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(27,135): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(27,169): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(34,24): error TS2339: Property 'loadProjection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(41,105): error TS2339: Property 'originRoot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(41,135): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(41,169): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(46,99): error TS2339: Property 'loadProjection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(48,223): error TS2339: Property 'loadProjection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,206): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,219): error TS2339: Property 'runReceipt' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,232): error TS2339: Property 'artifactRef' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,244): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,260): error TS2339: Property 'services' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(53,2519): error TS2339: Property 'evidenceId' does not exist on type 'Readonly<{ kind: "passed"; evidenceId: string; }> | Readonly<{ kind: "failed"; evidenceId: string; failureCode: any; findingFingerprint: string; }> | Readonly<{ kind: "infrastructure_error"; reason: any; }> | Readonly<...>'.
  Property 'evidenceId' does not exist on type 'Readonly<{ kind: "infrastructure_error"; reason: any; }>'.
src/goal-engine/observation-runner.ts(53,2539): error TS2339: Property 'evidenceId' does not exist on type 'Readonly<{ kind: "passed"; evidenceId: string; }> | Readonly<{ kind: "failed"; evidenceId: string; failureCode: any; findingFingerprint: string; }> | Readonly<{ kind: "infrastructure_error"; reason: any; }> | Readonly<...>'.
  Property 'evidenceId' does not exist on type 'Readonly<{ kind: "infrastructure_error"; reason: any; }>'.
src/goal-engine/observation-runner.ts(54,282): error TS2339: Property 'loadProjection' does not exist on type '{}'.
src/goal-engine/observation-runner.ts(54,906): error TS2339: Property 'integratedHead' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(98,26): error TS2339: Property 'facade' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(99,48): error TS2339: Property 'workspaceService' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(99,137): error TS2339: Property 'loadExecutorWorkspaceLease' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(99,232): error TS2339: Property 'inspectExecutorWorkspace' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(99,325): error TS2339: Property 'releaseExecutorWorkspace' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(101,56): error TS2339: Property 'registries' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(101,152): error TS2339: Property 'adapterRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(102,74): error TS2339: Property 'environmentRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(102,179): error TS2339: Property 'fixtureRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,318): error TS2339: Property 'resourceRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,360): error TS2339: Property 'resourceRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,413): error TS2339: Property 'resourceRegistry' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,483): error TS2339: Property 'runInventory' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,521): error TS2339: Property 'runInventory' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(108,547): error TS2339: Property 'runInventory' does not exist on type '{}'.
src/goal-engine/production-runtime-host.ts(114,134): error TS2339: Property 'stopRootBrokerGoalOwnedRun' does not exist on type '{}'.
src/goal-engine/reconciliation.ts(20,204): error TS2365: Operator '<' cannot be applied to types 'unknown' and 'number'.
src/goal-engine/reconciliation.ts(41,195): error TS2365: Operator '<' cannot be applied to types 'unknown' and 'number'.
src/goal-engine/reconciliation.ts(51,51): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/reconciliation.ts(51,63): error TS2339: Property 'changes' does not exist on type '{}'.
src/goal-engine/reconciliation.ts(51,72): error TS2339: Property 'reason' does not exist on type '{}'.
src/goal-engine/reconciliation.ts(84,44): error TS2339: Property 'projection' does not exist on type '{ inventories?: {}; }'.
src/goal-engine/reconciliation.ts(84,56): error TS2339: Property 'proposal' does not exist on type '{ inventories?: {}; }'.
src/goal-engine/reconciliation.ts(84,66): error TS2339: Property 'capability' does not exist on type '{ inventories?: {}; }'.
src/goal-engine/reconciliation.ts(108,78): error TS2339: Property 'id' does not exist on type 'unknown'.
src/goal-engine/reconciliation.ts(108,91): error TS2339: Property 'intent' does not exist on type 'unknown'.
src/goal-engine/reconciliation.ts(108,140): error TS2339: Property 'id' does not exist on type 'unknown'.
src/goal-engine/repair-policy.ts(21,51): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(21,63): error TS2339: Property 'runId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(21,70): error TS2339: Property 'evidenceId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(39,37): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(39,49): error TS2339: Property 'findingIds' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(63,41): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(63,53): error TS2339: Property 'challengeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(63,66): error TS2339: Property 'taskDef' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(63,75): error TS2339: Property 'now' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(71,49): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(71,61): error TS2339: Property 'episodeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(71,72): error TS2339: Property 'findingIds' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(71,84): error TS2339: Property 'taskDef' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,43): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,55): error TS2339: Property 'episodeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,66): error TS2339: Property 'findingIds' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,78): error TS2339: Property 'taskDef' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,87): error TS2339: Property 'capability' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(82,99): error TS2339: Property 'consumedAt' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(89,41): error TS2339: Property 'projection' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,53): error TS2339: Property 'episodeId' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,64): error TS2339: Property 'action' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,72): error TS2339: Property 'sessionId' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,83): error TS2339: Property 'requestedAt' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,96): error TS2339: Property 'expiresAt' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,107): error TS2339: Property 'baseHead' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,117): error TS2339: Property 'subjectHash' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(89,165): error TS2339: Property 'taskDef' does not exist on type '{ taskId?: null; taskDefHash?: null; }'.
src/goal-engine/repair-policy.ts(98,44): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,56): error TS2339: Property 'challengeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,69): error TS2339: Property 'sessionId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,80): error TS2339: Property 'userEntryId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,93): error TS2339: Property 'userEntryHash' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,108): error TS2339: Property 'branchBindingHash' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,127): error TS2339: Property 'userEntryOccurredAt' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,148): error TS2339: Property 'choice' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,156): error TS2339: Property 'approved' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,166): error TS2339: Property 'source' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(98,174): error TS2339: Property 'recordedAt' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(104,43): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(104,55): error TS2339: Property 'capability' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(104,67): error TS2339: Property 'consumedAt' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(106,45): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(106,57): error TS2339: Property 'episodeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(106,68): error TS2339: Property 'runId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(107,43): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(107,55): error TS2339: Property 'episodeId' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(107,66): error TS2339: Property 'event' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(107,80): error TS2339: Property 'worldSnapshot' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(107,95): error TS2339: Property 'gitRunner' does not exist on type '{}'.
src/goal-engine/repair-policy.ts(131,48): error TS2353: Object literal may only specify known properties, and 'projection' does not exist in type '{ gitRunner?: (root: any, args: any) => NonSharedBuffer; }'.
src/goal-engine/runtime-trace.ts(11,18): error TS2339: Property 'runtimeTrace' does not exist on type '{}'.
src/goal-engine/runtime-trace.ts(20,42): error TS2339: Property 'root' does not exist on type '{ clock?: () => string; }'.
src/goal-engine/runtime-trace.ts(20,48): error TS2339: Property 'config' does not exist on type '{ clock?: () => string; }'.
src/goal-engine/runtime-trace.ts(20,56): error TS2339: Property 'env' does not exist on type '{ clock?: () => string; }'.
src/goal-engine/runtime-trace.ts(20,61): error TS2339: Property 'sessionId' does not exist on type '{ clock?: () => string; }'.
src/goal-engine/runtime-trace.ts(33,35): error TS2339: Property 'sessionId' does not exist on type '{ schema: string; seq: number; ts: string; kind: string; }'.
src/goal-engine/state-lifecycle.ts(107,36): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/state-lifecycle.ts(115,34): error TS2339: Property 'stateRoot' does not exist on type '{}'.
src/goal-engine/state-lifecycle.ts(115,45): error TS2339: Property 'expectedStateHash' does not exist on type '{}'.
src/goal-engine/state-lifecycle.ts(115,64): error TS2339: Property 'authorizationId' does not exist on type '{}'.
src/goal-engine/store.ts(241,79): error TS2339: Property 'version' does not exist on type '{}'.
src/goal-engine/store.ts(241,99): error TS2339: Property 'version' does not exist on type '{}'.
src/goal-engine/store.ts(241,122): error TS2339: Property 'version' does not exist on type '{}'.
src/goal-engine/store.ts(243,87): error TS2339: Property 'version' does not exist on type '{}'.
src/goal-engine/store.ts(693,149): error TS2339: Property 'lifecycle' does not exist on type 'object'.
src/goal-engine/store.ts(693,176): error TS2339: Property 'objective' does not exist on type 'object'.
src/goal-engine/store.ts(693,215): error TS2339: Property 'updatedAt' does not exist on type 'object'.
src/goal-engine/store.ts(693,271): error TS2339: Property 'updatedAt' does not exist on type 'object'.
src/goal-engine/store.ts(693,293): error TS2339: Property 'lifecycle' does not exist on type 'object'.
src/goal-engine/store.ts(696,40): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'PropertyKey'.
src/goal-engine/store.ts(696,66): error TS2538: Type 'unknown' cannot be used as an index type.
src/goal-engine/suspension.ts(36,45): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/suspension.ts(36,57): error TS2339: Property 'taskId' does not exist on type '{}'.
src/goal-engine/suspension.ts(54,39): error TS2339: Property 'projection' does not exist on type '{ affectedIds?: {}; inventories?: {}; }'.
src/goal-engine/suspension.ts(54,51): error TS2339: Property 'reason' does not exist on type '{ affectedIds?: {}; inventories?: {}; }'.
src/goal-engine/suspension.ts(57,43): error TS2339: Property 'taskIds' does not exist on type '{}'.
src/goal-engine/suspension.ts(57,106): error TS2339: Property 'runIds' does not exist on type '{}'.
src/goal-engine/suspension.ts(59,44): error TS2339: Property 'workspaces' does not exist on type '{}'.
src/goal-engine/suspension.ts(68,11): error TS2339: Property 'projection' does not exist on type '{}'.
src/goal-engine/suspension.ts(70,73): error TS2339: Property 'taskId' does not exist on type '{}'.
src/goal-engine/suspension.ts(79,47): error TS2339: Property 'projection' does not exist on type '{ stopProofs?: undefined[]; workspaceInventories?: undefined[]; resourceProofs?: undefined[]; }'.
src/goal-engine/task-definition.ts(71,84): error TS2339: Property 'cwd' does not exist on type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
src/goal-engine/task-definition.ts(71,89): error TS2339: Property 'realpathCwd' does not exist on type '{ requireNonEmpty?: boolean; planned?: boolean; runtimeAcceptance?: boolean; hostInternalRemediation?: boolean; requireAgentProfile?: boolean; v2Acceptance?: boolean; }'.
```
