# Managed workspace integrate 单例返回 `false` 复盘

## 现象与复现

`test/goal-engine-workspace.integration.mjs` 的「clean committed allowed write」单例曾在

```sh
node --test test/goal-engine-workspace.integration.mjs
```

中于 `status.allowedDispositions.includes("integrate")` 得到 `false !== true`。

最小真实 public-service 链为：

1. `ensureAllocated(request)`：receipt 为 `state: "active"`；
2. 旧单例直接提交 `src/result.ts`，但**没有** `bindRun`；
3. 即使传入形如 `{ state: "observed", conflict: false, proofHash }` 的终态，`status` 的 canonical 结果仍为：
   - `receipt.state: "active"`
   - `terminalProof: null`
   - `allowedDispositions: ["discard", "preserve"]`
   - `blockedReasons: []`
4. 因而没有发放 integrate action token，也没有执行 Git integrate。

首个偏离不在 Git：`service.inspectStatus` 先发现 `record.run === null`，按 service 的 unbound 安全分支忽略调用方终态并仅允许 discard/preserve；随后才返回 inspection。Git 的首次观察仍是 canonical workspace inspection，未发生 cherry-pick/merge。

## 分类

这是**测试期望字段/前置条件漂移**，不是 production integrate 漏执行：unbound workspace 不得以调用方注入的 terminal proof 取得 integrate 权限。将 service 放宽会绕过 run/owner/lease/action-token 的终态授权边界。

修复后的单例走完整公开链：allocate → `bindRun` → 由
`goalWorkspaceTerminalProof(officialExecutorProof)` 转换的官方终态 → status → issueDisposition → dispose(integrate)。GREEN canonical evidence 为：

- status receipt `state: "active"`；
- status terminal proof 等于官方 proof adapter 的结果；
- inspection `clean: true`、`changedFiles: ["src/result.ts"]`；
- `blockedReasons: []` 且 integrate 被允许；
- dispose receipt `state: "released"`、`disposition: { action: "integrate", strategy: "cherry-pick" }`；
- origin `HEAD:src/result.ts` 是已提交内容。

## 安全结论

没有修改 production service/git-worktree。dirty、越界 writePaths、rename/rogue identity、HEAD drift 以及 branch/owner/lease/action-token 校验均未放宽；既有 workspace service/Git 负例继续作为回归验证。
