# Canary Goal state-root and ledger locator

## Symptom

The prior one-task RPC smoke completed `goal_init`, `goal_status`, `goal_dispatch`, and the typed subagent start. Ledger verification then first diverged at `readFile(origin/.state/goal-engine/goals/<goalId>/events.jsonl)`, producing `ENOENT`. The temporary directories were removed in `finally`, so that run cannot be recovered offline.

## Cause

`sanitizedRpcEnvironment` only removed `PI_SUBAGENT_*`. A spawned child otherwise inherits its supplied environment, including the parent session's `PI_CODING_GOAL_DIR`. `createGoalEngineEntry` loads the production extension; its `executionScopeFor` calls `resolveGoalStateScope`. When `PI_CODING_GOAL_DIR` is present, that helper selects:

```
<PI_CODING_GOAL_DIR>/<cwdNamespace(canonical cwd)>
```

rather than `<origin>/.state/goal-engine`. The workspace service independently reads `PI_CODING_WORKSPACE_DIR`. Thus the old verifier both let the child inherit the main Goal root and then guessed a different fixed legacy location.

## Fix and deterministic coverage

The canary helper now creates a fresh environment per temporary agent directory and explicitly sets both `PI_CODING_GOAL_DIR=<temp>/goal-state` and `PI_CODING_WORKSPACE_DIR=<temp>/workspace-state`; it does not inherit either parent value. The local test creates a Goal through the production entry with no RPC, model, provider, or subagent.

The locator uses the production `resolveGoalStateScope` and `selectGoalStateRoot` helpers plus production `listGoals`/`loadProjection`, then forms the store-defined `goals/<goalId>/events.jsonl` path. It does not recurse, inspect the main repository, or assume `origin/.state`. The test asserts the exact created ledger before `finally`, verifies the legacy origin has no projection, and then removes both temporary roots.
