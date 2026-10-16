# Subagent 每操作独立工具与操作引导迁移实施计划

> 给执行 agent：逐任务执行，使用复选框记录实际结果。父层编写/首轮审阅/修订不等于任意扩展实施授权；用户已要求后续实施使用Subagent，当前closeout由父Inline收尾。首轮review后父层Inline修订并交用户确认执行方式，不自动循环review。

**执行授权：** 用户已明确“审一轮足够，执行吧”，选择Subagent-Driven；不再追加review，验收后由父精确commit、不push。S0已派发，S1/S2/S3按合同ready后并行，S4等待gate G2/C3真实发布。

**目标：** 按用户“全部拆开，每个操作独立工具”方向迁移当前main工具面；操作参数和前提归tool旁文本，治理/授权/恢复决策留MD。解决本仓拥有的错误workspace处置引导，不改上游消息来迎合展示。

**架构：** 新工具只是唯一typed dispatcher、workspace service、supervisor adapter/control-plane的薄操作入口。旧union不再向模型注册；旧内部factory可保留供兼容测试/实现复用，但不形成第二执行权威。既有历史toolCall和上游通知原文保持，不为名称迁移重写session/raw。

**技术栈：** Node>=22.19.0原生TS、Pi1.0.4、pi-subagents0.75.0、手写JSON Schema、Node test、真实SDK fake Host/adapter、中文文档。

## 1. 冻结范围和约束

- 上游/node_modules/vendor/fork/依赖patch不可修改，不升级依赖；禁止MCP。
- 所有精简/换行仅renderer；本计划明确授权自有模型操作说明迁移，但不改既有上游raw通知、event、session正文、structured details来显示或兼容旧名称。
- main-only/model-only、child early-return、ceiling、frontmatter权限、API guard、owner/CAS/action_token、terminal proof保持；不能用schema/description代替runtime guard。
- 不读真实settings/models/auth/credential/session/authority/state，外部models备份不读不动；只读仓库源码与自造fixture。
- 默认不用TDD/RED/相关skill；实现后补合同测试。文档和新增注释中文。
- 不stash/reset/clean/raw管理managed workspace；执行方式确认时一并确认本计划逐验收单元精确commit，父统一索引，child不擅自stage；不push。
- 本计划npm全程offline且只官方https://registry.npmjs.org/；缓存不足停报，不自行联网。用户已在当前对话澄清授权closeout N1官方源联网补缓存，该授权属于父层收尾而非本计划资源；不自动安装/调用真实provider/Host/kill/通知。
- 不新增loader、guide工具、恢复引擎、全局工具搜索策略、token计费实验；只记录UTF8 schema/description字节，不声称token下降或模型选择更准。
- 不扩大到child integration八action、contact_supervisor reason枚举、scheduler/memory/bash工具拆分。resume(model)、idle、triggerTurn、scheduler并发、Goal、旧hb清理不实施。
- prompt override的三个精确白名单与真实guidelines preservation tests继续有效；不新开完整替换入口。

## 2. 接口和迁移决策

### 2.1 新工具目录（main注册，单object顶层，additionalProperties=false）

| 工具 | 参数 | 唯一执行入口 |
| --- | --- | --- |
| subagent_roster | {} | 既有list admission/content frontmatter |
| subagent_start | agent/task必填，保留既有启动字段；writePaths存在时acceptance.criteria必填 | 既有executeCoding/executeGeneric，不收action/control字段 |
| subagent_run_status | 保留该操作当前支持的定位/输出字段 | 既有executeControl固定action=status |
| subagent_run_steer | 目标定位、非空message、可选index | 既有executeControl固定action=steer，消费gate新合同 |
| subagent_run_interrupt | 当前允许的目标定位、index | 同上interrupt |
| subagent_run_resume | 当前允许的目标定位、index、非空message、output（string或false）、outputMode（仅file-only）；不暴露model换模 | 同上resume |
| subagent_run_stop | 当前允许的目标定位、index | 同上stop |
| managed_workspace_list | {} | createSubagentWorkspaceTool唯一execute固定list |
| managed_workspace_status | workspace_id | 同上status，保留实时token/allowed事实 |
| managed_workspace_dispose | workspace_id/disposition/action_token，可选strategy仅integrate | 同上dispose，child-owned门禁不变 |
| managed_workspace_release | workspace_id | 同上release，非dispose续步 |
| supervisor_request_pending | {} | 既有controlledSupervisorAdapter固定pending |
| supervisor_request_status | 只保留该操作当前支持的to/replyTo等精确字段 | 同上status，D2/D3诊断保留 |
| supervisor_request_reply | replyTo/message必填，to如现支持则保留 | 同上reply，串行/commit/compensate不变 |

以上14项；supervisor gate计划拟新增的subagent_supervisor_inspect/clear在其实现并发布后作为独立工具原名保留，届时总计16，不重复拆分。目前该兄弟计划仅B完成，G2/C3尚未实现。规范顺序为gate先行；S0记录未发布时向父报告S4依赖，父继续推进已授权gate DAG，不静默挂起；若gate出现无法推进的实际阻塞，则由用户决定继续等待或将S4缩为14工具，不自主取消依赖。状态/定位字段的逐项真实支持由S0读代码冻结，不将研究中“所有control共用canonicalSteerTarget”的建议当事实：现canonical resolver只对steer权威，其他operation不擅自收紧/扩展；无目标status若现可用则保留。schema根不使用union或allOf；启动条件必填保留原typed编译器权威。dispose的strategy仅integrate规则由既有runtime INVALID_WORKSPACE_STRATEGY裁决，schema不保留顶层allOf，也不新增未经验证的根if/then；这是明确的schema早拒降级而非runtime语义放宽，description说明条件，测试同时证明guard仍在。供应商兼容未知不凭fake断言真provider通过。

### 2.2 兼容与fresh Host

采用**模型注册硬切换**：fresh Host不注册旧subagent/subagent_worktree/subagent_supervisor，不双入口、不无限alias。旧factory导出如有公开消费者可继续存在但不注册，不删除兼容入口仅为代码好看。旧上游supervisor名字仍由membrane捕获并绑定（它不是新模型工具名），不能把拦截常量重命名成新工具。

上游完成/决策通知仍会出现旧调用示例，禁止重写其raw文本。新GLOBAL短索引必须给一次精确旧→新操作映射，明确旧通知例子不构成新schema；本仓自有spawn/reminder可改为新工具名和正确owner边界。历史renderer同时识别旧名、新名；旧session只能渲染历史，不能声称旧调用可继续执行。发布必须fresh Host，不热改当前任务使用的工具注册，用户若需要旧客户端执行兼容则停止回报并重新裁决，不偷加alias。

### 2.3 引导归属

- GLOBAL保留默认委派/Inline选择、计划与review授权、角色分级、模型异常恢复顺序、30min组织预算、dirty/managed workspace规则、停止条件；只把逐操作参数/状态长表下移到tool描述。保留跨工具status权威与旧新名映射。
- SHARED/root/package工程安全政策不迁移，不声称tool文字是强制。
- 每tool description首句明确对象、必填、权威；resume明确新run/非原进程续跑/stopped不可resume；reply明确提交≠消费；workspace dispose明确coding child-owned而generic以状态权威为准。
- workspaceNotice和completion reminder无条件“integrate or discard”改为“查询managed_workspace_status，按实时允许动作；coding由child自主集成”。不动原receipt/details字段和提醒发送/去重。
- reviewer缺contact_supervisor不加权限；child boundary文字在缺工具时要求输出阻塞事实结束任务，不指示调用不可用工具。固定采用保守文案“可用时contact_supervisor，否则报告阻塞并停止”，不读取profile或假设事件提供工具白名单。记录该条件化文字与SHARED/GLOBAL镜像的刻意差异及agents-shared owner同步责任；不改SHARED政策或给reviewer加权限。
- bash_async最新引导已独立提交，不按旧研究回退sleep说明；只可另修clear_queue“Host/RPC操作、非本工具参数”的歧义，保留合法retry/backoff/测试延迟/用户delay。
- 不修改外部skills或TDD类skill。writing-plans/writing-skills的历史TDD冲突只登记，另案需要用户明确scope，不能为本工具迁移加载被禁TDD技能。

## 3. 文件结构

- Create `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`：start/roster/run操作schema/metadata与薄factory。
- Create `packages/pi-subagents-enhanced/src/workspace/operation-tools.ts`：workspace四操作薄factory，复用tool.ts执行。
- Create `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts`：三操作薄factory。
- Modify `.../subagent-dispatch/extension.ts`：将原执行闭包传给factory，唯一注册点换新名，自有spawn文案。
- Modify `.../workspace/completion-reminder.ts`：更正本仓自有提示。
- Modify `.../tui/tool-renderers.ts`、`.../tui/compact-rendering.ts`：新名显示兼容/共享renderer，不改raw。
- Modify `src/agents-shared/index.ts`、`pi/AGENTS_GLOBAL.md`、`src/bash-async/index.ts`：仅§2.3明确文本范围；不新增prompt override。
- Create `test/subagent-operation-tools.test.mjs`、`test/workspace-operation-tools.test.mjs`、`test/supervisor-operation-tools.test.mjs`、`test/operation-guidance-contract.test.mjs`；Modify明确受影响现有测试（S0列白名单）。
- Create `docs/plans/records/2026-10-16-operation-tools/{contract,acceptance}.md`、`docs/architecture/subagent-operation-tools.md`；README/TODO仅新入口与迁移边界，不改旧计划/旧取证。

## 4. DAG / Waves / Resources

```text
S0 当前操作/调用者合同
├─ S1 start/roster/run factory ─┐
├─ S2 workspace factory ──────┼─ S4 唯一注册/历史renderer ── S5 guidance迁移 ── S6验收交付
└─ S3 supervisor factory ────┘
Supervisor G2/C3发布前置条件 ────┘（目前未实现；发布后S4消费其接口，不能覆盖新gate/clear）
```

- Wave0 S0；Wave1 S1/S2/S3可并行（disjoint新文件，不跑共享unit）；Wave2 S4；Wave3 S5；Wave4 S6。
- 关键路径S0→S1/2/3→S4→S5→S6；只在S4合流，因为实际改唯一注册/消费既有入口。
- `unit-runner=1`，父统一分配；`git-index=1`由父提交。无visible-host/network/kill资源。S1/2/3可在当前tree独立新文件，避免worktree基线不含未完成依赖。同文件冲突按真实产物依赖，不把Wave作为屏障。

## 5. 任务合同

通用停止条件：越WritePaths、真实敏感数据、需上游改动、接口/数据来源未证、标准互斥、权限或兼容产品决策不能满足则停报，不吞错/fallback/宽化schema。coding任务每项验收后父精确commit；child不自占索引。

### S0：冻结现有每操作字段与调用者

**Deps：** none。**WritePaths：** `docs/plans/records/2026-10-16-operation-tools/contract.md`。**Resources：** static-evidence。
**接口：** Produces精确14工具schema字段、旧新名映射、测试和自有活跃调用者白名单、字节基线，供S1–S5消费。
- [ ] 读现extension executeControl/status/resume/steer、workspace/tool、supervisor adapter/native公共接口；明确status目标可选、to/replyTo字段实际用途、schema不保证执行层支持的字段。
- [ ] 单脚本列自有active src/pi/测试/非TDD skill引用，旧历史docs仅登记不改；拒绝宽扫用户skills/state。
- [ ] 记录三个原schema/description UTF8字节、当前注册名、membrane upstream捕获名；不token估算。明确extension.ts deactivateSupervisorTool及session_start未bind调用点、新三supervisor工具停用集合；compact-rendering旧工具校验错误正则和tool-renderers历史名映射一并冻结。
- [ ] 读supervisor G0/G2/C3产物是否已发布；未ready只挡S4，不挡S1–S3 factory。
**验收：** 每工具required/optional/不支持字段有真实file:function证据；新增兼容需求停报父，不猜测。

### S1：start/roster/run七工具factory

**Deps：** S0（已44806d1提交：start不暴露context，resume保留既有output/outputMode）。**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`、`test/subagent-operation-tools.test.mjs`。**Resources：** unit-runner仅验收。
**接口：** `createSubagentOperationTools({executeStart,executeControl,renderCall,renderResult}):ToolDefinition[]`；单factory无新状态/定时器。
- [ ] 七个main/model-only定义，start必填agent/task，control固定action通过唯一回调；不透传调用方action覆盖固定action。
- [ ] 保留typed compiler/error keypath/model准入/raw返回；运行入口仍对无schema调用fail closed，字段串线不发spawn/control。
- [ ] 实现后补七工具schema与真实callback spy、空参数/缺message/跨面字段/raw引用不变测试。
- [ ] `node --test test/subagent-operation-tools.test.mjs`、package typecheck、diffcheck。
**禁止：** 不改模型选择、resume(model)行为、status参数语义、required-child注册。

### S2：workspace四工具factory

**Deps：** S0。**WritePaths：** `packages/pi-subagents-enhanced/src/workspace/operation-tools.ts`、`test/workspace-operation-tools.test.mjs`。**Resources：** unit-runner仅验收。
**接口：** `createWorkspaceOperationTools({service,resolveRootSessionId,renderCall,renderResult})`，内部复用现createSubagentWorkspaceTool唯一execute，不copy service逻辑。
- [ ] 四单object schema；dispose策略约束在runtime也验证；不得模型填写owner kind/root。
- [ ] 实现后通过真实service公开fixture测status token、owner/CAS、child-owned拒绝、released终态与preserved/cleanup-debt release；纯schema负例不当production可达依据。
- [ ] `node --test test/workspace-operation-tools.test.mjs test/subagent-workspace-tool.test.mjs`、package typecheck、diffcheck。

### S3：supervisor三工具factory

**Deps：** S0。**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts`、`test/supervisor-operation-tools.test.mjs`。**Resources：** unit-runner仅验收。
**接口：** `createSupervisorOperationTools(adapter,renderers)`，固定pending/status/reply动作，不自己持receipt/queue。
- [ ] 严格required与字段，保留D3诊断、native content、isError、reply串行/补偿路径，不新增第二observer。
- [ ] 实现后测bind未就绪/唯一bind、固定action不可覆盖、replyTo/message必填、未知字段、raw引用；inspect/clear仍由gate计划工具注册，不能重复创建。
- [ ] `node --test test/supervisor-operation-tools.test.mjs test/subagent-supervisor-adapter.test.mjs`、package typecheck、diffcheck。

### S4：唯一注册切换与历史显示

**Deps：** S1/S2/S3、supervisor计划G2/C3发布（阻塞时不开始写extension）。**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/tui/tool-renderers.ts`、`packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-compact-rendering.test.mjs`、`test/joint-upgrade-model-only.test.mjs`、`test/subagent-dispatch-rpc.test.mjs`、`test/subagent-dispatch-extension.test.ts`；S0发现额外fixture先报父修订精确WritePaths，不将目录发现当任意写授权。**Resources：** unit-runner。
**接口：** registered模型工具14+gate2，旧三名零注册；membrane捕获上游旧名不变。executeStart/Control仍同闭包和owner state。
- [ ] 注册改按新factory名，按name查找而非tools数组位置；ctx/current Host不热重载，不改历史session工具名。deactivateSupervisorTool同步停用新三supervisor工具，未bind时不留active声明，inspect/clear仍遵守gate的可用性策略。
- [ ] renderer新旧名都可显示，新名按工具名映射固定operation，不能再依赖模型args.action；compact-rendering校验失败正则覆盖新旧名，workspace共享已有文本/组件能力，不改模型raw；模型参数展示不冒充权限。gate C3的“旧单工具还可用”仅适用于gate阶段，S4发布后由新工具等价公开链验收取代，保留旧历史测试证据不覆写。
- [ ] 更新真实SDK fake Host调用者，不批量替换历史docs；所有被改测试路径须来自S0，额外路径先报父。
- [ ] `node --test test/subagent-runtime-membrane.test.mjs test/subagent-compact-rendering.test.mjs test/joint-upgrade-model-only.test.mjs test/subagent-dispatch-rpc.test.mjs`；若真实integration未获资源则记录未跑，不偷偷启Host。
- [ ] package/root typecheck、diffcheck，child注册0与main tools集合逐项验证；无旧union并存。

### S5：操作说明/MD单源迁移

**Deps：** S4。**WritePaths：** `pi/AGENTS_GLOBAL.md`、`src/agents-shared/index.ts`、`src/bash-async/index.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`、三个operation-tools.ts（仅description）、`test/operation-guidance-contract.test.mjs`、`test/subagent-workspace-completion-reminder.test.mjs`、`test/bash-async.test.mjs`、`test/system-prompt-override-policy.test.mjs`（仅新扫描site必要的显式审计，不扩白名单）。**Resources：** unit-runner。
- [ ] 按§2.3下移操作说明，保留GLOBAL全部治理/授权/恢复决策；映射旧通知到新工具但不改raw上游；不动SHARED/root政策。
- [ ] 修本仓spawn/reminder绝对integrate误导；保留可用性/一次性token/queued≠consumed前提；child边界缺工具不再强制调用不存在工具，不加reviewer权限。
- [ ] clear_queue限定Host/RPC非工具参数；不回退已验收bash_async反等待与delay例外合同。
- [ ] 实现后补description/MD映射、真实GLOBAL/SHARED handler guidelines保留、不可用contact指引、raw/details未改合同。
- [ ] `node --test test/operation-guidance-contract.test.mjs test/subagent-workspace-completion-reminder.test.mjs test/bash-async.test.mjs test/system-prompt-override-policy.test.mjs`、root/package typecheck、diffcheck。

### S6：聚焦验证与文档交付

**Deps：** S5。**WritePaths：** `docs/plans/records/2026-10-16-operation-tools/acceptance.md`、`docs/architecture/subagent-operation-tools.md`、`README.md`、`packages/pi-subagents-enhanced/README.md`、`docs/todos/2026-10-10-runtime-followups.md`。**Resources：** unit-runner、git-index父独占提交。
- [ ] 显式运行S1/S2/S3/S4/S5全部合同测试及已完成supervisor gate验收；不运行全仓npmtest，不调用用户真实管理工具。
- [ ] root/package types、offline verify、diffcheck/引用路径审计；前后schema/description UTF8字节报告，不估算模型收益。
- [ ] 用户部署指引fresh Host、旧名字不再模型注册、上游旧通知映射、child tools不扩权；未测provider/实机兼容记unknown。TODO只新增operation-tools状态，不改动或勾销closeout N1/P3/L3与其他后续条目。
- [ ] 每项commit与真实exit/数量/skip入账；无自动成果review/无push。
