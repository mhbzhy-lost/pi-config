# Smoke Test: Plan Runner 端到端验证

> 沙盒任务，验证 plan-runner → executor 派发 → 文件创建 → commit → attempt 结算完整链路。

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node -e \"require('fs').existsSync('sandbox/smoke.txt') || process.exit(1)\""],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
```

### Task 1: 创建 smoke test 文件

**Files:**
- Create: `sandbox/smoke.txt`
