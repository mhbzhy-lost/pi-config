# Smoke Test: Plan Runner 含外部评审验证

> 验证完整链路含 external-review gate（idealab-anthropic Claude Opus 4.6）。

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node -e \"require('fs').existsSync('sandbox/smoke.txt') || process.exit(1)\""],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
```

### Task 1: 创建 smoke test 文件

**Files:**
- Create: `sandbox/smoke.txt`
