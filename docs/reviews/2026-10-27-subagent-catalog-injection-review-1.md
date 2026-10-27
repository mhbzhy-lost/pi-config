# Subagent 初始化名册注入计划首审

日期：2026-10-27。以下为首审原始结论；主会话已据此修订计划，不代表功能已实施。

首轮只读审阅结论：计划整体**修订后可执行**，无需重大重写。未发现 Pi 1.4 公开 sections API、`forceSystemPrompt` 语义、现有 admission projection、增强 runtime `ready()` 或工具注册面的硬性接口矛盾。C1/C2 可并行，C3 不依赖 C1，DAG 与当前源码一致。

实际需要修订的有以下三点。

- **严重性：中；计划行：39、221、223、268。**  
  **证据：** 当前真实派发路径在 [`extension.ts:796-805`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:796) 和 [`extension.ts:1246-1282`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1246) 每次 `subagent_start` 都调用同一个 `discover` 回调。计划同时要求 F2/C3 “同代只发现一次”“每个当前 session 一次发现”，如果按共享回调总次数统计，该条件与现有派发准入重查冲突。  
  **影响：** 实现可以正确缓存目录快照，但验收计数会把真实派发所需的 discovery 重查误判为重复目录生成，导致 F2 客观不可通过。  
  **最小改法：** 将表述限定为“catalog snapshot 在每个 runtime generation 只初始化一次”；明确真实 `subagent_start` 的既有 discovery 调用仍按每次派发执行，验收只统计 catalog 初始化调用或为 catalog adapter 单独记录计数。C5 的 discover 调用记录也应区分 `catalog` 与 `dispatch` 两类来源。

- **严重性：中；计划行：142、259、267。**  
  **证据：** 计划已明确 fresh child 不新增父级编排名册；当前增强入口在 [`subagent-runtime.ts:210-212`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:210) 遇到 child 标记会直接返回，child 只通过 required extension 接收共享入口。GLOBAL/SHARED 目标 section 的 scope 也在计划行 23、128-132 中分别定义为 main-only、main/child、child-only。  
  **影响：** C5“main 与 fresh child 分别核对三类 instruction sections、目录和工具集”的文字容易被执行者理解为 child 也必须收到 GLOBAL 和 `advertised_subagents`，这会与既定 child 权限边界相冲突。  
  **最小改法：** 改为：main 核对 `pi_global_instructions`、`pi_shared_instructions`、`advertised_subagents` 与工具集；fresh child 核对 `pi_shared_instructions`、`pi_child_execution_boundaries`，并证明没有 GLOBAL、`advertised_subagents` 或父级操作工具。fork 只核对既有历史继承行为。

- **严重性：中；计划行：139、224。**  
  **证据：** 当前 `session_shutdown` 先注册 [`extension.ts:2435`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2435) 的 `shutdownDebt.run`；catalog 若仅作为 `resources` 加入，会等到 `dispose()` 的资源循环 [`extension.ts:2096-2110`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2096) 才失效。shutdown debt、`beforeDispose` 或上游 shutdown handler 等待期间，旧 before hook 的闭包仍可能存活。  
  **影响：** “session_shutdown 使名册失效”和“旧回调不写新代”的要求没有被当前资源释放时序直接保证，尤其在 reload/replacement 的边界上存在旧 section 被应用的竞态风险。  
  **最小改法：** C3 明确在 `session_shutdown` handler 进入时立即调用 `catalog.invalidate()`，再进入现有 debt/dispose 流程；`dispose()` 保持幂等并作为最终清理。before hook 继续同时检查 runtime token、当前 session identity、cwd 和 catalog generation。

通过项如下。

- Pi 1.4 的 [`BeforeAgentStartEvent.systemPromptOptions.sections`](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:720) 是可变公开接口；`event.systemPrompt` 是只读渲染值。计划 C1 改写 sections 的方向正确。
- SDK 在 [`runner.js:1141-1148`](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:1141) 会把 handler 返回的 `systemPrompt` 写入 `forceSystemPrompt`；[`system-prompt.js:126-129`](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:126) 随后以不透明完整文本取代结构化 sections。C1 迁移 GLOBAL/SHARED 是真实必要依赖，不能靠调整 handler 顺序解决。
- 当前 admission 确实由固定 profile 缓存提供，且返回 `admission: "repository-configured"`、`name`、`description`；见 [`pi-subagents-0.75.ts:134-157`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts:134)。C2 的最小 projection 不需要新增扫描、export、upstream 私有 import 或第二 authority。
- `ready()` 当前在 [`extension.ts:2393-2423`](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2393) 通过单飞状态执行既有 startup 链，C3 将 catalog 初始化接入 `beforeSessionStart` 后、`started = true` 前是可行位置。C2/C3 的 generation 与 token 检查可以复用当前 registry 语义。
- 当前 operation factory 将 roster 作为独立 descriptor 注册；移除该 descriptor 是 C4 的最小改动面。`model-only` 工具本身不会进入 codemode 的 callable 面，计划对 fresh 注册、active 集合和历史 renderer 分开验收的方向正确。
- C1 目标文件、C2 新 module、C3 接线位置、C4 文档/既有合同和 C5 验收报告路径均存在或属于计划明确的新产物；没有因新 module 尚不存在而形成阻塞。
- 计划没有把测试授权缺失伪装成通过，也没有要求当前首审运行测试、真实 Host/provider、安装或读取凭据，符合本轮只读边界。

本轮未运行测试、typecheck、build、install、真实 Host/provider 或网络命令，因此不能证明首请求、compaction checkpoint、reload/new/resume、多 Host 或缓存元数据行为。它们应继续保留为 C5 的真实验证项；当前验收结论只能是静态可执行性审阅。
