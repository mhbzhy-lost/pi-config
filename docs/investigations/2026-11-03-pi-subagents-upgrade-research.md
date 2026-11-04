# pi-subagents 随 Pi 1.5.0 升级研究：限定证据纠错

- 日期：2026-11-03；本仓 upstream 固定 `0.80.0`，Pi 核心固定 `1.4.0`；研究目标为 `pi-subagents@0.84.0` 与 Pi `1.5.0`。
- 本次为既有研究收尾：完整读取原两报告，复用既有官方解包资料，只读代码并修订两报告。没有恢复旧 run、网络查询、安装、测试、启动 Host/provider/subagent/MCP、修改生产文件或计划、暂存、提交、推送。
- 下文上游相对路径均以 `/tmp/pi-subagents-upgrade-research-2026-11-03/084/package` 为根；对照包位于同级 `080/package`、`081/package`、`0831/package`。Pi 官方 artifact 为 `/tmp/pi-version-research/v1.5/package` 与 `/tmp/pi-version-research/packages-1.5`。这些是资料，不是已验证安装闭包；本次未重验 tarball integrity 或查询当前 registry latest。
- 本仓 `src/...` 简写均指 `packages/pi-subagents-enhanced/src/...`，另有说明者除外。

## 结论

建议升级目标保持 `0.84.0`，因为本仓 `src/subagent-dispatch/workflow-spawn.ts:61-109` 确实生成并异步派发 workflow script，而官方 `CHANGELOG.md:5-20` 明确要求 workflow script 使用方升级以修复 [GHSA-6v8j-6w28-2w8r](https://github.com/nicobailon/pi-subagents/security/advisories/GHSA-6v8j-6w28-2w8r)。修复阻止 workflow 设置 `Error.prepareStackTrace`，并在执行前拒绝 `import()`。这证明该安全修复覆盖本仓使用面，不证明目标组合已经兼容。

升级前有三个明确边界：持久会话 ceiling 注册身份需要对齐；0.82 起新增的默认 workflow 自动恢复需要显式关闭以保持当前行为；本仓精确版本、官方文件 hash 和 physical Host 同源门禁需要按目标版本更新。自动恢复能否绕过 root-broker/managed workspace 授权尚未证实，不能把上游自己的权限限制等同本仓授权。未完成隔离验证之前应阻断启用该自动行为，不添加生产 fallback。

只保持现有行为，不建议接入 jobsChanged、background-work、mission、Rex 或其它新功能。`undici` 从 `8.10.2` 到 `8.12.3` 是 **0.82.0** 的变更（`CHANGELOG.md:123`），0.84.0 包包含它，不能写成由 0.84.0 首次引入。

## workflow 自动恢复：默认、配置与调用链

官方 `CHANGELOG.md:88-123` 将自动恢复归于 **0.82.0**；0.84.0 沿用。`docs/configuration.md:258-264` 声明 `autoResume` 默认 true，真实配置入口由 `src/extension/config.js:241-243` 返回：

```text
${getAgentDir()}/extensions/subagent/config.json
```

保持旧行为的配置是该文件的**顶层** `{ "autoResume": false }`，不是 settings 中推测的嵌套字段，也不是 `runs.run()`、RPC spawn 或 `buildWorkflowSpawn()` 参数。`src/extension/config.js:220-221` 对该字段做 boolean 校验。未读取本机真实配置，因此不声称当前机器配置已开或已关；只能确认本仓 `src/`、`extensions/` 没有显式设置 `autoResume`，`workflow-spawn.ts:99-109` 返回 `script/cwd/context/async/timeoutMs/artifacts/worktree:false/mission:false/chatProgress:"off"`，没有关闭恢复。

真实入口和限制：

1. 上游 `src/extension/index.js:1162` 将 `startup/reload/resume` 判为 recovering；`:956-960` 仅在 `recovering && ctx.hasUI && config.autoResume !== false` 时规划恢复。`pi -p` 不走此自动分支，不能用 print-mode fixture 通过推断交互恢复安全。
2. `src/workflows/workflow-auto-resume.js:9-10,48-97` 扫描当前 session 的近期 terminal index，最多 50 条、24 小时内，只取 top-level workflow、相同 session、可复用 stop cause、无占用 claim/既有 refusal 的记录，再调用 `prepareWorkflowResume`。不是任意 stopped run 都会重启。
3. `src/extension/index.js:615-626` 经 `setImmediate`、等待 agent advertisement 后直接调用 `executor.executeWorkflowResume(...)`；`src/runs/foreground/subagent-executor.js:7793-7799` 再进 `executePublic`。该路径不重新调用本仓 typed dispatch 工具。
4. `src/workflows/workflow-resume.js:46-103` 有 session ownership、launch snapshot、attempt/claim 限制；`docs/workflows.md` 的恢复段说明重用已完成 `runs.run`，但 `runs.steer`/`runs.host` 可再次执行。只能在记录满足条件时自动恢复；显式用户 stop 不等价 owner-exited/runtime-replaced。

本仓正常派发先经 `src/subagent-dispatch/extension.ts:915-945` 的 `hostAuthorizedDispatch`，再在 `:1152` 等处绑定 workspace/root/session；`extensions/subagent-runtime.ts:737-795` 在上游 session_start 前建立 broker、authority store 和 workspace service。自动恢复直接进入上游 executor 的事实说明它不经过同一个新 typed 派发入口；但 required child extension、broker grant、既有 resume lineage 是否会拒绝或正确绑定重放 child，需要实测，**静态未证能成功绕过，也未证安全**。

因此保持行为的精确建议是：候选与最终有效 agent 配置都显式关闭 `autoResume`，在任何 reopened/reloaded session 启动之前生效；不靠给 workflow 请求添加未知字段实现。既有已持久化 workflow 的手动 resume 仍需本仓原授权路径；本次不恢复历史 run、不修改其状态。将来若要启用自动恢复，应另行授权并验证 interactive `ctx.hasUI`、持久 session、crash/reload、broker principal/lease 与 managed cwd 的完整链路；本次没有新增测试任务。

## 0.83.1 capability ceiling：本仓存在明确身份不匹配

官方 `CHANGELOG.md:36` 明确：所有 ceiling 查找改为 `ctx.sessionManager.getSessionId()`；原先按 session file path 注册的 ceiling 不再生效。0.84.0 实际 workflow 校验入口为 `src/runs/foreground/subagent-executor.js:5072`：`intersectSubagentCapabilityCeilings(requestParams.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(ctx.sessionManager.getSessionId() ?? undefined))`；该文件 `:1538` 的另一路启动同样以 `getSessionId()` 查找。修复覆盖 background/workflow child，不能只看导出签名是否相同。

本仓调用链是：

```text
extensions/subagent-runtime.ts:743
  lifecycleSessionId = readSessionIdentity(...).sessionFile ?? resolveCurrentSessionId(...)
:745-747 registerConfiguredChildToolCeiling({ sessionId: lifecycleSessionId })
src/subagent-dispatch/child-tool-policy.ts:28-32
  registerSubagentCapabilityCeiling({ sessionId: input.sessionId, source, ceiling })
```

所以 **持久 session 会传文件路径，与 0.83.1/0.84.0 的 session ID key 不匹配**；无 sessionFile 的情形才可落到 session ID。该注册只在 `childToolCeiling` 显式配置时存在，未配置仍保持原行为。不能把参数名 `sessionId` 当作身份已正确的证据。后续适配应只对 ceiling 注册键使用 session manager ID，不能顺手把 broker/completion 使用的 lifecycle identity 全局替换。

对照 `src/subagent-dispatch/extension.ts:2584-2592`，required child extensions 已明确采用 `getSessionId()`，该处静态匹配。现有 `test/joint-upgrade-host-ceiling.test.mjs` 验证 opt-in 配置，`test/joint-upgrade-ceiling-runtime.test.mjs` 覆盖 runtime 注册/清理；本次没运行，也未证明它们覆盖 0.84.0 持久会话 background/workflow 查找。

## 0.81 bundle 与 registry authority

`CHANGELOG.md:125-150` 明确 0.81.0 起 root 与 subpath exports 改为 bundle，child 仍从 unbundled 文件执行，executor 延迟加载。0.84.0 `package.json:60-101` 的实际映射：

| 公开 specifier | runtime default | types |
|---|---|---|
| `pi-subagents` | `./bundle/index.js` | `./index.d.ts` |
| `/agents` | `./bundle/agents.js` | `./src/api/agents.d.ts` |
| `/required-child-extensions` | `./bundle/required-child-extensions.js` | `./src/api/required-child-extensions.d.ts` |
| `/capability-ceiling` | `./bundle/capability-ceiling.js` | `./src/api/capability-ceiling.d.ts` |

root `bundle/index.js:20` 动态加载 `chunk-235AWJUQ.js`；该 chunk 与公开 subpath 复用同一依赖：

| API | bundle authority 证据 | global key |
|---|---|---|
| `registerRequiredChildExtensions` | `bundle/required-child-extensions.js:3` → `chunk-CTPAE36Y.js:37-38`；root chunk `:191` 引用同 chunk | `Symbol.for("pi-subagents.required-child-extensions.v1")` |
| `registerAgentViaEvents` | `bundle/agents.js:5,8` → `chunk-2S4K53MV.js` 的 event bridge 与 `chunk-G2Z6ZH26.js:14,30-31` 的 registry；root chunk `:210-215` 引用同源 | `pi-subagents:runtime-agent-register:v1` event；`Symbol.for("pi-subagents.runtime-agents.v1")` |
| `registerSubagentCapabilityCeiling` | `bundle/capability-ceiling.js:11` → `chunk-QXASAHIA.js:4-7`；root chunk `:296` 引用同 chunk | `Symbol.for("pi-subagents.capability-ceiling.v1")` |

这些 registry 存在 `globalThis`；unbundled 对应实现也使用相同 key。因此在**同进程、同 global realm 与同事件总线**内，静态依赖和全局 key 支持共享同一 authority，没有证据要求把公开 import 改为 bundle 深层路径。独立 child 进程的 globalThis 不与 parent 共用；跨进程仍依赖上游启动参数/扩展传递，不可由相同 Symbol 字符串推断跨进程共享。Host loader 实际是否同 realm、acknowledgement 与 provider binding 是否保持，仍未运行验证。

本仓公开 imports 位于 `src/compat/pi-subagents-0.75.ts:12-14`、`src/subagent-dispatch/child-tool-policy.ts:3`、`src/subagent-dispatch/extension.ts:39`，应保持公开入口。RPC `src/extension/rpc.js` 在 0.80/0.84 仍为 protocol 1、`ping/status/manage/spawn/steer/interrupt/stop/resume/cost`。本仓 `rpc-client.ts:69-134` 对 security capability 的 fail-closed 协商不能放宽。新增 `jobsChanged` 是未消费的可选事件，无需为升级接入。

## verify-package 的精确门禁

本仓脚本是 `packages/pi-subagents-enhanced/scripts/verify-package.ts`，不是根 `scripts/verify-package.ts`：

- `:13` 的 `UPSTREAM_VERSION`、`:173-182` dependency/version 断言及错误文案需由 0.80.0 精确对齐目标；根/package manifests、locks 与 `scripts/setup-subagent-runtime-deps.ts`、package `scripts/setup-runtime-deps.ts` 的安装常量也需一致。本次未改。
- `:95-143` `fileMap/verifyControlledUpstream` 是动态 SHA-256 对比官方 `npm pack` 解包文件，不是需要人工重填的一组 hash。保持排除 `.package-lock.json`、`.npmrc` 及生成的 nested `node_modules`，比较目标官方包的 **bundle 与 unbundled 全部 payload**，不得为通过而排除新 bundle。
- `:16-24` `expectedExports` 约束的是增强包自己的六个公开 API，upstream 换 bundle 不要求改这张表。`:25-38` required tarball paths 目前只显式列了 upstream manifest；`:146-160` 检查 bundleDependencies 与不打入 Pi core peer，但没有独立断言 upstream root/subpath 的 exports target 全部出现在增强 tarball。
- 目标核对需确保上表四个 default/types 路径、其 bundle chunk 闭包、child unbundled 文件实际打包；保留 `verifyControlledUpstream` 全文件 hash 比对，并审阅 pack 文件清单。不能把“manifest 仍有 subpath”或 hash 本地树通过当作 tarball 闭包完整证明。是否扩展既有 gate 由实施阶段决定，本次不新增测试或改实现。

`verify-package.ts` 会访问官方 registry 并运行 `npm pack --ignore-scripts` 与 dry-run，不是本次已执行的只读检查，也不是纯离线测试。

## Pi 1.5.0 的正确归因

Pi artifact `CHANGELOG.md` 的版本标题为 `:3` 1.5.0、`:119` 1.4.0、`:175` 1.3.0、`:221` 1.2.0、`:396` 1.0.1。原报告两处归因纠正如下：

- `:229-235` 的 sendMessage triggerTurn / before-agent-start / starting busy 属于 **1.2.0**，不是 1.5.0 新变化。
- `:403-412` 的 `registerToolRenderer()` 属于 **1.0.1**，不是 1.5.0 新增。可保留当前接口存在事实，但不能以历史条目增加本次升级任务。
- 真正 1.5.0 `:14` 是工具验证迁到 `@earendil-works/pi-schema`；`:31` 保留 Pi loader 对旧 pi-ai TypeBox imports 的兼容映射。对应 `dist/core/extensions/pi-ai-extension-view.js` 与 `virtual-modules.js`，普通 Node/tsc 不自动获得这个映射。

本仓 typed dispatch 参数是 plain JSON Schema；`coordinator-protocol.ts` 的 TypeBox 是内部 wire schema，不能仅凭使用 TypeBox 推定不兼容。但根源码从 pi-ai 导入 `Type/Static/TSchema` 的静态编译，以及 nested anyOf/const/coercion 的真实 Host 行为，需要目标闭包核对，见隔离报告。`test/subagent-dispatch-schema-coercion.test.mjs` 使用 TypeBox compile，不能单独证明 Pi 1.5 Host validator。

本仓 `src/host-runtime/index.ts:11-16`、`peer-installation.ts:24-29` 精确要求四个 Pi core 1.4.0；未经适配会拒绝 1.5.0。既有 completion ownership、native contact、terminal proof、workspace queue、Goal 和 TUI 验证文件及 skip 门槛见另一报告；不新增来源未证的兼容 fallback。

## 已知新增行为与未验证边界

- 0.81 outputSchema 未调用 structured_output 时增加一次同 session 提示回合（官方 CHANGELOG 的 0.81 Changed）；现有 workflow child 可传 outputSchema。尚未证实公开关闭开关，不杜撰字段；不能宣称这一场景与 0.80 完全等价。
- 0.84 后台完成记录清理：无 session 的旧规则为 30 天，有 session 的 finished run 改为保留 90 天后也清理（`CHANGELOG.md:19`）。这是新增有效自动清理行为；本次没证明公开关闭方式，不把上游记录长期保存当本仓 terminal proof/ledger 的替代。
- 本仓已显式 `mission:false/worktree:false/chatProgress:"off"`，保持这些字段；不启用新功能。autoResume 是已证实可以显式关闭的新增行为。
- 原 registry latest/time 记录属于前轮观察，本轮不刷新；推荐 0.84.0 基于已解包官方安全修复与代码，并非本轮网络证明“此刻 latest”。
- 未验证 Pi 1.5 + 0.84 实际启动、bundle loader identity、真实 capability envelope、required extension acknowledgement、workflow 重放授权、provider/contact/completion、queue/Goal/TUI 运行结果。报告中的静态结论不等于兼容通过。

本次只执行文件读取、`rg` 与 Git 状态核对；测试数为 0，新增测试数为 0。两报告之外无本轮修改，无 staged files；最终状态以交付时 Git 输出为准。
