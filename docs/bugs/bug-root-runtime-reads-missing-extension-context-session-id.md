# Bug: Root runtime 读取不存在的 ExtensionContext session id

## 症状
`dc8fc39` 后真实 Harness 仍出现 `followup accepted -> run-missing`，没有 `proof.accepted`、resume 或第二个 generation，说明 lifecycle identity 的修复没有在 RootBroker 启动时生效。

## 影响
RootBroker 构造时仍把 lifecycle session identity 退回为 `rootSessionId`，使 followup 的 proof 无法与持久化 runtime identity 匹配；已存在的双身份比较继续拒绝该流程，真实恢复链路不能产生下一 generation。

## 复现
启动真实 Harness 并触发 followup。虽然 `subagent-runtime.ts` 已导入 pinned 的 `resolveCurrentSessionId`，`session_start` 回调仍将 `ctx.currentSessionId` 传入 `RootBrokerServer`；Pi 的公开 `ExtensionContext` 类型没有该字段，因此该值为 `undefined`，构造默认值仍等于修复前的 `rootSessionId`。

## 根因
错误地把 upstream headless runtime 的 async tool context 中的 `currentSessionId` 当作 Pi `session_start` 的 `ExtensionContext` 字段。两类 context 并不相同：Pi 公开 context 只提供 `sessionManager`，不提供 `currentSessionId`；async tool context 的字段也不是 RootBroker 启动时可读取的生命周期身份来源。

## 修复
仅将 RootBroker 参数改为 `lifecycleSessionId: resolveCurrentSessionId(ctx.sessionManager)`。该 pinned resolver 通过 `getSessionFile() ?? getSessionId()` 获取 persisted identity，与 upstream headless runtime 在 async context 中使用的 persisted identity 来源一致；不新增第三种身份，不修改 Broker 双身份模型，也不放宽既有校验。

## 验证
现有真实 Harness 在修复前已是 RED：只到 `followup accepted -> run-missing`，没有 proof accepted 或第二 generation。focused unit 已保护双身份比较；完成单行 GREEN 后，真实 Harness 必须出现 `proof.accepted`、resume 和第二个 generation。本项按“单行修复 + 已有失败集成测试”获得 TDD 豁免，不新增测试。
