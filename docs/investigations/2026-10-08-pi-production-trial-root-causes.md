# Pi 联合升级实际试用：七项问题根因分析

## 结论与证据边界

历史调查阶段为只读排查，未修改 production、配置或上游，未重载/终止用户会话；该句保留为当时事实。后续 F1–F5 已实现，本次仅做文档收尾与一次最低 Node 三文件聚焦验证，未执行 full matrix、长 integration 或真实模型 canary。利用公开代码、三个限定子任务、真实运行记录的非敏感字段投影以及秒级合成 characterization 核对入口。

| 问题 | 根因确定度 | 来源分类 | 当前状态 |
|---|---|---|---|
| T1 available agents 为空 | 已证实 | 1：合法 repository admission 未被正确处理 | implemented / F6 focused accepted |
| T2 reviewer 省略 model 未选择首位 Astra | 有序候选丢失链已证实，真实 runner 选 Sol 已证实；当次 Astra 可用性快照缺失 | 1：合法 profile 默认选择未正确传入 launch | implemented / F6 focused accepted |
| T3 supervisor 到达主 agent 但 TUI 未显示 | 用户后续认为误报并观察到subagent中可显示；普通interactive路径可显示 | 未证明生产显示缺陷 | 暂关闭，移出修复范围 |
| T4 completion 触发主 agent 但 TUI 未显示 | 已证实 | 1：原生隐藏成功通知策略与本仓可见性需求不匹配 | implemented / F6 focused accepted |
| T5 回合中断且具体错误被隐藏 | 回合错误与显示缺陷已证实；更底层断流不再属本轮范围 | 显示缺陷为1 | implemented / F6 focused accepted; display-only, upstream out of scope |
| T6 Option+O 历史同一会话重复 | root facade 与 actual leaf 重复投影已证实 | 1：合法 root/leaf 数据未正确形成显示 roster | implemented / F6 focused accepted |
| T7 MCP/codemode 替代警告 | 本仓有意替代与builtin资源选择不匹配已定位 | 1：本仓初始化/部署配置遗漏 | implemented / F6 focused accepted |

**用户最新边界：**已授权将 T1、T2、T4、T5、T6、T7 统一编写修复计划；只写计划、不实施、不新增修复测试。T3 用户认为可能误报，暂关闭不修。T5 仅包含 TUI 错误可见性，不再继续追查上游断流。

**纯文档 TDD 豁免：**本文仅记录分析。characterization 辅助脚本位于 `/tmp`，不注入 production hooks、不改变消息与事件。不以静态检查或合成验证替代现场归因。

## T1：公开 list 消费了错误的 agent 形状

### 入口与权威数据

`subagent({action:"list"})` 是公开 typed 工具。production runtime 的 `afterBootstrap` 从 `<PI_CODING_AGENT_DIR>/agents/{delegate,executor,reviewer}.md` 生成 repository admission，然后将其 discover 函数注入 typed extension。

### 调用链及首个偏离点

1. `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:278–289,367–388` 安装 admission。
2. `src/compat/pi-subagents-0.75.ts:46–72,80–96` 产生 `name/description/systemPrompt/models/thinking`，**没有 filePath/tools**。
3. `src/subagent-dispatch/extension.ts:1175–1186` 的 list 消费仍要求 `a.filePath`，同时按路径字符串包含 `.agents` 过滤。
4. 三个合法配置条目的 `filePath` 都是 undefined，全部被丢弃，返回成功的空名单。

首个用户可见偏离点是 `extension.ts:1180`，不是 agent 文件不存在、模型不可用或 RPC 不健康。仓库 admission 准入与上游目录发现对象发生了契约错配。

### 复现与最小修复方向

- 实际公开 list 已返回空。
- 秒级合成 characterization 将真实 profile admission 接到真实 typed tool，结果 `admitted:[delegate,executor,reviewer]`、`listed:[]`。不启动 child、不访问真实 registry。
- list 应消费可信 admission roster，不为满足过滤伪造 filePath。其他来源应独立判定可见性/准入，不以路径字符串充当安全规则。
- tools/models 候选元数据若展示，需由权威 profile 提供；不能把候选首项写成实际 child model。

## T2：profile 有序 candidates 在省略 model 时被丢弃

### 配置与实际证据

`pi/agents/reviewer.md` 首项是 `codex-pool/gpt-6-astra`，次项 `openai-codex/gpt-6-astra`，之后是 Sol/GLM。

非敏感 runtime projection 已发现多次真实 reviewer 请求未指定 model，响应 `modelSelection.source:default`，对应 runner step 实际为 `codex-pool/gpt-6.1-sol:xhigh`。例如目标目录 `new-api-account-pool` 的 run `4bef2a32-0b39-46c3-9edf-d2cebf92ee13`。

本轮显式指定 Astra 的 reviewer run 也确实记录 `codex-pool/gpt-6-astra:xhigh`，说明该调用时点可使用此模型；**不能倒推出每个历史默认派发当时的 getAvailable 快照**。

### 完整链与首个偏离点

1. generic/coding 调用 `extension.ts:1013/798 → resolveSpawnModel`。
2. `model-selection.ts:104–126` 按声明顺序与当次 registry 求交，拒 blocked provider 与非法 API，返回当前可用 candidates。
3. `extension.ts:564`：`if (!requestedModel) return {source:"default"}`；刚计算的 candidates 未写入 selection.model。
4. generic/coding 的 `selectedInput/selectedIr` 保持无 model；workflow builder 仅在有值时加入 leaf.model。
5. `workflow-spawn.ts:89–104` 生成 `runs.run(key,{agent:"reviewer",...,async:true})`，无 model。
6. upstream 0.75 RPC 将公开 script 交给 workflow executor；其 `agents.js:2062` 只消费 frontmatter.model，不消费本仓的 models 数组。
7. upstream `model-resolution.js:285–320` 按 per-run/role override/agent.model/default/parent 路由，生成单个 step.model。
8. runner 用该 step.model 构造 child launch，最终 `child-session.js:413–423 → resolveCliModel → createAgentSession({model})`。

首个偏离是本仓 `extension.ts:564`。不能把“验证过候选”当成“实际传入候选”，也不能假设上游仍实现有序 fallback。

### 修复方向

省略 model 且有 profile 声明时，本仓在启动前解析首个可用 candidate，并明确传入 generic/coding leaf 的 qualified model；无 profile 声明才保留默认继承。显式 model 规则不变。

这不是 provider 请求失败后的自动重试/切换模型，不能静默恢复上游已经移除的那种 fallback。精确测试需断言实际生成的 leaf.model，并覆盖 registry 顺序与 profile 顺序相反、首位缺失、全缺失零副作用；不能只断言 modelSelection。

## T3：supervisor 的现场未显示尚未归因

### 已证 facts

- 原生 `native-supervisor-channel.js:698–716` 发送 `customType:subagent_supervisor_request`、`display:true`、字符串 content 和完整 requestBody/details，并触发主 turn。
- 本仓 `subagent-runtime.ts:547` 注册同 customType renderer，renderer 会生成请求框，不是空实现。
- 相关真实 session metadata 中，need_decision request 是 `display:true`，requestBody 有值，content 是 string，title 可有。
- 秒级真实 `AgentSession + InteractiveMode + 本仓 renderer` characterization 对 `triggerTurn:true` 的同型合成消息，观察到 message_start/message_end；`chatContainer.render(100)` 确实包含请求箭头与正文。

### 普通链

`native request → sendMessage → AgentSession.sendCustomMessage → message_start → InteractiveMode.handleEvent:2782 → addMessageToChat:3109 → display gate → CustomMessageComponent → 本仓 renderer`。

这里不能套用 T4 的 display:false 根因。已有真实成功消费证据也不等于实际屏幕可见。

### 仍缺的现场证据

用户发生未显示的具体 session/PID、时间和当时 Host 版本、是否处于 child overlay/历史滚动位置，以及该时点 TUI 是否收到 message_start、renderer 是否运行、ANSI 输出是否含正文。目前没有该时点终端 capture。

调查期间没有证明首偏离点。用户最新观察到subagent中可显示并认为可能误报，故暂关闭、不纳入本轮修复；不翻写原消息 display、不重复发送模型消息、不新增 completion authority 或预防性兼容分支。

## T4：成功 async completion 被原生 display 策略隐藏

### 入口与链路

1. native async completion watcher 接受同 session/owner 的完成事实。
2. upstream `runs/background/notify.js:422–433` 构造 `subagent-notify`。
3. line 427 只有 foreground、非 completed 或 schedule-origin 通知才为 display:true。普通成功 async 为 **false**；triggerTurn 独立保留。
4. Host 仍将其传给模型并触发回合，但 `InteractiveMode.addMessageToChat:3110` 先过滤 `message.display`。
5. 本仓已经注册的 completion renderer因此根本不被调用。

现场持久化 projection 有多条成功通知 display:false，短真实 InteractiveMode characterization 也同时证明“message_start/end到达”与“completion行未显示”。footer由独立 async lifecycle 更新，所以其消失不代表通知可见。

### 修复边界

需要独立显示层投影，保留原始 custom message、内容、display、details、模型消费与一次触发事实。不得通过复制模型消息或改底层消息来提升显示；不得把 workflow dispatch-complete 当实际 child-complete。显示投影需有明确去重与 session 生命周期，不创建第二权威。

## T5：流读取错误终止回合，折叠 renderer 隐藏具体错误

### 现场

- cwd `~/new-api-account-pool/`。
- 最新对应主session错误：`2026-10-08T08:46:32.706Z`（本机16:46:32），entry `1614d65a`。
- `provider:codex-pool`、`model:gpt-6.1-sol`、`api:openai-completions`。
- `stopReason:error`、`errorMessage:Upstream response stream was interrupted`。
- content只有一项 bash toolCall，没有 assistant text/thinking。
- PID27121仍存活，启动于本机14:04:42，早于此次主仓升级安装；加载的native TUI来自旧global0.87.1树。不能将其当成fresh1.0.2进程崩溃。
- 常规agent目录没有crashes.json；absence单独不证明未crash，但与存活进程/正常持久化assistant error/提示生成代码共同支持“回合失败”。

### 两层问题

**第一层：回合为什么结束。**

OpenAI-completions adapter将流异常规范化为 assistant error，保留已有toolCall部分；session 持久化该错误，结束本次turn。`isRetryableAssistantError` 在两版Host均将此文本判为false，因此不是自动retry链。仅出现 `/bug` 通用提示不意味着uncaughtException或进程退出。

目标仓库 `sub2api/backend/internal/service/openai_stream_read_error.go:85` 含完全相同的客户端标准文本；它将非HTTP/2特殊签名的上游read error映射为`upstream_stream_read_error`。这是强代码来源线索，但尚未拿到该请求的request ID、SSE error code与server底层cause，不能据此断言reset/代理/账户/节点故障或确认当次请求经过该checkout版本。

**第二层：为什么TUI没有显示实际错误。**

1. Host `AssistantMessageComponent.updateContent:136–154` 检测到toolCall，跳过自身errorMessage展示，假设工具卡片负责。
2. InteractiveMode对pending tool调用`updateResult({content:[errorText],isError:true})`。
3. 本仓 `src/compact-tools/renderer.ts:59–68` 折叠态无论错误与否，都只保存summary并返回空Text；bash summary为行数。
4. 工具call只显示`bash ... · 1 lines`，具体错误消失；Host的`maybeSuggestBugReport:1649–1654`仍加通用提示。

使用真实installed AssistantMessageComponent和本仓bash renderer，合成toolCall-only error输入，两版0.87.1/1.0.2均得到`assistantLines:[]`、`collapsedResultLines:[]`、`errorTextVisible:false`。因此错误隐藏是Host与本仓compact renderer的组合缺陷，且不局限于升级新增行为。

### 最小修复方向

compact renderer从Host render context的isError读取错误事实，在折叠态也保留明确错误标记与具体错误文本；不能依赖result.isError（Host可能仅传content/details给renderResult），不能改写实际tool result。展开保留完整内容。底层provider read失败另行按request-correlated日志调查，不靠增加自动retry掩盖。

## T6：workflow root facade 与实际 leaf 被投影为两个历史会话

### 现场身份与可达性

用户在 Option+O 历史中看到 `只读追踪Pi中断bug提示路径 (reviewer)` 与 `typed-97eb2b33-3ff1-4f66-aa3e-c882c3c0c143 (reviewer)`。不仅标题/内容相似，权威 status 也证实关系：

- workflow root：`090dbe7b-6297-4e8d-8038-d5f08d8a99d4`。
- root step.runId / actual leaf：`561947fe-69f0-457a-932a-035fe873ef9e`。
- leaf.parentWorkflowRunId 与 root 完全一致，workflowKey 与 `typed-97eb2b33-3ff1-4f66-aa3e-c882c3c0c143` 一致。
- root step 与 leaf step 的 canonical sessionFile 完全一致（路径 digest 均为 `4aa2baac8fbf7172f0bcdfe9f53fc3cac8dec617df678b21cf5258da16379e2d`）。仅读取身份/status，没有读取或比较两份会话正文。

该数据来自真实 public typed workflow 派发及官方 async runner，不是手工拼 projection/event。

### 完整生成链与首偏离点

1. 上游 `subagent-executor.js:5134` 发布 workflow root 的 async-started。
2. `async-execution.js:1986` 发布实际 single child 的 async-started，含独立 id、parentWorkflowRunId 和 workflowKey。
3. root step 保留 runId 映射并写入实际 child sessionFile（executor:5446–5456,5622–5634；workflow-settlement:28–34,58–78）。这两个生命周期实体是合法事实，不应删除上游事件。
4. 本仓 `custom-footer.ts:435–442` 都转给 browser.trackStarted，轮询按两种 runId 分别读 status。
5. `session-browser.ts:196–228` 仅按 event.id 建 Map，构造 `${id}:${index}`，不保存 parentWorkflowRunId/workflowKey。因此调度 root 与实际 leaf 分别存在。
6. `reconcileRun:242–280` 保留 root-keyed BrowserChild、复制 root step.sessionFile，却不消费 step.runId 进行关系折叠；邻接 leaf 读取只补 model/thinking/tokens。
7. `children/recentChildren:359–373` 平铺两个 run；serialize/hydrate按不同 runId保留两条。
8. footer 为 leaf显示业务title，为root step显示typed标签；renderSelected按二者相同的 sessionFile加载同一conversation。

首偏离发生在 browser 的显示身份投影，**不是发生了两个相同 reviewer 执行，也不是凭会话文本相似才能判断重复**。

### 统一计划中的修复边界

只修改 renderer roster：保留明确 root-step→leafRunId 关系，在 canonical leaf 已存在且关系已确认时折叠对应 facade step；不要删除整个 multi-step workflow，不按标题/文本或仅sessionFile相等去重。映射随 roster 持久化，选中被折叠项时迁移到canonical leaf；未确认或leaf未出现时不猜测。事件、authority、消息与session均不改。

后续短测试覆盖两种事件到达顺序、终局历史、hydrate、选中项迁移，及无关同标题、多leaf、未知映射反例。本轮只分析，未新增这些测试。

## T7：有意替代 MCP/codemode，却仍将默认 builtin 送入冲突检测

用户新建和继续会话均收到 builtin:codemode/builtin:mcp 被本仓 policy entry 替代的诊断。

### 生成链

1. `pi/extensions/mcp-policy.ts` 将Host API绑定到根feature `src/mcp-policy/index.ts`。
2. feature:72–74 在同一owner中调用 `createCodemodeExtension({mode:'on',models:false})`，并调用官方MCP factory但只加载自有allowlist连接定义；注册tool codemode和command /mcp。
3. `pi/settings.template.json:26–29` 仅明确排除tool-search与llama.cpp，没有排除codemode/mcp的默认builtin。
4. 本机 agent-directory settings 的非敏感字段投影也未配置这两个排除；没有读取/输出credentials/models或其他敏感设置。此投影不代表所有项目/CLI覆盖，统一计划必须同时核对有效资源选择与覆盖优先级。
5. Host builtin codemode/mcp是replaceable。`resource-loader.js:72–100` 发现nonreplaceable policy owner的相同tool/command后移除默认builtin，并在其path产生replacement warning；实际factory retained的是本仓policy入口。
6. InteractiveMode加载资源诊断:1438–1454 将warning显示在 `[Extension issues]`。另一路启动warning也消费同一diagnostic，故两处文本不能当成双连接证据。

### 判断与修复边界

Host替代检测本身为预期行为，官方MCP文档也明确支持第三方 `/mcp` 替代；**本仓有意替代却没有在资源配置明确唯一owner，是部署/配置bug**。不能根据提示删除policy恢复全局/project未知MCP，不能通过TUI静默过滤warning来冒充正常。

公开settings支持 `extensions:["-builtin:mcp","-builtin:codemode"]`，只排除默认builtin，不影响policy入口注册的工具。统一计划应纳入template、ensureSettings增量与本机资源选择，并保持enabledModels等机器专用字段。还需验证fresh/new/resume加载时错误与warning为空、工具/command owner唯一、policy连接/工具限制不变。当前只分析，未改配置。

## 证据与执行记录

F6 当前权威 evidence arena：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou/evidence/`。

- `trial-roster-model-characterization.json`：真实profile/admission→typed公开工具，名单清空与leaf model丢失。
- `trial-model-selection-projection.json`：真实请求model字段与相同run的runner step.model；无任务正文。
- `trial-display-projection.json`：主session消息display/type/时间字段，无请求/结果正文。
- `trial-session-error-projection.json`：目标cwd的error字段与最后entry类型，无对话正文。
- `trial-crash-projection.json`：常规crash路径存在性，无crash record。
- `trial-custom-tui-characterization.json`：实际interactive consumer，supervisor正向可见、hidden completion不可见。
- `trial-render-characterization.jsonl`：两版实际assistant组件与compact bash错误文字不可见。

独立T1/T2 reviewer run `676568a9-19be-4176-af53-f67ebdfc57d8` 已完成并与主agent结论一致。T5 reviewer run `561947fe-69f0-457a-932a-035fe873ef9e` 已完成，对照global0.87.1/root1.0.2后确认回合error与隐藏文本组合链，未将提示误判为进程crash。TUI reviewer `069f8f22-7be5-4b80-bc72-f4f6f641fd8c` 因同样的`Upstream response stream was interrupted`失败，没有将其失败冒充分析结论。限定executor `cdc62175-7804-4ed7-992d-11a56bf763a2` 已完成：在本仓footer/overlay/renderer接线中没有找到清除主chat请求的逻辑，仍需现场event/terminal时序。其报告称Host源码不可读，属于该子任务读取边界问题；主agent已从正确绝对安装路径完整读取Host消费者并完成真实InteractiveMode characterization，不能把这句话当成源码不存在或Host缺陷证据。

T6 executor run `b0d2a921-7064-414e-91bd-2644b54213c8` 已完成并确认上述源码生成链；子任务未读取现场，主agent的 `trial-duplicate-browser-projection.json` 补齐真实 root/leaf/sessionFile 相等证据。

T7 executor run `8ea3c425-8b7a-44cf-abbf-666b55772cbd` 已完成，独立确认 template 缺少 builtin 排除、ensureSettings 不会推导排除以及 Host 的 replaceable 机制。默认 builtin 的 factory 注册阶段可能已经执行，但最终集合在 session_start 前移除；MCP 连接归 session_start，因此不能将 warning 解读为双连接。子任务未读取本机 settings；主agent只投影 agent-directory 非敏感资源字段，project/CLI有效覆盖仍留给统一计划核对。子任务初始宽范围检索意外匹配了历史 child artifact 片段但未打开文件，后续已收窄公开源码路径；该片段未作为任何归因证据。

本报告不把既有全量 GREEN 冒充本轮验收。F1–F5 已完成实现。历史 current Node 8-file 集合为 **176/176 pass、0 fail、0 skipped、0 todo**；旧最低 Node 聚合的 51 是 **48 个实际 pattern cases + 3 个 old empty-file placeholders**，不能称新增三文件 51 cases。本轮最低 Node 仅无过滤运行三新增文件，实际 **57 actual new / 57 pass、0 fail、0 skipped、0 todo**。三新增文件无 pattern 过滤。T3 closed；T5 仅 display fixed，更底层 upstream stream 原因仍 out-of-scope。

F6 权威 arena 中的完整日志为 `f6-current-8files.log`、`f6-min-pattern.log`、`f6-min-new3files.log`/`.exit`、`f6-listFilesOnly.log`、`f6-current-root-noemit.log`、`f6-current-enhanced-noemit.log`、`f6-min-root-noemit.log`、`f6-min-enhanced-noemit.log`；首次环境误配诊断为 `f6-min-new3files-invalid-env-diagnostic.json`。F6 静态证据：root `tsc --listFilesOnly` 覆盖 **1418 source paths + 1 summary line**（1419 lines；不是 1419 个 paths），并实际包含 `pi/extensions/compact-tools.ts`、`scripts/ensure-pi-settings.ts`；静态检查共 5 次调用、4 个 unique Node/config 组合，current-root `--noEmit` 执行 2 次，其余组合一次，均退出 0。本轮不重跑 `--noEmit`。不把未命中 pattern 的 0 测试计为通过。真实原始消息、details、toolResult、structured/event/session 均由测试 deepEqual/持久化计数保护；completion 仅 notify，F4 仅 display roster，F5 owner 来自模板而非硬编码临时路径。首次环境误配属于手工 test 数据（分类 2），不是 production 缺陷；更正 root 后的 57/57 才是最低 Node 证据。

安全边界：没有真实模型/网络安装/fullmatrix/模型 paid canary/hotreload/user process 变更；不宣称旧 Host 自动获得修复，需 fresh Host 才生效。当前 settings 仅投影 extensions/defaultTools 及 builtin 四项排除状态，目标值已存在，未回写。F5 并行 r2c adapter/missing-adapter 处理属于外部变更，保留且记为 not ours；既有 dirty 与 index 均未清除。交付记录与 hash/log/summary 见 `docs/plans/records/2026-10-08-pi-trial-fixes/acceptance.md`。

统一修复计划保存于 `docs/plans/2026-10-08-pi-production-trial-fixes.md`；其 F6 checkbox 仍由 main inline 维护，本子任务不修改计划。
