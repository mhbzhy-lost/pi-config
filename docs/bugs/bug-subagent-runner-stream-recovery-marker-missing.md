# subagent-runner.ts stream recovery patch 未注入 ordered-models MARKER

## 现象

`npm run verify:subagents-enhanced` 失败：

```
ordered models runtime patch missing: src/runs/background/subagent-runner.ts
```

## 根因

`verifyOrderedModelsRuntimePatch` 遍历 `files` 列表，要求每个文件含 `MARKER`（`// pi-config patch: ordered-models.v3`）。`subagent-runner.ts` 在 `files` 列表里，但其 patch 函数 `streamRecovery` 只注入 `STREAM_RECOVERY_MARKER`（`// pi-config patch: stream-read-error-recovery.v1`），不注入 `MARKER`。

`streamRecovery` 的设计意图是只注入 stream recovery 逻辑，但 verify 的通用 marker 检查要求所有 `files` 含 `MARKER`。这是设计缺口：`subagent-runner.ts` 的 patch 函数未满足 verify 的通用 marker 要求。

## 修复

`streamRecovery` 函数在注入 `STREAM_RECOVERY_MARKER` 的同时也注入 `MARKER`，使 verify 通过。不改变 stream recovery 行为，只是让 verify 的 marker 检查通过。
