# Subagent 会话名册注入

本文记录 `packages/pi-subagents-enhanced/src/subagent-dispatch/agent-catalog.ts` 的接口和设计边界。名册 module 已实现，Host 接线、roster 退役及实际请求验收由计划 C3–C5 分别负责；本文不表示整体功能已通过运行验收。

## 数据与执行权威

当前 package 声明 Pi 四核心 `1.4.0`、upstream `pi-subagents@0.80.0`；根 TypeScript 为 `7.0.2`。compat 文件的历史名称与 package AGENTS 中旧版本说明不能作为实际版本依据。

现有 `src/compat/pi-subagents-0.75.ts` 的 `registerBuiltinAgentsViaEvents()` 在初始化读取仓库的 delegate、executor、reviewer profile，向注入的 discovery 调用方返回 `admission: "repository-configured"` 和角色数据。名册消费同一 admission 源，不另读 profile、不扫描目录，不查询 registry、provider 或本机模型配置。profile 更新通过 reload 重建既有 admission 后生效。

名册仅呈现 canonical name 和完整 description；`projectAgentCatalog()` 新建只含这两个字段的对象，按原始 name 的字符串序稳定排序，相同 name 保持输入顺序。它不改源数组或源对象，不读取或携带 models、tools、thinking、profile body 和任意 metadata。`formatAgentCatalog()` 保持输入顺序；正常初始化先投影排序，再格式化。

清理仅发生在格式化副本上：使用 Node 内置 `stripVTControlCharacters()` 去除终端转义序列，再去除除换行、回车、制表符以外的 C0/C1 控制字符，最后编码 XML 的 `& < > " '`。不 trim、摘要、截断 description 或缩短 canonical name，不设置条目数或字节上限。原始投影值不受清理影响。

名册是选择角色的提示。每次真实 `subagent_start` 仍经过原 discovery/admission、模型选择、权限、cwd、RPC 与 workspace 检查；名册不会代替这些检查，也不会增加工具或嵌套派发权限。默认省略 model，仅用户显式指定时才传入，实际模型由既有 runtime 规则选择。

## 格式

以下正文的三个 description 来自当前 `pi/agents/delegate.md`、`executor.md`、`reviewer.md` 的完整 description。formatter 返回外层 tag 内的正文，Pi 的结构化 section renderer 添加 `<advertised_subagents>`；module 不重复包外层 tag。

```xml
<advertised_subagents>
本会话准入角色，通过 subagent_start 使用；名册仅供选择，实际派发仍由 runtime 校验。
默认不传 model，模型由 runtime 按既有规则选择；仅用户显式指定时传入 model。

<agent name="delegate"><description>承接复杂实现、跨模块开发与源码级归因诊断的主力执行代理</description></agent>
<agent name="executor"><description>按任务约束完成实现与验证的编码执行代理</description></agent>
<agent name="reviewer"><description>只读审阅代理：对照计划、源码、diff 与产物识别实现偏差并提出改进建议；工具集无写入/派发能力，不得用于落盘、改文件或提交类任务</description></agent>
</advertised_subagents>
```

以上角色仅为当前 profile 的示例，module 不含固定三角色 fallback。合法空列表会产生仅含使用规则的空名册；读取失败或 admission 不符则 unavailable，不伪造条目。

## 精确接口

事件与 context 类型均从 `@earendil-works/pi-coding-agent` 根公开入口导入。`AgentCatalogEntry` 为只读 `{ name: string; description: string }`；`AgentCatalogReadResult` 为只读 `{ admission: "repository-configured"; agents: readonly AgentCatalogEntry[] }`。依赖 `AgentCatalogDependencies.readAdmittedAgents(ctx)` 可以同步返回结果，也可以返回结果 Promise。

`projectAgentCatalog(agents)` 返回只读投影数组；`formatAgentCatalog(entries)` 返回正文字符串；`createAdmittedAgentCatalog(deps)` 返回 `AdmittedAgentCatalog`，提供 `initialize(ctx): Promise<void>`、`apply(event, ctx): void`、`invalidate(): void` 和 `dispose(): void`。未增加 package export 或新依赖；这是 package 内部接线接口。

## 快照与生命周期

每次 factory 调用持有自己的 generation 和一个当前快照，没有全局单例、外部状态或持久化 custom entry。快照包含 manager 引用、session ID、cwd、generation、状态、entries、最终文本及初始化 Promise。runtime identity 用 manager 对象引用、`ctx.sessionManager.getSessionId()` 和 `ctx.cwd` 精确匹配，不以单独 cwd 或 session 路径猜测身份。

1. `initialize(ctx)` 在新 identity 上递增 generation，立即安装 loading 快照和初始化 Promise，再在微任务中调用依赖。同一有效 identity 的并发或后续调用都返回同一个 Promise，包含 ready 和失败状态；同代失败不会偷偷重试。
2. 依赖返回后重新核对当前快照对象、generation、manager、session ID 和 cwd，仅当前有效结果可以投影为 ready。非 `repository-configured` 结果或读取/格式化失败使当前快照 unavailable，并通过 Promise rejection 交给 C3 的既有错误诊断链；module 不吞错或自行发 UI 通知。
3. `apply(event, ctx)` 只读取内存快照与 SDK 的内存 session ID。仅 ready、identity/generation 匹配且当前 `selectedTools` 含精确 `subagent_start` 时设置 `sections.advertised_subagents`；其余情况仅删除该自有 key。不执行初始化、IO、discovery 或 registry 查询，不更改其他 sections、tool guidelines、forceSystemPrompt 或历史消息。
4. `invalidate()` 同步递增 generation 并清空快照，立即阻断在途读取结果发布。之后可以在同一 identity 上显式 initialize 新代。它不取消底层读取；旧 Promise 仍可能完成或拒绝，但不能恢复旧快照。
5. `dispose()` 幂等，永久禁止该实例重新初始化，并执行失效；dispose 后 initialize 返回已完成 Promise，apply 只撤回自有 section。新 Host 使用新 factory 实例。

C3 应在既有 ready 链的 `beforeSessionStart` 成功后、ready 完成前 await initialize，使用真实 dispatch 的 admission DI。shutdown 入口必须先同步 invalidate，再进入 shutdown debt、beforeDispose 与最终 dispose；不能仅依赖资源列表中的异步 dispose。C3 还须用现有 runtime token/closing 状态阻断旧 ready 回调重新调用 initialize。module 能阻断已经在途的旧 generation 结果，但不负责辨认调用方错误地显式开启的新 generation，也不拥有 Host token authority。

new/resume/reload/cwd-bound replacement 应使用新 context 建立新代。重复请求继续声明同一文本，不重新发现，也不向普通消息追加一份名册。compaction 由 Pi 1.4 的结构化 system checkpoint 承载当前 section；下一轮 before hook 再次声明当前值。该设计遵循 SDK 的 session-format/compaction 合同，实际恢复行为仍需 C5 验证。

GLOBAL/SHARED 必须由 C1 迁成各自 section，以免自有完整 system prompt override 遮蔽名册。外部 extension 的完整 override 可能继续遮蔽 section，module 不清除别人的 override。fresh child 的父级名册隔离由 C3 的 root guard 保证，module 不推断 child 环境或新增 child 工具。旧 session 的 roster call/result 和 fork 原始历史保留；C4 负责 fresh 注册面退役 roster，module 不改历史或注册工具。

## 成本与验证边界

每代名册初始化一次，投影和排序成本为 O(n log n)，格式化与内存占用随 name/description 总长度增长；每次 apply 只核对身份、工具列表和写入或删除一个 section。这里的“一次”只统计 catalog adapter 的调用。真实 dispatch 每次的 discovery 重查仍保留，不能把共享 discovery 回调的总次数要求为一次。

初始化会增加一个稳定的系统 section，重复模型请求仍包含其有效内容。稳定值允许 SDK 避免多余 section delta；实际网络传输量、token 数、provider cache 命中与延迟取决于 SDK 和 provider，不能承诺必然命中或节省整段请求传输。本轮不使用真实 Host/provider，不给出未经观测的 token/cache 数字；C5 应记录最终候选的 section UTF-8 字节数、可取得的 token/cache 元数据及不可观测项。

C2 已在 HEAD `8bc4a88f43550c342fbe3318ca295e93f3eb850c` 的 dirty 工作区运行 `npm run typecheck:subagents-enhanced`，结果通过；`tsc --noEmit -p packages/pi-subagents-enhanced/tsconfig.json --listFilesOnly` 的输出包含新 module，确认 package `src/**/*.ts` 实际覆盖它。两个新增文件的 `git diff --no-index --check /dev/null <文件>` 均无 whitespace 诊断（新增内容的 no-index 状态码为 1），限定 diff 检查通过。

这些静态结果不等于并发、首请求、shutdown 竞态、reload/new/resume、两个 Host、compaction checkpoint、root/child 或实际缓存行为已运行验证。本轮不新增/修改测试，不占用 unit-runner；这些运行边界须保留至 C3/C5 的获授权验收证据到位。
