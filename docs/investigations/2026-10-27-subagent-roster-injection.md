# Subagent 名册初始化注入调查

日期：2026-10-27。调查方式：安装源码、公开文档与既有纯 factory 合同测试；未实现、未启用、未启动真实 Host/provider。

## 结论

**upstream `pi-subagents@0.80.0` 已支持把可用 agent 的名称、描述作为启动快照注入父会话系统提示，模型不必先调用 list。当前增强层不能仅靠配置直接启用这套机制。推荐在增强 Host 内复用已有 admission 结果，按当前 session/runtime 生成一次简短快照，在 `before_agent_start` 中持续声明同一个结构化 prompt section；真实派发继续执行原有准入、模型和授权检查。可以取消 `subagent_roster` 的模型工具注册及“每次派发先查名册”的要求。**

必须同时处理本仓已有的完整 system prompt override：`src/agents-global/index.ts:83`、`src/agents-shared/index.ts:96` 返回 `{ systemPrompt }`。Pi 1.4 会把它变成 `forceSystemPrompt`；后续 section 修改可能只被记入会话而没有进入该轮 provider 的强制文本。即使顺序保证它被带入，完整 override 也会折叠 system 历史，不能宣称具备纯结构化增量的缓存收益。推荐方向是把这些既有注入迁到各自独立结构化 section，保留读取、角色、门禁与子执行边界语义；本次只识别必要适配面，不改实现。

“初始化一次”应解释为**每个当前 session、cwd、资源/admission generation 生成一次，后续请求持续包含同一份信息**。不应解释为进程第一次启动后永久缓存，也不应解释为只发一条可被 compaction 摘要掉的普通消息。

## 基线与调查边界

工作目录为 `/Users/leshi.zhy/pi-config`，开始时 HEAD 为 `8bc4a88f43550c342fbe3318ca295e93f3eb850c`。四核心 `pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui` 实际 manifest 均为 `1.4.0`。增强包 manifest 是 `pi-subagents-enhanced@0.1.0`，依赖及实际安装 upstream 都为 `0.80.0`。`packages/pi-subagents-enhanced/scripts/verify-package.ts:13` 同样锁定 `0.80.0`。

已完整读取根 `AGENTS.md`、`pi/AGENTS_SHARED.md`、package `AGENTS.md`。package 规范中 `0.79.2` 是已知过时文本，不能覆盖 manifest/安装结果。`src/compat/pi-subagents-0.75.ts` 是历史文件名；当前实现主要消费 upstream root 与 `./agents` 等公开入口，并没有因为允许集中深引就实际新增深引。本报告中的 upstream 内部读取只是诊断，不建议把这些内部路径复制到生产 import。

路径简写：

| 简写 | 实际根目录 |
| --- | --- |
| `P` | `node_modules/@earendil-works/pi-coding-agent` |
| `E` | `packages/pi-subagents-enhanced` |
| `U` | `packages/pi-subagents-enhanced/node_modules/pi-subagents` |

完整阅读的主要文档包括 `P/README.md`，`P/docs/extensions.md`、`how-pi-works.md`、`configuration.md`、`settings.md`、`security.md`、`sessions.md`、`session-format.md`、`message-types.md`、`compaction.md`、`sdk.md`、`packages.md`、`skills.md`，以及 `P/examples/extensions/subagent/README.md`、`E/README.md`、`U/README.md`、`U/docs/agents.md`、`U/docs/configuration.md`。跟进了与 prompt、发现、session、compaction 相关的交叉引用及类型声明；没有把与本题无关的 UI/provider 接入链接扩为实施任务。例子核对了 `prompt-customizer.ts`、`dynamic-resources/index.ts`、SDK `03-custom-prompt.ts` 和示例 subagent 的注册/发现代码。为检查指引影响，完整读取 upstream 的 pi-subagents skill、management-authoring-rpc reference 与 council-mode skill；它们是被审查对象，本任务没有执行其中的编排指令。

未读取 `pi/models.json`、任何 auth/凭据/证书或其备份内容，未访问本机模型可用列表。只读取了角色 profile 的 frontmatter，以确认元数据来源，不在报告复述其具体 provider/model 候选。工作区原有其他任务的 dirty 文件、计划、footer 与 steer 诊断均未修改。本任务唯一写入是本文。

## 当前 `subagent_roster` 的完整数据链

### 注册、schema 与输出

1. `E/extensions/subagent-runtime.ts:199` 的主入口先根据 `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_FANOUT_CHILD` 排除 child；要求可信 `PI_CODING_AGENT_DIR`。
2. `E/src/subagent-dispatch/extension.ts:2012` 调用 `createSubagentOperationTools()`，随后在 `:2032` 注册该数组。旧 `subagent` union 对象仍承载内部 execute 闭包，但不作为 fresh Host 工具注册。
3. `E/src/subagent-dispatch/operation-tools.ts:85` 的 `SUBAGENT_ROSTER_PARAMETERS` 为无参数 object，`additionalProperties:false`；`:197` 的 descriptor 固定 `action:"list"`，`:318` factory 统一声明 `exposure:"model-only"`。传入 action、agent 等额外字段会在 factory 失败，不触及下游。
4. factory 委托原 executeControl；`E/src/subagent-dispatch/extension.ts:1448` 的 `executeControl()` 对 list 调 `discover(ctx.cwd, "both", ctx.model?.provider)`。带 `admission:"repository-configured"` 时只过滤 `disabled`；其他来源还要求 `filePath` 存在且路径不含 `.agents`，随后按 name 排序。该路径过滤是现有实现事实，不能泛化成 upstream 的信任规则。
5. list 的 `content` 是 `{name,frontmatter}` 数组 JSON；`details.agents` 额外保留 description、model、models、tools、metadata。metadata 来自原始 frontmatter 的深拷贝，不包含 profile 正文。当前工具确实把完整 frontmatter 交给模型，而不是只在 TUI 展示（`:1462`）。

### 当前 Host 的权威 admission

`E/extensions/subagent-runtime.ts:223` 的 `registerBuiltinAgents()` 经 `afterBootstrap` 安装 `registerBuiltinAgentsViaEvents()`；传入 dispatcher 的 discover 回调位于 `:321`，缺 admission 即 `AGENT_ADMISSION_UNAVAILABLE`，没有扫描目录的 fallback。

尽管函数名带 ViaEvents，当前 `E/src/compat/pi-subagents-0.75.ts:134` 的实现并不做公开 runtime agent 注册：它在创建时读取 `<agentDir>/agents/delegate.md`、`executor.md`、`reviewer.md` 三个文件，缓存成数组，返回 discovery projection。`:141` 的 `_cwd`、`_scope`、`_preferredProvider` 全被忽略；`requestedName` 检查是可选参数，但当前 Host 包装只传三个参数，派发靠后续 name 查找裁决。每次 discover 都返回字段拷贝及 metadata 深拷贝，dispose 清空缓存。

`parseFrontmatter()` 使用 Host 公开 parser，要求非空 name/description/body，识别 models/model/thinking/tools，完整 metadata 单独保留。三个 profile 的角色描述分别是复杂实现与源码归因、确定性编码执行、只读审阅；reviewer 的 description 已明确没有写入/派发能力。当前三个文件均没有 `advertise` 字段。

这意味着**当前 roster 反复调用不会重新读取这些 profile**。固定缓存下，cwd 变化与新增 project agent 并不会自动改变这份本仓 admission。兼容 parser 没有把 `disabled` 提升为 agent 顶层字段，因此把该字段只写入 profile frontmatter 也不会让增强 list 的 `!a.disabled` 生效；原始值仅留在 metadata。upstream 的 disabled settings/实际执行校验是另一层，不能把两者合并描述成同一过滤。工具名/文案里的“当前发现”不能据此解释成每次扫描磁盘。

### 真实派发仍有独立检查

`E/src/subagent-dispatch/extension.ts:796` 的 `resolveSpawnModel()` 每次调用同一 discover，再按精确 name 找 profile；coding 与 generic 分别在 `:1060`、`:1281` 使用它。若声明了模型 profile 或显式模型，就调用 `ctx.modelRegistry.getAvailable()`；`E/src/subagent-dispatch/model-selection.ts:105` 的 `resolveModelCandidates()` 按已声明候选顺序与可用 registry 交集选择，并排除 blocked provider、检查模型 API。模型 registry 不可用或候选全不可用会报错，roster 本身没有执行这些可用性检查。

增强层随后走 typed 编译、Root Broker/RPC 协商、授权和真实 upstream workflow spawn；upstream 再按实际执行 cwd、scope 与项目 trust 做自身 discovery 和 canonical name 校验。见 `U/src/extension/index.js:400` 的 `discoverAgentsForRuntime()`、`U/src/runs/foreground/subagent-executor.js:285` 的 trust 绑定、`:2223` 的 workflow validation discovery，以及 `:3376` 等 childCwd 查找点。

因此这里有两层权威：本仓固定 admission 是父工具可选角色/模型 profile 的约束，upstream 是实际启动定义及执行校验的权威。**从当前同名 profile 推断两层永远相等不成立**；project override、设置、执行 cwd 或文件编辑都可能使其不同。这是静态链路已经存在的边界，本报告不把它扩为新兼容逻辑或修复任务。

### 动态变化矩阵

| 变化源 | 当前增强 roster/admission | upstream 发现/原生广告 | 推荐快照处理 |
| --- | --- | --- | --- |
| cwd 或派发 cwd | 本仓 discovery 忽略 cwd；dispatch 仍将实际 cwd 交给执行链 | 影响最近项目根、project agent、package、settings；派发 childCwd 可与父 cwd 不同 | 绑定 Host 当前 cwd；跨 cwd 派发明确快照仅是父会话提示，执行继续重查 |
| 新增/修改 project agent | 不加入固定三 profile admission | 可信项目参与；同名 project 高于 user/package/builtin | 不从扫描结果偷偷扩大准入；若未来扩展，先统一权威接口 |
| 修改三 profile | 缓存不变，重建 runtime 才重新 parse | 发现缓存有路径指纹；执行 discovery 与广告快照不具有同样刷新频率 | 采用显式 `/reload` 生效；不增加 watcher/逐请求磁盘轮询 |
| trust、admitted profile、capability ceiling | 固定 admission 独立于项目 trust；list 不另按 allowedAgents 过滤 | untrusted 的 both 降为 user；广告排除 disabled/ceiling 不允许者 | 用现有 admission 作为底集；如需显示“当前允许”再用公开 ceiling 投影，不复制私有判断 |
| `/new`、`/resume`、fork、reload | Pi 重建运行时，重建 admission；不能依赖进程级一次变量 | session_start 重建广告；恢复按会话工具记录和 pinning 处理 | 每个新 session/runtime 重建；清理旧代闭包与 hook |
| 模型选择、registry 可用性 | roster 不查询可用 registry，派发时查询 | preferred provider 会影响 settings overrides；广告保存 session_start 的 model/provider，不监听 model_select 重扫 | 最小快照不列“当前可用模型”；registry 变化由真实派发检查 |
| 内存 ceiling 更新 | 当前 list 无这层过滤，派发仍受执行门禁约束 | 每轮 prompt 过滤广告名单 | 若采用过滤，可复用已缓存 profile 做纯内存投影；不必再调工具 |

upstream 具体源码：`U/src/agents/agents.js:2352` 的 `discoveryCacheKey()` 包含 cwd/provider/agentDir/env/trust；`:2385` 的 `buildAgentDiscoverySources()` 汇合 user、project、package、scan roots、exclusions；`:2598` 的 `buildEffectiveDiscovery()` 合并并去除 disabled；`:2736` 的内部 `discoverAgents()` 执行 trust scope 选择。项目 trust 是 Host 参数，不是路径名字中出现 `.agents` 就可信或不可信。

## upstream 0.80.0 原生注入：真实实现与被抑制点

### 机制与默认值

| 真实 symbol / 源码 | 行为 |
| --- | --- |
| `registerSubagentExtension`，`U/src/extension/index.js:219` | upstream root bootstrap；child 标记为 1 时退出。注册执行工具、通知、事件及广告生命周期 |
| `beginAdvertisement`，同文件 `:368` | session_start 保存 cwd/model/projectTrusted，递增 generation；异步解析 global npm root 后生成广告，防旧代覆盖 |
| `refreshAdvertisedAgents`，同文件 `:360` | clear discovery cache，再 `discoverAgents(...,"both",...)`，仅收 `advertise === true`；并非本仓固定 admission |
| `before_agent_start`，同文件 `:644` | 等待广告 ready；可选 activeRunsPrompt 单独写 active_subagents；只有 selectedTools 含精确 `subagent` 才写 advertised_subagents |
| `buildAdvertisedAgentCatalog`，`U/src/agents/advertised-agent-prompt.js:35` | 去除 runtime、disabled、未 advertise 及 ceiling 不允许者；按 name 排序，输出 name/description，不输出 models/tools/thinking/body |
| `buildAdvertisedAgentPrompt`，同文件 `:65` | 为 loader 结果包装同一 catalog；不是独立配置 API |
| `registerSubagentToolActivation`，`U/src/extension/tool-activation.js:117` | mode 默认 auto；dynamic 总是 loader，eager 不注册 loader；根据 provider 工具增量兼容能力决定冷/热启动 |
| `registerPinnedTool` / `recordedPromptSection`，`U/src/extension/declaration-pinning.js:148` | 默认保留恢复会话已声明的原生工具定义、snippet/guidelines；catalog 保留旧 introduction，entries 仍取当前快照 |

profile 的 `advertise:true` 是显式 opt-in，默认未声明就不入广告。支持在文件 frontmatter 或 `subagents.agentOverrides.<name>.advertise` 配置（`U/src/agents/agents.js:775`、`:1215`、`:1913`）。runtime 注册不支持 advertisement，不能用 `registerAgentViaEvents()` 解决广告问题。

广告上限是 16 个 agent，整体含 XML escaping/引言/省略计数不超过 12,288 UTF-8 字节，description 先清控制字符与空白，再限 512 UTF-8 字节并转义 XML。canonical name 不截成另一个不可解析的名字。该截断属于原生广告构建契约；若本仓实施自己的快照，必须显式定义自身模型信息边界，不能借 TUI 精简之名改已有 raw tool/result。

没有一个 `injectRoster:true` 总开关。`toolActivation:"eager"` 控制原生 subagent 工具是否从首请求激活；`activeRunsPrompt:true` 控制正在运行的任务提示，默认关闭，和可用 profile 名册不是同一功能；`toolDescriptionMode`/`promptSnippet`/`promptGuidelines` 只改变工具提示，不提供角色发现。具体 config 校验见 `U/src/extension/config.js:211`、`:220`，路径由 `getConfigPath():238` 选择 agentDir 下的 `extensions/subagent/config.json`。本次没有读取或修改该本机 config，不能断言其当前 activeRunsPrompt 等取值。

广告快照在每次 session_start（`:1100`）和 extension-owned agent-management mutation（`:506`）刷新。外部文件/settings 修改需 reload；普通 prompt 只做内存 filtering/formatting。`resolveGlobalNpmRoot()` 在 `U/src/agents/global-npm-root.js:5` 可执行本地 `npm root -g`，默认超时 5 秒，PI_OFFLINE 可跳过；不是安装依赖。本次没有执行。当前增强 bootstrap 已保留广告 session handler，这项发现工作可能已经发生，即使最后没有提示注入，不能把全部扫描成本都算作“启用后新增”。

### 增强膜实际抑制链

`E/src/subagent-dispatch/runtime-membrane.ts:149` 对 `pi.on` 只截获 session_start/session_shutdown，其他事件仍转发；所以 **before_agent_start 并未被膜直接吞掉**。`E/src/subagent-dispatch/extension.ts:2362` 捕获 upstream session_start，`:2474` 在增强 beforeUpstreamSessionStart 完成后逐个运行，再激活事件订阅。没有一条事件白名单专门禁止 catalog hook。

真正的第一处偏离在膜的 `registerTool`（`runtime-membrane.ts:180`）：除绑定 `subagent_supervisor` 的 execute 外，原生 `subagent`、`subagents_enable`、`bg_wait` 等定义都不交给 Host。增强层注册的是 `subagent_start` 等独立操作工具。Pi 的 active/selected tools 只认已注册的工具，因此原生 hook 在 `U/src/extension/index.js:654` 的 `selectedTools.includes("subagent")` 返回前就退出。即使只加 advertise:true，甚至配置 eager，也不能解除这个结构性条件。

第二个条件是三个本仓 profile 没有 advertise:true；即便改工具名判断，原生广告仍未必包含它们，且可能出现本仓 admission 以外的其他文件 agent。第三个条件是本仓既有 forceSystemPrompt hook 的组合，详见下节。

原生公开 exports 没有发现或 catalog formatter：`U/package.json:62`，`U/src/api/agents.js:1` 只导出 registerAgent/registerAgentViaEvents 等注册能力。不得为了“复用原生”从新业务模块 import `U/src/agents/advertised-agent-prompt.js` 或 `agents.js`。若未来确需封装，也只能在兼容 owner 内决策；本题的小型 Host 投影不需要新增这种依赖。

## Pi 1.4 推荐层与生命周期

Pi 的定位是最小可扩展 harness，subagents 属于 extension（`P/README.md`）。资源发现中 skills 已采用启动只公布 name/description、正文按需读取的方式（`P/docs/skills.md`），这是可借鉴的信息规模设计，并不意味着要把 agent 伪装成 skill。

| 注入位置/API | 适用性与结论 |
| --- | --- |
| extension factory | 注册 hook、创建纯对象；不要在此启动长驻资源。可以复用已存在的 admission 初始化，但不能只用 process.cwd 或进程级 singleton 定义会话快照 |
| `session_start` | 用真实 ctx.cwd、sessionManager 与现有 ready/admission 生成快照；覆盖 startup/reload/new/resume/fork，适合作为快照生命周期边界 |
| `before_agent_start` 的 `systemPromptOptions.sections` | **首选模型注入面**。每轮把缓存好的同一正文设置到独立 key，Pi 自动差分，内容不变不会追加一份重复 section。不是每轮调 roster 或重扫文件 |
| `promptSnippet` / `promptGuidelines` | 适合 `subagent_start` 的一行用法和“默认省略 model”等规则。动态名册放工具 metadata 会把角色变化绑定工具定义/激活，不如独立 section 清晰 |
| `appendEntry()` / session custom entry | 不进入 LLM context；最多记录审计 generation/digest，不能单独完成注入。最小方案无需新持久化账本 |
| `sendMessage()` / custom_message | 会进入上下文，display:false 只隐藏 TUI；一次消息可被摘要，且是 user-role 投影，不宜充当长期权威名册 |
| `resources_discover` | 返回 skillPaths/promptPaths/themePaths，没有任意 system section 或 agents 返回字段；不适合写临时 Markdown 文件绕行 |
| SDK ResourceLoader 的 append override | SDK 自有 Host 可在 resourceLoader 构建时使用，示例 `P/examples/sdk/03-custom-prompt.ts`；当前 package extension 无须替换整套 loader |
| `before_provider_request` | 已是序列化 provider payload，按 provider 分支且不自然持久化；不适合通用目录注入，也会干扰缓存与审计 |

源码证据：`P/dist/core/extensions/types.d.ts:551` 定义资源发现结果，`:575` 定义 session_start reasons；`P/dist/core/system-prompt.js:68` 的 `buildSystemPromptSections()` 为自有 key 包 XML；`:140` 的 `diffSystemPromptSections()` 仅输出变化/删除。`P/dist/core/extensions/runner.js:1121` 每次用规范化 base options 运行 before hook；`P/dist/core/agent-session.js:1287` 构建 base，`:1323` 比较 transcript 当前 sections，`:1488` 调 before hook，`:1525` 把差分放在本轮消息前。

因此必须每轮**重新声明**已有 section，不能设置一次后期待 event options 永久保留。发现与渲染可分开：profile 快照按 session/runtime generation 缓存，工具可见性/ceiling 的纯内存投影可按 prompt 应用，内容稳定就复用相同文本。只有 active dispatch 工具在当前会话确实可用时才公布“可派发”名册；否则明确移除该自有 section，不凭 catalog 授权执行。

### 本仓 forceSystemPrompt 的组合约束

`P/dist/core/extensions/runner.js:1146` 把任何返回 systemPrompt 存到 `currentOptions.forceSystemPrompt`；`P/dist/core/system-prompt.js:126` 使 forced 文本优先于 sections；`P/dist/core/agent-session.js:1366` 的 `_installAgentForcedPromptProjection()` 把 system 消息折叠为 provider leading system prompt。

本仓 GLOBAL/SHARED 注入仍采用拼接完整文本，而且它们被 `pi/extensions/agents-global.ts`、`agents-shared.ts` 加载。catalog hook 若在它们之后运行，修改 sections 不会自动重渲染此前固定的 forceSystemPrompt。只依赖扩展发现顺序使新 section 先于所有 override，是脆弱的集成要求，还须考虑其他已安装 extension；本次未启动 Host，也未枚举外部 adapter 的全部 hooks，不能断言实际最终顺序与 provider payload。

推荐把 GLOBAL/SHARED 的模型注入改为各自 section，明确保留主/子作用域、input 读取快照、空/缺文件门禁及现有边界文本，避免重复 XML 包装。此改动不是移除 roster 的权限调整，也不能顺便把非 fatal before hook throw 宣称成 provider 硬门禁。若实施范围暂时只允许新增 catalog，须将完整 override 组合列为未通过的验收点，不能宣布缓存/首请求注入完成。

### Compaction、resume 与缓存

`P/docs/session-format.md` 及 `P/dist/core/session-manager.js:882` 证明 compaction 会保存当前完整 systemMessage checkpoint；上下文恢复从该 checkpoint 加摘要/保留消息重建。结构化名册不会依赖摘要模型记住它，也无需 compact 后再调 roster。新的 prompt 重声明同一 section，会与 checkpoint 比较。历史版本缺 checkpoint 的 session 也应在下一次 before hook 重声明，不能信任旧普通消息。

new/resume/fork 由 `P/dist/core/agent-session-runtime.js:134` 等入口根据目标 session 的 cwd 重建 cwd-bound services；reload 由 `P/dist/core/agent-session.js:2998` 先 shutdown/invalidate，再重载资源和 session_start。应使用新 ctx，释放旧代快照/订阅；不得跨 session/cwd 共享一个“已经注入”布尔值。树导航不是资源热更新，下一次 before hook 以当前快照修正该分支的 system state。

稳定 section 有利于 provider prompt-cache 前缀复用，但模型请求仍持续携带/重放这段信息，token 和传输成本没有凭空消失。支持中途 system/tool 变化的 provider 可利用增量；其他 provider 会 checkpoint/重建前缀，变更快照仍可能付一次 cache miss。compaction 本身重建上下文，cache key/TTL/provider 路由也影响命中。当前完整 override、更换工具集或换模型都可能打断收益。本次没有实测 cacheRead/cacheWrite、延迟或 token usage。

## 最小注入字段与信息边界

建议正文只包含以下内容：

| 字段/规则 | 原因 |
| --- | --- |
| canonical `name` | `subagent_start.agent` 的实际 identity；不能截短、猜 alias 或用显示档位代替 |
| `description` | 表达适用任务，直接复用 admitted profile 的角色描述 |
| 必要的角色限制 | reviewer 只读、不负责落盘；当前 description 已包含，不再复制完整 tools 白名单。delegate/executor 的角色与档位映射沿用 GLOBAL |
| 一条调用规则 | 名册是 profile 可选范围；默认省略 model，runtime 选择可用候选；真正准入和权限仍由 dispatch 决定 |

无需把 models/tools/thinking 全量 frontmatter 注入；应直接投影 admission 的原始对象，不调用 `subagent_roster.execute()`、不序列化再解析工具回执，也不制造一条工具调用历史。父模型不负责从 registry 选模，GLOBAL `:108` 已规定默认不传 model。若产品确需展示档位，可以显示“复杂实现/确定性执行/只读审阅”等稳定用途，不展示具体本机 provider/model 路由。profile name 是配置身份，不是 RunAuthorization，不能用某个名字授予 coding/Goal/workspace capability。

示意正文可以是三行 `delegate — …`、`executor — …`、`reviewer — …`，加一句默认模型与执行门禁说明。复用三条现有中文描述并采用少量标记，预计是数百 token，规划预算约 300–600 token；这不是 tokenizer 实测。完整 frontmatter 随候选数量、工具列表和未来任意字段增长，成本与隐私暴露都更大。原生 12,288 字节上限也不能简单等同固定 token 数，尤其中文与 XML 转义的比例不同。

内部快照可带 session/cwd/admission generation 或 digest 作失效依据，但无须向模型泄露绝对 profile 路径、home、完整 body、任意 metadata、自定义 endpoint、凭据或本机 models 配置。只从成功准入结果做投影，不额外扫未信任目录；描述作为配置数据处理，稳定排序、处理控制字符/必要转义，不把描述提升为新执行指令。

如果 admission 不可用，应撤掉“可用名册”并保留已有 dispatch fail-closed 错误，不能回退到三个硬编码角色或另一套发现。已有 snapshot 只能作为提示，不能跳过真实 dispatch；需要的不是新增 fallback，而是继续使用当前权威错误。

## 原生方案与小型 Host 方案的成本比较

| 维度 | 直接启用/适配原生广告 | 增强 Host 小型快照（推荐） |
| --- | --- | --- |
| 裸 upstream 所需设置 | 对角色设 advertise:true，保证原生 subagent active；eager 可省 loader | 不适用 |
| 当前增强 Host 能否只配开关 | 不能：膜阻断工具注册、精确工具名判断、广告 opt-in 与 admission 差异、force override 均需处理 | 新增一个投影/生命周期 owner，复用既有 discover DI；同样处理现有 force override |
| 数据权威 | upstream 文件发现，不自动等于本仓固定 admission；可能多列/少列 | 直接消费当前 admitted profiles，与 roster 和选模的入口一致 |
| 生产兼容成本 | 放行旧 subagent 会重现旧 union 执行面，扩大管理/绕过合同风险；只改 hook 也须在 compat 封装受控适配，不能生产散布深引 | 无需新增 upstream 私有 import、导出或 runtime；不恢复旧工具，不增第二发现器 |
| 字段与隐私 | 原生仅 name/description，已有容量和转义策略；需 opt-in | 显式最小字段；不再把任意 metadata 自动传给父模型 |
| 生命周期 | session/reload/management mutation 快照；每轮内存 ceiling 过滤；额外异步 global npm root 发现 | 绑定现有 admission ready/session generation，reload 生效；最小情形不新增磁盘扫描 |
| 缓存 | 原生设计支持 Pi 1.4 sections/pinning；本仓 force hook 会削弱或阻断 | sections 稳定输出；解决 force hook 后才能主张与该设计一致 |
| 删除 roster | 原生也不需要 list 才能启动 advertised agent，但只覆盖 advertise 子集 | 可替换当前三profile的常规派发前名册步骤；执行继续校验 |
| 升级负担 | 私有 formatter/closure 不属于公开 API，适配维护面较大 | 依赖 Pi 公开事件及当前 package owner 的数据结构，差分更小 |

不建议为提示能力放开膜的全部 registerTool，也不建议把 `subagent_start` 伪装成名为 `subagent` 的占位工具去通过条件。前者扩大工具/管理执行面，后者宣称了不存在的 schema/语义。直接同时安装 standalone pi-subagents 更会造成第二 runtime、renderer 和事件身份；`E/README.md` 明确要求来源互斥。

### 多 Host、child 与嵌套影响

快照归每个 Host API / session generation；两个物理 Host 不能共享 process-global 文本或更新彼此 cwd。现有 upstream 有 sessionManager/runtime registry、增强层有 shutdown debt/ready 序列，新增投影应加入同一生命周期，不另起 watcher、broker、定时器或独立 session authority。

增强主入口已经 child guard，三个现有 profile 的 tools 均没有 subagent/subagent_start/subagent_roster，也未授权嵌套，因此不应为名册给 child 新增工具。`U/docs/agents.md` 和 `U/src/runs/shared/subagent-prompt-runtime.js:299` 还证明 fork child 可保留父会话原始系统提示/catalog 来复用缓存；这不代表 child 获得父工具权限，自己的工具与边界另行说明。fresh child 不应重复注入父级编排目录。未来授权 fanout 时，只使用 child 原有嵌套能力与 ceiling，不把这份 root 名册当成嵌套授权；也不为了清理 fork 展示而改 raw inherited transcript。

自定义 section 最好保留原生含义明确的 `advertised_subagents` key（正文应注明本仓 admitted profile 范围、使用 subagent_start），并保证唯一 owner；否则使用新 key 时要检查 fork 的 loadout section 识别。原生 hook 在当前增强面不写该 key，不代表将来适配后还能让两者同时拥有；实施时必须明确二选一，防双重目录或相互覆盖。

## 取消 `subagent_roster` 的最小改动面

这是后续实现范围评估，不是本次实施计划。

| 位置 | 最小必要处理 |
| --- | --- |
| `E/extensions/subagent-runtime.ts` 与 `E/src/subagent-dispatch/extension.ts` | 把同一 admission discover/ready 结果交给 package-owned snapshot 投影，按 session lifecycle 声明 section；保留真实 execute/准入/RPC/模型链 |
| `E/src/subagent-dispatch/operation-tools.ts` | 删除 roster descriptor/模型注册与相关 prompt snippet/guideline；最小迁移不要求同时删除内部 list 处理/历史 schema 导出，可先留给已有诊断消费者。若全删除再核对内部引用 |
| `src/agents-global/index.ts`、`src/agents-shared/index.ts` | 解决 forceSystemPrompt 与 section 的组合；优先结构化改造，保留原内容/作用域和门禁；不可仅加一个后置 section 后宣称完成 |
| `pi/AGENTS_GLOBAL.md:50`、`:77`、`:82` | 取消每次派发先 roster，改为使用当前注入的名册；同步工具名索引和旧名映射。保留角色选择、默认省略 model、审批与合同规则 |
| `pi/agents/{delegate,executor,reviewer}.md` | 当前 whitelist 不含 roster，通常不必改；不因目录注入增加工具或嵌套权限。description 已足以表示角色，无需加入 advertise:true 来满足 Host 投影 |
| skill 指引 | 本仓 `skill-overrides` 未检出 subagent_roster；upstream pi-subagents skill 仍用旧 union list，council-mode 更要求先 list。不要修改受控 node_modules；若未来启用这些资源，应在本仓已有资源过滤/override 边界选择适配，不能照抄旧调用 |
| 测试合同 | 调整七工具/十四工具精确枚举、roster 空 schema/委托与 frontmatter 断言、GLOBAL 指引断言；保留其它操作的安全合同，不为旧 fixture 添加 production fallback |
| TUI 与历史 | `E/src/tui/compact-rendering.ts:11` 的 roster→list 映射可保留读历史；不必删除旧 transcript 的渲染，不改 raw result/details |
| package exports/发布 | 当前五个 exports 没有 roster 专用公开子路径，最小改动无需新 export。`verify-package.ts:16` 精确锁 exports，保持不变；不扩大 compat 深引，也不修改受控 upstream |

测试引用范围至少包括 `test/subagent-operation-tools.test.mjs`、`subagent-runtime-membrane.test.mjs`、`subagent-dispatch-extension.test.ts`、`operation-guidance-contract.test.mjs`、`joint-upgrade-model-only.test.mjs`、`subagent-model-selection.integration.mjs`、`custom-footer-subagents.test.mjs`、`subagent-compact-rendering.test.mjs` 与 `pi-runtime.integration.mjs`。其中部分只是注册数量/历史 renderer 合同，部分会创建 Host/provider；不能将它们一律当作可在本次运行的纯单测。

Pi 1.4 tool exposure 不要求工具动态发现：direct/model-only 注册即激活，后者仅普通模型调用，不能从 codemode 脚本 executeTool。当前操作工具全部 model-only；catalog 中介绍角色与启动工具可见性是两个独立概念。移除 roster 后，`subagent_start` 不需要 tool_search 或 subagents_enable 才能使用；若实际 Host 的 allowlist/exclude 禁用了 start，目录应撤回而不是绕过。只从 active set 去掉工具不等于卸载注册，若真要保留诊断定义但撤出全部调用面，应使用 Pi 的 hidden exposure；更小的硬切换是 fresh runtime 根本不注册 roster。

## 验证与未验证边界

已执行且无外部依赖的验证：

```text
node --test test/subagent-operation-tools.test.mjs
测试 13；通过 13；失败 0；跳过 0。
```

执行前完整审计该测试：只导入 TypeBox 编译器、纯 operation-tools factory 和 callback spy，不启动 Host/provider、socket、child 或外部系统。它证明当前七工具的 schema、model-only、固定 list 委托、跨面字段拒绝和 raw 引用保持；**不证明新注入行为**，因为本次没有实现它，也没有新建/修改测试。

其他实际命令是只读 `pwd`、`git rev-parse HEAD`、`git status --short`、`git diff --cached --name-only`、`rg --files` 与 `rg -n` 定位，以及 read 工具逐文件阅读。有几次首次路径搜索返回非零（upstream 不在根 node_modules、pi/skills 不存在、无匹配），随后按实际 package-local 路径继续；这些不是应用运行失败，也未触发 fallback。

后续获准实现时可使用现有 `npm run typecheck:root`、`npm run typecheck:subagents-enhanced` 及聚焦 factory/膜/指引测试。涉及 Host 的 integration 必须先审计其 fixture、副作用和 provider 类型；本次未运行。`npm run verify:subagents-enhanced` **没有运行**：其 `verifyControlledUpstream()` 会 `npm pack pi-subagents@0.80.0` 访问 registry 并生成临时内容（`verify-package.ts:110`、`:128`），不属于本次只读边界。真实缓存、首次 provider payload、session new/resume/reload 的最终 hook 顺序、外部 adapter hooks 与多 Host 行为均未做真实运行验证，不得从源码结论宣称已验收。

本次数据归因链已经明确：模型工具注册 → 固定 action → 增强 discovery DI → 固定 admitted profile projection → roster JSON；原生链则是 session_start → upstream file discovery → advertise 快照 → selectedTools/ceiling → prompt section。两链首个结构差异是原生工具注册被膜截获，另有 fixed admission 与原生发现集合差异。没有测试异常被当作生产可达数据，也没有增加兼容、降级、凭据读取或额外发现路径。

交付条件：只新增本文；生产、测试、配置文件无本任务改动；无暂存操作。最终只读检查显示本文 222 行（本段修订前计数）、全部 52 处带根简写的文件引用均存在，`git diff --cached --name-only` 为空；外部任务的既有及并发新增 dirty 路径仅记录状态，未写入。本报告也经空白检查；未跟踪文档另按文本检查，不把 `git diff --check` 对未跟踪文件的空输出当成完整文档验证。调查结论可直接支持后续范围决策，但不能替代实施后的模型实际收到的 prompt、compaction checkpoint 与缓存数据验收。
