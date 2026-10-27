# Subagent 名册初始化注入实现计划

> **给执行 agent：** 按本文 DAG、Deps、WritePaths 和 Resources 执行，以复选框记录步骤。只有 F1–F7 全部取得当前版本的证据，才算实现完成；否则在已授权范围内持续修复与验证。用户已选择 Subagent-Driven，按本节末尾的执行记录接续，不自动授予新增测试或发布权限。

**目标：** 当前 session 初始化时，从既有 admission 生成一次可选 subagent 名册，将其稳定注入模型系统提示，取消派发前调用 `subagent_roster` 的流程和该工具的模型注册。

**架构：** package 内复用现有 discovery/admission 回调创建 session/runtime 快照，通过 Pi 1.4 `before_agent_start` 的结构化 section 持续声明。GLOBAL/SHARED 迁为各自独立 section，使名册不被完整 system prompt override 遮蔽；真实派发的准入、选模、授权和资源管理保持当前权威路径。

**技术栈：** Node.js `>=22.19.0`、TypeScript `7.0.2`、Pi 四核心 `1.4.0`、`pi-subagents-enhanced@0.1.0`、upstream `pi-subagents@0.80.0`；不新增依赖。

**基线：** 2026-10-27，初始 HEAD `8bc4a88f43550c342fbe3318ca295e93f3eb850c`。当前存在用户 Playwright/writing-plans 改动、resume 接线与字段诊断修复、详情初始选择修复及未跟踪计划/报告；实施前记录实际 HEAD 和相关 diff，不提交或覆盖这些现场。

**调查依据：** `docs/investigations/2026-10-27-subagent-roster-injection.md`。这是独立于 Goal Runtime 的交付计划，不依赖 Goal 实现，不将它并入 Goal 的 T1–T8，也不使用 Goal 编排本次建设。

## 全局约束

- 用户要求单独规划初始化注入；不再要求模型为了解可用角色先调用 roster。
- “初始化一次”指每个 session/runtime generation 生成一次快照；模型请求持续包含同一 section。不是进程第一次启动后永久缓存，也不是写一条会被摘要的普通消息。
- 名册只描述当前 admission 允许选择的角色。真实 `subagent_start` 仍执行既有 profile、registry、权限、cwd、RPC 和 workspace 检查；名册不构成授权。
- 初版只注入 canonical name、完整 description 和一条默认模型规则。不注入 models/tools/thinking 全量 frontmatter、profile 正文或任意 metadata；不因 role 名称增加工具/嵌套权限。
- 复用当前固定三 profile admission；不新增目录扫描、watcher、provider 查询、第二发现器、后台进程或持久化账本。profile 修改通过 reload 生效。
- 不放开原生 `subagent` union 注册，不启动第二套 upstream runtime，不修改 node_modules，不新增 upstream 私有 import 或 package export。
- GLOBAL 仍只作用于 main；SHARED 仍作用于 main/child，child execution boundaries、input 门禁与 required extension ACK 的语义必须保留。
- 结构化迁移只修改自有 prompt sections，不删除别人的 section，不清除其他 extension 设置的 forceSystemPrompt，不篡改 user/tool/session 历史。
- 无活动派发工具、admission 尚未就绪或快照失效时，撤回自有名册 section；不返回硬编码三角色作为 fallback，不把缺失名册当作放行依据。
- 保留默认省略 model、用户显式指定才传 model 的规则；初始化不自行选择或切换模型，也不读取本机 models/auth/凭据。
- 所有 production 实现使用 `.ts`，按领域落在已有 feature/package；不在 scripts/lib、宿主入口或通用 utils/common 中收容实现。
- 不新增测试、case 或 fixture，除非用户另行具体授权；现有合同改变所需的断言及 fixture 适配可以随实施修改。未取得必需的行为证据时明确阻塞，不能以默认 skip 宣布完成。
- 不默认 commit/push、发布、安装、修改本机 enabledModels 或热重载当前会话；受管 coding publication 遵守原 runtime 的 child-owned 集成规则。
- 运行单元测试时串行占用 `unit-runner`；真实 Host 验证与编码分开。npm 联网仅用 `https://registry.npmjs.org/`。

## 整体交付终态

一个 fresh Pi Host 的第一个模型请求已收到当前准入角色名册，模型能直接构造 `subagent_start` 合同。重复请求、compaction、reload 和 session 替换均不依赖 roster 工具，也不丢失 GLOBAL/SHARED 或扩大 child 权限。

| ID | 必须成立的条件 | 方法与环境 | 通过判据 | 证据位置 | 任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 第一个模型请求包含当前名册 | 实际 Pi Host/SDK 与既有 capture provider，读取实际首请求系统提示 | 有且只有一个 `advertised_subagents` section；条目与同代 admission 精确相符，未先调用 roster；并非人工拼 prompt | 最终报告中的 session/请求捕获引用 | C2、C3、C5 |
| F2 | 名册按生命周期更新且请求内稳定 | 同 session 两次请求、reload、new/resume、cwd 变化、两个 Host | 同代 catalog snapshot 只初始化一次且文本稳定；每次真实派发的原 discovery 查询保持；新代重建、旧回调不写新代，无跨 Host 缓存 | 区分 catalog/dispatch 来源的计数、generation 与请求引用 | C2、C3、C5 |
| F3 | GLOBAL/SHARED 与名册组合无完整 override 遮蔽 | 真实 ExtensionRunner 的不同 handler 顺序与 main/child scope | 自有三个 instruction sections 正文正确；tool guidelines/其他 section 保留；自有 hooks 不返回完整 systemPrompt 或设置 forceSystemPrompt | 既有 prompt policy 输出与实际请求 | C1、C5 |
| F4 | 模型工具面与规范同步退役 roster | fresh/resumed session 的注册/active/callable tools 与 GLOBAL 核对 | roster 不注册、不声明、不在 codemode 可调用；其他操作 schema 保持；GLOBAL 无派发前 list 要求；旧结果仍可渲染 | 注册清单、工具 delta、规范 diff | C4、C5 |
| F5 | compaction 后名册和指令可恢复 | 一次实际 compact、下一请求及同 session reload | 当前 section 进入 system checkpoint；下一请求仍有当前名册和边界；无重复普通消息或重新 list | session checkpoint、恢复请求 | C1、C3、C5 |
| F6 | 派发 authority 与 child 边界不回归 | 既有模型准入/操作/膜测试与聚焦 Host 场景 | 展示名册不跳过 dispatch 准入；缺 admission/禁用 start 时无虚假名册；fresh child 不获父目录/新工具，GLOBAL/SHARED scope 正确 | 当前检查与 root/child 请求引用 | C1、C2、C3、C4、C5 |
| F7 | 成本和交付证据明确 | 类型检查、现有回归、请求大小及缓存元数据观察 | 无新扫描/进程/依赖；记录注入字节/可取得的 token/cache 数据及限制；F1–F6 均真实通过，无 skip 充数 | `docs/summaries/2026-10-27-subagent-catalog-injection-verification.md` | C1–C5 |

**完成规则：** F1–F7 必须同时满足。纯 formatter、schema 或源码字符串检查不能代替首请求/compact/session 恢复证据；新增行为验证尚未授权时保留未完成状态。

**未满足时：** 定位具体条件，在既定范围修复并重验受影响证据；权限、来源或环境阻塞保留实际原因和下一步。独立可推进工作继续，不把全部 checkbox 勾选当作通过。

## 1. 已核对事实与方案选择

- `src/compat/pi-subagents-0.75.ts` 的 `registerBuiltinAgentsViaEvents()` 在初始化读取三个 profile 并缓存；当前 roster 每次返回其拷贝，不重新扫磁盘。name/description 与真实派发使用同一 admission 回调。
- upstream `src/extension/index.js` 已有 `advertised_subagents`，但要求 active tools 包含精确 `subagent`，且 profile `advertise:true`。当前膜阻断该旧工具，三个 profile 未 advertise；只改配置不能满足增强层需求。
- 不从 upstream 私有 formatter 深引。名册 module 归增强 package，消费已有注入的 discovery 结果；无需新增 exports、agent runtime registration 或 advertise 配置。
- Pi 1.4 的 `systemPromptOptions.sections: Record<string,string>` 支持自有 key；SDK 每轮重建 base options，所以必须每轮重新声明同一值。SDK 对稳定值不追加重复 delta，并在 compaction 保留当前 system checkpoint。
- 现有 GLOBAL/SHARED hooks 返回完整 `systemPrompt`，SDK 将其置为 `forceSystemPrompt`，会遮蔽后续 section。因此二者的结构化迁移是本功能真实依赖，不以调整加载顺序规避。
- 继续使用 `advertised_subagents` key，兼容已有 fork/loadout 对该 section 的识别。当前增强 Host 为唯一写入 owner；不得同时恢复原生广告 writer。

## 2. 文件结构与接口

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `src/agents-global/index.ts` | 修改 | 从已有 instruction 快照生成 `pi_global_instructions` section，保留 main 入口和 input 校验 |
| `src/agents-shared/index.ts` | 修改 | 生成 `pi_shared_instructions` 和 child 专属 `pi_child_execution_boundaries` section，保留 ACK/边界 |
| `test/system-prompt-override-policy.test.mjs` | 修改既有合同 | 将自有完整替换白名单归零，改现有 preservation 断言以验证 sections 和 guideline canary |
| `test/helpers/system-prompt-fixture.mjs` | 必要时修改 | 适配 Pi 1.4 的真实 options/section 观测；不新增虚构事件或 helper framework |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/agent-catalog.ts` | 新增 | 小型投影、session generation 快照、section 应用与失效；无执行 authority |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | 修改 | 将名册接入同一 ready/discovery/dispose 与 before_agent_start 生命周期 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts` | 修改 | 移除 roster descriptor/注册及专属 prompt metadata；其余工具不变 |
| `pi/AGENTS_GLOBAL.md` | 修改 | 使用注入名册，取消逐次 roster，更新工具索引与历史映射说明 |
| `README.md`、`packages/pi-subagents-enhanced/README.md` | 修改 | 说明初始化、reload、工具退役和仍由 dispatch 校验的边界 |
| `test/subagent-operation-tools.test.mjs`、`test/subagent-runtime-membrane.test.mjs`、`test/operation-guidance-contract.test.mjs`、`test/joint-upgrade-model-only.test.mjs` | 修改既有断言 | 同步精确工具枚举、原 list 委托与指引合同；不增加案例 |
| `test/subagent-model-selection.integration.mjs`、`test/subagent-dispatch-extension.test.ts`、`test/pi-runtime.integration.mjs` | 修改既有断言 | C4 审计发现的外部工具枚举/旧 roster 注册合同，由 C5 同步，不新增案例 |
| `docs/architecture/subagent-catalog-injection.md` | 新增 | 初始化流程、成本、authority、生命周期和历史 session 行为 |
| `docs/summaries/2026-10-27-subagent-catalog-injection-verification.md` | 新增 | 当前候选、各终态证据、未执行项与成本观察 |

建议新增行为测试仅一份 `test/subagent-agent-catalog.test.mjs`，需用户具体授权；优先复用现有 SDK/capture provider/temporary Host helper，不建立新框架或 provider fixture。

### 2.1 固定的最小 module 合同

以下为 C2 的新增接口，当前尚不存在。类型从 Pi 公开入口导入；其他 feature 不深引本 module。

```ts
import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type AgentCatalogEntry = Readonly<{
  name: string;
  description: string;
}>;
export type AgentCatalogReadResult = Readonly<{
  admission: "repository-configured";
  agents: readonly AgentCatalogEntry[];
}>;
export type AgentCatalogDependencies = {
  readAdmittedAgents: (
    ctx: ExtensionContext,
  ) => AgentCatalogReadResult | Promise<AgentCatalogReadResult>;
};
export interface AdmittedAgentCatalog {
  initialize(ctx: ExtensionContext): Promise<void>;
  apply(event: BeforeAgentStartEvent, ctx: ExtensionContext): void;
  invalidate(): void;
  dispose(): void;
}
export function projectAgentCatalog(
  agents: readonly AgentCatalogEntry[],
): readonly AgentCatalogEntry[];
export function formatAgentCatalog(
  entries: readonly AgentCatalogEntry[],
): string;
export function createAdmittedAgentCatalog(
  deps: AgentCatalogDependencies,
): AdmittedAgentCatalog;
```

- `projectAgentCatalog` 只拷贝 name/description，按 canonical name 稳定排序；不读取 metadata 或 profile body，不修改 admission 原对象。
- description 原文完整保留，清理终端控制符并对 XML 特殊字符做必要编码；name 不截短为另一个身份。当前底集固定三角色，不照搬原生 16 项/12KiB 限制作为新产品规则。
- 正文明确“本会话准入角色，通过 subagent_start 使用；默认不传 model，模型由 runtime 按既有规则选择”。description 已含 reviewer 只读限制，不复制完整 tools/model 候选。
- 快照只存于当前 Host 实例，含 manager 引用、session ID、cwd、generation、entries 和最终文本；不建立全局单例、外部文件或 custom entry 账本。
- `initialize` 递增 generation，使用同一发现回调且要求 repository-configured 结果；catalog 对每个 runtime generation 只初始化一次，真实 start 的既有 discovery 调用仍按每次派发执行，不能拿共享回调总次数衡量 snapshot 初始化。完成时再次核对 generation；失败记录 unavailable 并沿现有错误诊断上报，不用固定角色兜底。
- `apply` 不做 IO/发现/registry 查询。只有身份匹配、ready 且 `event.systemPromptOptions.selectedTools` 包含 `subagent_start` 时赋值 `sections.advertised_subagents`，否则删除自有 key。清空/禁用不会保留旧目录。
- `invalidate` 立即令旧异步结果失效；`dispose` 幂等。初始化一次不等于向模型只发送一次；重复请求持续声明同一 section。

### 2.2 GLOBAL/SHARED section 合同

- 保留 `createAgentsGlobalExtension` / `createAgentsSharedExtension` 现有入口签名、文件路径锚点、input 快照读取及缺文件/空文件处理。
- 自有 key 分别为 `pi_global_instructions`、`pi_shared_instructions`、`pi_child_execution_boundaries`。SDK 自动加外层 XML tag，正文不再重复包旧的完整 outer tag；来源说明可作为 section 内一行文本保留。
- 每轮设置本次有效正文；无有效快照时仅撤回自己的 key。child 边界只在 scope=child 时设置，main 删除自己的 child 边界 key；GLOBAL 的 Host child guard 不变。
- 不返回 `{systemPrompt:...}`，不设置/清除 `forceSystemPrompt`，不搜索/剥离其他 feature tag。不把 input handled 或非 fatal before-hook error 夸大为所有路径的 provider 硬门禁。
- SHARED required-extension ACK 继续在现有 startup 读取成功、handler 安装后发出；ACK 不等于模型已消费。边界正文与 `contact_supervisor` 可用性既有语义保持，不顺带调整本功能之外的政策。
- 外部 extension 若仍显式强制完整 prompt，不通过删除它的 override 达成验收；报告该组合不在默认自有 loadout 通过证据内，保留实际冲突和 owner。

## 3. 生命周期、历史与失败行为

1. package factory 注册 module 和 hook，不启动额外资源。沿现有 `ready()`，在 `beforeSessionStart` 成功后、ready 完成前 await 名册 initialize；发现源仍是原 discover DI。
2. `before_agent_start` 使用当前 typed runtime token 检查，再调用 apply。只追加自身 section，既有 tool guidelines、其他 sections 和原始消息保持。
3. new/resume/reload/cwd-bound runtime replacement 从新 ctx 重新初始化；`session_shutdown` handler 进入时先同步 `catalog.invalidate()`，再进入原 shutdown debt/beforeDispose/dispose 流程，不能仅把 catalog 挂入 resources 等异步释放。closing 期间 before hook 和迟到的 ready/initialize 都不得重新发布旧目录；新代仍按 runtime token、manager/session/cwd/generation 核对。最终 dispose 幂等清理，不改变原 authority 资源释放顺序。
4. compaction 的摘要和默认策略不替换。名册由结构化 system checkpoint 和下一轮 apply 保证，不发一条普通消息要求模型记住它。
5. old session 中的 roster tool call/result、旧 prompt 和 fork 原始历史不改写。fresh runtime 不注册 roster，下一请求由当前工具集产生 removed delta；旧结果的 TUI renderer 映射可继续保留。
6. 不恢复原生 subagent union 或 subagents_enable，不改变 child 现有工具白名单。fresh child 不新增父级编排名册；fork 继承的原始 system 历史由既有 loader 处理，不通过篡改历史“清理”目录。
7. admission 不可用只说明不能承诺可选角色；真实 start 继续沿原 fail-closed 错误，不把名册 formatter 当新的授权服务，也不静默扫描其他目录。

## DAG

```text
C1 GLOBAL/SHARED 结构化迁移 ─────────────────┐
                                            ├──> C4 roster 退役与指引 ──> C5 验收
C2 名册 module ──> C3 既有 Host 生命周期接线 ──┘
```

边与产物：C2→C3 是 module 接口与 generation 行为；C1→C4 是不会遮蔽名册的自有 prompt hooks；C3→C4 是已接好的初始化目录；C4→C5 是可启动的整体候选。C1/C2 可并行，C3 不必等待 C1；没有为了 Wave 添加额外依赖。

## Waves

- Wave 1：C1、C2（写路径分离，可并行）。
- Wave 2：C3（C2 完成即 ready，不等待 C1 所在 Wave）。
- Wave 3：C4（消费 C1、C3）。
- Wave 4：C5。

**关键路径：** C2 → C3 → C4 → C5；C1 如果更晚完成则成为 C4 的前置瓶颈。`unit-runner` 是验证资源，不是 DAG 边；资源实际占用期间不得并发 node suites。

## Task C1：把 GLOBAL/SHARED 迁到独立 section

**Deps：** `none`。

**WritePaths：** `src/agents-global/index.ts`、`src/agents-shared/index.ts`、`test/system-prompt-override-policy.test.mjs`、`test/helpers/system-prompt-fixture.mjs`。

**Resources：** `unit-runner:1`（执行既有 node suite 时独占）。

**Files：** Modify：上述现有文件，不新增 helper/测试文件。

**接口契约：** Consumes：Pi 1.4 的可变 `event.systemPromptOptions.sections` 与现有 instruction loader。Produces：§2.2 三个自有 section；两个 factory 签名不变；无自有完整 systemPrompt 返回体。

**终态关联：** F3、F5、F6、F7。

**验收标准：** 同时保持文件快照、input handled、main/child scope、required ACK、子边界和外部 guideline canary；不依赖加载先后才能显示。

- [x] 记录现有 source/输入门禁/ACK/作用域与 SDK composition 的证据，不把测试 fixture 当生产来源。
- [x] 用自有 section 赋值替换 base 字符串拼接与 findOwnBlock；只移除已无消费者的旧 outer-tag 拼接实现，保留指令正文。
- [x] 修改既有 preservation 案例与 AST policy：自有完整替换 whitelist 归零，更新精确 site 分类，不放宽为目录忽略；实际使用真实 ExtensionRunner。
- [x] 运行 `node --test test/system-prompt-override-policy.test.mjs` 与 `npm run typecheck:root`；保留 scope/缺文件/canary 的实际断言证据。

## Task C2：实现最小名册快照 module

**Deps：** `none`。

**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/agent-catalog.ts`、`docs/architecture/subagent-catalog-injection.md`。

**Resources：** `none`。

**Files：** Create：上述两个路径。

**接口契约：** Consumes：§2.1 精确类型及 Pi 公开事件/context 类型。Produces：`projectAgentCatalog`、`formatAgentCatalog`、`createAdmittedAgentCatalog` 和 `AdmittedAgentCatalog` 生命周期方法。

**终态关联：** F1、F2、F6、F7。

**验收标准：** 只投影准入 name/description、稳定排序、同代一个快照、旧代结果失效；apply 纯内存且只拥有一个 section。没有磁盘/registry/进程/权限副作用。

- [x] 依照真实 admission 数据接口核对 name/description 与 repository-configured 标记，写清展示范围与真实执行检查的区别。
- [x] 实现投影/formatter 与实例内 generation；实现 initialize/apply/invalidate/dispose，不新增 config、watcher 或持久账本。
- [x] 架构文档给出三个角色的实际格式示例与 session/new/reload/compaction 流程；成本是观测值，不保证缓存必命中。
- [x] 运行 `npm run typecheck:subagents-enhanced`，确认 package tsconfig 的 src include 实际覆盖新 module。
- [x] 建议（待用户授权）：在唯一建议测试文件覆盖 generation、tool 不可用、格式与不可变投影；未授权不创建。（2026-10-27 用户授权后创建并通过，见 C5）

## Task C3：接入已有 ready/discovery/dispose

**Deps：** `C2`（消费名册 module 的精确接口）。

**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`test/subagent-runtime-membrane.test.mjs`。

**Resources：** `unit-runner:1`（node suite 执行时独占）。

**Files：** Modify：上述现有文件，不扩 package exports。

**接口契约：** Consumes：C2 module、当前 `discoverAgents: discover` DI、typed runtime registry token、`ready()` 和 resources/dispose。Produces：ready 后初始化、带当前 ctx 的 before_agent_start apply、shutdown/dispose 失效的完整 wiring。

**终态关联：** F1、F2、F5、F6、F7。

**验收标准：** 与真实 start 使用同一 admission 源；每个 runtime generation 的 catalog snapshot 只初始化一次，真实派发的 admission 查询照常执行；旧 runtime 不污染新代；无 roster.execute/额外注册和新 authority。

- [x] 沿真实 `createTypedSubagentExtension` 实例创建 catalog，将 discover 结果严格收窄为 repository-configured；不另读 profile，不新增发现 fallback。
- [x] 在现有 ready 链正确位置 await initialize，并把 dispose 纳入 resources。session_shutdown 入口先同步 invalidate 再调用原 shutdownDebt.run；closing 期间禁止迟到的 ready/initialize 重新发布。before hook 同时核对 token、manager/session/cwd 和 catalog generation；保留现有 authority drain/dispose 时序。
- [x] 同步既有 membrane fixture 的必要 event/options 表达，禁止为了旧 stub 添加生产兼容分支或伪造 session 身份。
- [x] 运行 `node --test test/subagent-runtime-membrane.test.mjs`、`npm run typecheck:subagents-enhanced`，记录 ready 失败/重复启动相关既有回归。

## Task C4：移除 roster 模型注册并同步指引

**Deps：** `C1`（结构化自有指令已可组合）、`C3`（初始化名册已接入）。

**WritePaths：** `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`、`pi/AGENTS_GLOBAL.md`、`README.md`、`packages/pi-subagents-enhanced/README.md`、`test/subagent-operation-tools.test.mjs`、`test/operation-guidance-contract.test.mjs`、`test/joint-upgrade-model-only.test.mjs`。

**Resources：** `unit-runner:1`；`agent-guidance:1`（与 Goal T6 同改 GLOBAL 时互斥，不构造两个计划的虚假 DAG 依赖）。

**Files：** Modify：上述现有文件。

**接口契约：** Consumes：已接线 catalog 与现有 operation tool factory。Produces：不含 subagent_roster 的 fresh 注册面、GLOBAL 按当前注入目录选择角色的派发流程；其余 tool schema 不变。

**终态关联：** F4、F6、F7。

**验收标准：** roster 不在注册/active/callable 集合；默认不传 model、角色分级/审阅权限/完整合同等政策保持；历史结果仍可读。

- [x] 从 descriptor 注册与专属提示中移除 roster。内部 list 诊断/历史 schema 如仍有真实消费者可保留，不新增兼容工具或一行 re-export facade；消费者清零的专属死代码删除。
- [x] GLOBAL 的组合流程、工具名索引、历史映射与模型选择文字同步为读取注入名册；旧 list 只标历史行为，不指向已退役工具。SHARED/三个 profile 白名单无须为本功能加工具。
- [x] README 说明每 session 初始化、reload 生效及实际派发仍校验；不恢复原生 subagent，不引入 advertise 配置。
- [x] 更新既有工具数量/名单/list 断言和指引断言。运行 `node --test test/subagent-operation-tools.test.mjs test/operation-guidance-contract.test.mjs test/joint-upgrade-model-only.test.mjs`、`npm run typecheck:subagents-enhanced`，先审计各测试副作用并独占 unit-runner。

## Task C5：实际请求、恢复与成本验收

**Deps：** `C4`（传递依赖已包含全部实现）。

**WritePaths：** `docs/summaries/2026-10-27-subagent-catalog-injection-verification.md`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-model-selection.integration.mjs`、`test/subagent-dispatch-extension.test.ts`、`test/pi-runtime.integration.mjs`；仅取得具体授权后增加 `test/subagent-agent-catalog.test.mjs`。前四个测试消费者由 C4 审计证实仍引用旧 roster，由 C5 只同步既有断言/fixture 表达，不新增测试、case 或 fixture。

**Resources：** `unit-runner:1`；`catalog-host-acceptance:1`，隔离 session/state/socket 与受控捕获 provider；不在用户当前 Host 中 reload。

**Files：** Create：验收报告；Modify：WritePaths 中四份既有测试的旧工具枚举/roster 断言；Suggested Test（待用户授权）：唯一建议测试文件。

**接口契约：** Consumes：C1–C4 候选、现有 ExtensionRunner/SDK/capture provider 和 session helpers。Produces：F1–F7 的逐项证据，包含候选 HEAD/diff、首请求/重复请求、compact checkpoint、reload/new/resume、root/child 和注册工具清单。

**终态关联：** F1–F7。

**验收标准：** 证据对应当前候选；实际 SDK/Host 产生系统提示与 checkpoint，不用人工拼 final prompt 代替；不以模型自报或无关测试通过充数。

- [x] 先同步 C4 已定位的四份外部既有测试：工具枚举移除 roster、退役断言明确验证不注册；历史显示与内部 list 诊断的真实消费者保留。不得沿用 C3 在旧工具数量下的结果当最终通过，也不为旧 mock 增加 production fallback。
- [x] 串行运行 `npm run typecheck` 与适用的上述既有测试；重新运行最终候选上的 membrane 和可安全执行的模型/派发合同消费者；Host integration 先审计后按授权边界执行。历史 renderer 回归使用 `node --test test/subagent-compact-rendering.test.mjs`。元数据检查可运行现有 `publishable pinned package contract` 聚焦案例；没有 export 变化不默认运行网络 npm pack。
- [x] 审计已有 Host/RPC/capture harness，区分真实 SDK/Host 已有案例与尚未覆盖的新场景，记录资源副作用与授权范围。
- [x] 取得具体新增行为验证授权后，使用实际 Pi 1.4 与真实 admission/hooks/capture，验证首/重复请求、真实 compact 后请求及新代请求；fake provider 仅替代远端响应，不能伪造 hooks 或 checkpoint。
- [x] main 验证 `pi_global_instructions`、`pi_shared_instructions`、`advertised_subagents` 与当前工具集；fresh child 验证 `pi_shared_instructions`、`pi_child_execution_boundaries`，并证明无 GLOBAL、`advertised_subagents` 或父级操作工具。fork 仅核对既有历史继承，不修改历史来“去目录”。旧 session 恢复后检查工具 removed delta，不再注册 roster。
- [x] 分别记录 catalog snapshot 初始化次数与真实 dispatch discovery 次数，不能要求共享回调总计一次。记录 section 字节数、可取得的请求 token/cache 元数据；无法实测缓存命中/延迟时如实标注，不承诺减少整段请求传输。无需读取凭据或发送真实付费 provider 请求。
- [x] 建议（待用户授权）：唯一新测试文件补齐现有套件未覆盖的 module 与 Host 生命周期场景，复用现有 helper；未授权不得创建或用未执行案例标通过。（`test/subagent-agent-catalog.test.mjs` 8/8）
- [x] 对照 F1–F7 写明 passed/failed/blocked/未执行及引用；未满足则返回相关任务最小修复。成果 review 仅在用户再授权时派发；不 commit/push/发布或切生产配置。（全部 passed，见 `docs/summaries/2026-10-27-subagent-catalog-injection-verification.md`）

## 4. 执行与审阅状态

- 用户已明确选择 Subagent-Driven，C1/C2 已并行派发；本计划进入实施，C1–C5 和 F1–F7 尚未完成。主会话按真实 DAG 持续推进，新增测试/fixture 与网络/真实 provider 行为仍按原边界处理。
- 首轮 reviewer 已完成，原文保存于 `docs/reviews/2026-10-27-subagent-catalog-injection-review-1.md`；结论为“修订后可执行”。主会话已 inline 修订三项 Medium：catalog/dispatch 计数分开、main/fresh child 的 section 验收范围、shutdown 入口同步失效。未自动追加二审。
- 静态自检通过：5 任务完整字段、DAG 无环、F1–F7 终态与接口声明类型检查；这不代替 C5 的实际请求和恢复验证。
- 执行记录：C1 `dd45ea93-bfc1-4348-9249-afb089f5273d` 已完成，真实 ExtensionRunner 32/32、root typecheck/diff 检查通过；C2 `c2905f38-1bd8-41a3-b8e9-6e8e7aa7273b` 已完成，module/架构文档与 package typecheck/diff 检查通过。C3 `f905b663-5db7-4fdc-a3a4-626c72e5176b` 已完成接线、既有 membrane 全文件、package typecheck/diff。C4 `0bd5ffad-30ff-4ee7-82f4-bd317efe5258` 已完成六工具注册/文档，原三套既有检查26/26和package类型/diff通过；unit-runner释放。C5 经原会话续跑 `ba417f4e-cd96-48a3-8bcb-f413a8f470e0` 已完成当前授权内工作：四份旧断言同步，类型检查通过，最终既有回归261/261、0 skip，所有命令退出并释放资源。报告为 `docs/summaries/2026-10-27-subagent-catalog-injection-verification.md`。F1/F5 blocked，其余partial；首请求/生命周期/compact/fresh child/旧tool removed delta仍需计划指定的新行为验证授权，整计划未完成。
- C2 交付后立即派发 C3，无需等 C1；C1/C3 完成后派发 C4，之后 C5。C4 scope 决策 `19051f7a-6356-47a9-85ca-c22a1413c14e` 已回复：C4 保持七文件，四份外部既有断言由 C5 承接；不增加测试案例。审阅与实现授权分别处理，不自动追加成果 review。
- 实施中发现来源异常，先记录实际入口、权威身份、事件顺序和首个偏离点，区分 production、测试构造与未证实来源，不加预防性 fallback。
- 两个计划若并行实施，GLOBAL 和当前 subagent-dispatch 文件的实际写冲突由资源/隔离解决，不为协调方便把本计划塞入 Goal DAG。
- 当前真实阻塞：C1–C4 实现与 C5 既有检查已交付，剩余F1/F2/F5/F6及F4恢复缺口需具体新增 `test/subagent-agent-catalog.test.mjs` 的授权；拟复用现有本地合成provider/helper，不增加通用框架、外部provider请求或修改当前Host。未获该授权前不创建case/fixture，也不降低F1–F7。用户对既有代码成果的review仍需单独授权。
