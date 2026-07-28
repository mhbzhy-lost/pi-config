# Integration conflict

## Execution Contract

```json
{"schemaVersion":"pi-plan.v2","verification":["true"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"],"resourceCapacities":{},"taskVerification":{}}
```

### Task 1: First shared edit

**Files:**
- Modify: `shared.txt`

### Task 2: Second shared edit

**Deps:** Task 1

**Files:**
- Modify: `shared.txt`
