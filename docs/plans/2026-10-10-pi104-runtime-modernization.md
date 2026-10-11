# Pi 1.0.4 runtime 现代化改造计划

> **给执行 agent：**按本文 DAG 执行获授任务，步骤以 `- [ ]` 跟踪。本文由本会话 inline 编写，实施方式须在首轮 reviewer 返回、计划修订之后由用户选择。子任务不得自行修改本计划。默认禁止 TDD，不加载任何 TDD 类 skill，不新增测试 case。

**目标：**保留 Pi 原生 system prompt、工具定义与公开扩展契约，消除“仅为 TUI 却重注册工具”“流程指令写入工具结果”等职责错位；修复配置生成和 child 预览的已证接口问题。保留本仓跨进程身份、授权、恢复和集成能力，不以现代化名义重写全部 runtime。

**架构：**单工具能力由所属 feature 的 `ToolDefinition` 元数据提供；纯显示使用 `registerToolRenderer`、message/entry renderer 和公开 TUI 组件。多工具流程按作用范围归 GLOBAL 或具体 agent 正文；SHARED 只保留共同规范。配置 owner 策略仍由本仓维护，不把原生 setter、session event 或 prompt 当作授权和事务保证。

**技术栈：**Pi 四核心包 `1.0.4`、`pi-subagents 0.75.0`、Node `>=22.19.0`、原生 TypeScript type stripping、既有 TypeScript 静态检查和 Node 单测。API 首次引入版本未证实的，一律称“1.0.4 已支持”，不称“1.0.4 新增”。

## 需求与授权边界

1. 用户已明确授权 **Subagent-Driven** 执行本修订计划，并明确同意 M07 三 profile 使用 `systemPromptMode: append`。当前已完成的 title/list 修复作为 dirty 基线保护，不重复实施；系统通知、派发回执 triggerTurn 调整与 heartbeat 修复不在本轮。
2. 优先原生机制；不整体替换 Pi 原生 system prompt，不新增 feature 工作流 system 区块、通用工具编排框架或共享 utils/package。
3. 单工具 `description` 描述动作和契约，`promptSnippet/promptGuidelines` 描述能力与适用时机。组合流程：仅父会话适用放 `pi/AGENTS_GLOBAL.md`；特定角色适用放对应 `pi/agents/*.md`；不放 `pi/AGENTS_SHARED.md`。
4. 默认禁止 TDD 和所有 TDD 类 skill，尤其不加载 `test-driven-development`、`writing-skills`。不写失败测试、不执行 RED→GREEN，不新增测试 case。只同步现有断言、fixture/harness 并运行允许的既有测试；直接覆盖不足如实记载，不用临时 smoke 冒充正式覆盖。
5. 只做短单测与必要静态检查；不运行真实 Host/CLI/RPC/TUI/PTY、业务 child、provider、MCP、模型请求、初始化、完整 integration 或全量升级矩阵。组件离线渲染、fake API、合成文件 fixture 可以使用；含真实流程的用例不得因文件后缀为 `.test.mjs` 就整文件执行。
6. 默认直接在本仓工作，不新建隔离安装目录，不安装或升级依赖。写冲突以领域资源锁调度；不能为方便修改同一文件而覆盖 dirty、reset、restore 或 stash。实施若另选 worktree，必须用户同意并通过 typed 管理，不用 raw Git worktree。
7. production/CLI 使用 `.ts`；可复用实现放所属 `src/<feature>/` 或 package `src/`。入口只绑定 Host/依赖注入。跨领域只用公开入口，不能从 package 实现反向 import 根入口或 `scripts/**`。
8. 所有展示精简只在 renderer。不能为显示改写 message、tool result、event payload、session、`details`、`structuredContent` 或 `display`。新增程序数据通道是明确 API 改造，不能伪装为 TUI 优化。
9. 禁止 MCP 接入、注册和工具调用。外部能力使用非 MCP CLI/SDK/HTTP skill wrapper；Exa 保持 skill，不迁移凭据。已有 MCP 代码本计划不启用，也不顺手拆除；codemode 非 MCP 能力与其分开处理。
10. 不读取真实 auth/models/凭据、会话或工作区 authority 数据。真实 settings 的写入不属于实施任务；仅在明确授权后由临时脚本间接做非敏感投影/字段级变更，`enabledModels` 等本机字段不得入 Git。
11. 不新增 model-error fallback、自动换模、自动结束 child 恢复器、第二 completion sender/owner、broker、lease、scheduler 或持久化标题账本。用户要求的偶发失败恢复是主管使用既有 `resume` 的决策规则，不是 runtime 自动重试。
12. 不 commit/push、不热重载、不终止用户 Host。需 fresh Host 生效仅写入交付说明，不自行启动验证。
13. 发现异常先按根 AGENTS 的三类数据来源门禁分类；合法 public 入口及身份/顺序事实支持生产缺陷，缺字段 mock/旧断言只修测试，未知来源停止相关越界操作而不加兜底。

## 首轮审阅、修订状态与执行前决策

- 首轮自动 reviewer 已完成：run `4865f18a-138c-4ec5-8c04-0e1fc3a81653`，报告 `/tmp/pi104-runtime-modernization-plan-review-1.md`；原稿 SHA256 `a416fa8fff881dfd0ca5983baaa208dada4921e9f07307fb4c6a81b167ad0841`。结论为 **Critical 0 / Important 4 / Minor 5，需要修订，不是无条件通过**。
- 本版由主会话 inline 修订：收紧 M04 trust/cwd、M08 单路径队列范围、M03 active/load-order、M09 selector 作用域，明确 M05A 结构化成功/错误通道、M06/M10 新建路径及生命周期、M12 完整验收闭包。不因修订再自动派 reviewer；本版尚未复审。
- **M07 的独立产品决策已获确认：**用户明确回复“Subagent-Driven，同意 append”。因此 M07 在 M00 完成后可进入 ready set；不扩大 models/tools/inheritance，单测不证明模型行为等价。
- 修订不扩大验证授权，不新增 case/TDD、真实 Host 或 paid canary。系统空闲通知只沉淀到 `docs/decisions/2026-10-10-idle-system-notification.md`，实现暂缓，不纳入本文。
- 两项审阅意见采用边界建议但不照抄绝对判断：JavaScript 对象 spread 的 undefined 不是必然运行错误，仍显式使用 `next() ?? {}` 提高清晰度；单 key API 缺少本轮可证多路径合同，不等于所有有序嵌套方案数学上必然死锁，本轮仅实现单路径，不研究或宣称 move 安全。

## 基线、审计来源与证据纠正

- 已推送基线：`05a150de61c7c8665b921a365a92eda177bef864`；此前三笔工程提交已推送，不重新打包或重写历史。
- 工作区仍含后续通知 title 修复及 handoff 改动，M00 冻结实际工作区而不是把 HEAD 当唯一内容。通知修复去除了 sendMessage 中按 agent 消费标题队列的装饰；显示层使用官方 `Retention-managed async directory:` 末段 UUID。list 后续显示要求是仅 name/description，原始 frontmatter 仍完整给模型。
- 工具审计：`/tmp/pi104-runtime-modernization-tools.md`，run `2b2a9213-d1ac-44ff-a08b-29c4c5ff7cab`。
- TUI 审计：`/tmp/pi104-runtime-modernization-tui.md`，run `4d9e99c4-b9be-4232-8c53-32252cc46bb9`。
- 生命周期审计：`/tmp/pi104-runtime-modernization-lifecycle.md`，run `97d0baee-0785-44ca-adc1-0f6d9499c201`。
- delivered 诊断：`/tmp/steer-delivered-ui-provenance.md`，run `2ef365f7-c3d4-43d4-b8ee-be4b45fd125c`。
- 临时报告仅为审计输入；实施所需条款、路径、契约已经写入本文，不能把 `/tmp` 文件变成正式单测的必要 fixture。

**生命周期报告的证据纠正：**该 lane 曾写“root node_modules 缺失、根 docs/extensions.md 不存在”。编写计划时本会话已按精确路径读到 `node_modules/@earendil-works/pi-coding-agent/{README.md,docs/extensions.md,docs/sdk.md,dist/core/extensions/types.d.ts}`，并读取其 package metadata `1.0.4`。不能据该 lane 的未解析路径要求重新安装、构造 vendor Host 或认定 API 缺失。该报告有关 authority 保留的结论可采用；缺乏 Host 实物支撑的替换建议仅作为边界，不直接实施。

### 已证实的关键接口

| API / 当前问题 | 证据与结论 |
|---|---|
| `registerToolRenderer((name,next)=>ToolRenderers)` | Host `dist/core/extensions/types.d.ts`、runner resolver 链；只包含 `renderShell/renderCall/renderResult`，适合 compact-only 功能。`next() ?? mine` 只补空，不会覆盖已有 renderer。 |
| definition-first 与 `create*ToolDefinition` | `agent-session.js` 最终自定义同名 definition 覆盖 base；`wrapToolDefinition` 不携 S/G。`compact-tools` 当前 six native re-register 是真实 metadata 丢失入口。 |
| `promptSnippet/promptGuidelines` | 仅 active 且声明未隐藏的工具进入默认 tools/rules；`customPrompt` 分支跳过默认 tools/rules，三个 profile 的 replace 因而是消费者缺口。 |
| `BashToolOptions.spawnHook` | `createBashToolDefinition` 公开支持；native `ctx.cwd || factoryCwd` 优先于新 factory 默认 cwd。当前 bash-cwd 验证目录后仍传原 ctx，有明确首偏离的源码链。 |
| `withFileMutationQueue(path,fn)` | 包根公开导出，native edit/write 使用；只保证同进程同 canonical 文件串行，非多文件事务、非跨进程授权。 |
| `SettingsManager` | 有部分公开 setter、`flush/drainErrors/fromStorage`，没有 `setDefaultTools` 或 arbitrary extension field setter；内部 FileSettingsStorage 不能作为 production deep import。 |
| `ToolInfo` 与 `ToolRenderers` | `getAllTools()` 的 ToolInfo 不含 renderer；child browser 把它交给 ToolExecutionComponent 是接口误用。 |
| `resume` | 0.75 正常恢复生成新 run，取旧 `target.sessionFile`，由 child session factory 打开持久化会话后加入新 message；不是原进程原地继续，也不是复制父会话。 |
| steer delivered | runner 事件有 `type/ts/runId/requestId/index/late/deliveryStatus/message`，父 tracker 当前不转发。没有现有公开即时订阅接口，不能拿 queued 当 delivered。 |

## 改造决策与完整覆盖表

“完整计划”覆盖所有审计项，但不意味着所有可选新 API 都必须改。

| 审计项 | 本计划决策 |
|---|---|
| security-gates 结果中插 TDD 流程 | M01 删除结果提醒职责，保留全部执行门禁。 |
| settings 默认/本机生成缺口 | M02 明确 owner 和合并规则，迁到 feature 公共入口；不强用不完整原生 setter 替换事务。 |
| compact 同名注册、metadata 丢失 | M03 改 renderer-only、撤销注册激活副作用；M02 声明默认搜索选择，最终 active 集由 Host/settings/CLI/profile 决定，不承诺迁移前后逐会话完全等价。 |
| bash-cwd 显式目录 | M04 使用公开 spawnHook，保持 Host context、校验与 shell 配置。 |
| 工具提示缺失/结果契约缺项 | M05A/B 按 owner 补 S/G 和必要 label/details；不凭没有稳定数据 schema 的文本工具强塞 outputSchema。 |
| ToolInfo 当 renderer、entry 当 message | M06 修本仓拥有的工具显示；未知工具/条目诚实 fallback，不取得私有 registry。 |
| 角色 replace 消费缺口、正文过薄、失败恢复文案 | M07 明确三个 profile 使用 append 保留原生基础提示，精炼角色正文，GLOBAL 收纳组合流程/主管恢复规则；inheritance/tools/models 不扩大。该行为变化须用户明确确认，执行方式选择本身不替代确认。 |
| apply_patch 文件变更队列 | M08 仅 add/delete/不含 move 的 update 纳入原生单路径 queue；move 保现状，明确未纳入共享串行保障，不构造双路径锁或事务。 |
| skill-whitelist 追加扫描伪白名单 | M09 交回原生发现，退役名称用声明 selector；保留 managed skill symlink/校验能力，不把 discovery 当权限门禁。 |
| async-progress UI 消息污染上下文 | M10 改 TUI-only `setStatus("async-progress", text)`，非 TUI no-op；不把 handoff 功能消息移出模型上下文。 |
| GLOBAL/SHARED 字符串 append | 保留当前保 base 的注入与缺失门禁，不全量替换、不无证据迁 sections；公开接口不等于适用。 |
| skill private prototype patch | 不改变已接受外观，仅在 M03 将重复实现归单一 owner；无公开等价接口，不宣称消除了私有耦合。若用户选择原生外观，再另行删除 patch。 |
| ScrollView/normalized mouse/组件树互动 | 当前 viewport 非 drop-in；本轮不重造或改变 Option+O thinking 默认，列为后续选择。M06 只修接口误用，不宣传恢复了所有点击。 |
| lifecycle cleanup/RPC wire 重复 | M11 静态收敛成清晰的接口保留清单，不创建未被证明必要的新 disposable/codec 框架，不自动删 debt。 |
| Codex-only 代理→全局 httpProxy | 作用域不同，保留；不改变网络/认证/transport。 |
| provider fallback/physical bundle/ownerproof | 保留 API guard 和明确原生 provider；不换虚拟模型、不删 peer binding、shell early guard、RootBroker、lease、processBirth、grant、terminal proof、integration queue、consumption receipts。 |
| delivered TUI | M11 记录上游公开转发所需契约；没有上游支持即交付为阻塞项，不改 node_modules、轮询或建第二 IPC。 |

## 文件职责

- `src/compact-tools/index.ts`：新的 compact feature 公共入口；renderer resolver 装配与已有展示包装归该领域，不是 root 通用库。
- `src/compact-tools/renderer.ts`：纯组件/formatter，保原始输入不变。
- `src/pi-settings/index.ts`：模板与本机字段 owner 合并、检查、条件集成；CLI 不再容纳可复用实现。
- `scripts/ensure-pi-settings.ts`：薄 CLI，保留现有导出 `ensureSettings` 的兼容调用面及参数，不增加 scripts 业务依赖。
- `src/apply-patch/result.ts`：新建成功 output schema/结果类型与原文不变的结果装配；由已有 feature `index.ts` 公开导出，入口消费，不把复用实现放 Host 入口。
- `packages/pi-subagents-enhanced/src/tui/tool-renderers.ts`：**新建**，从现有 `extensions/subagent-runtime.ts` 提取纯 renderer 工厂，供两个 Host 入口消费；不是已存在的实现文件，不 import 根 `pi/extensions/**`。
- `src/async-progress/index.ts`：**新建**，从现有 `pi/extensions/async-progress-watcher.ts` 提取 parser/tail/watch 与 UI-only 生命周期实现，入口只绑定 Host。
- `docs/plans/records/2026-10-10-runtime-modernization/`：**新建记录目录**；M00 创建并只写 baseline，M11 只写 public-boundaries，M12 只写 acceptance，各文件一个 owner；不含凭据或真实 session 正文。

其余改动文件逐任务列明。上游安装目录只有只读取证权限。

## DAG 与资源

```text
M00 基线/静态覆盖
 ├─ M01 安全门禁结果职责
 ├─ M02 配置owner与原生工具默认
 │   ├─ M03 compact纯renderer ── M04 bash-cwd
 │   └─ M09 原生skill发现
 ├─ M05A 本地业务工具元数据 ── M08 patch文件队列
 ├─ M05B 控制/调度工具元数据
 ├─ M06 child预览renderer接口
 ├─ M07 角色/流程/resume规则
 ├─ M10 进度UI-only
 └─ M11 public边界与delivered阻塞记录

M01,M04,M05B,M06,M07,M08,M09,M10,M11 ── M12 聚焦验收
```

**计数口径：14 个可派发 DAG 节点/执行单元。**M00–M12 有 13 个数字领域，其中 M05 拆为 M05A/M05B 两节点，不存在额外 M05 任务。审阅报告的“13 个 DAG 节点”不按原子派发口径采用。

M03 经 M04、M02 经 M04/M09、M05A 经 M08、M00 经所有分支传递至 M12；保留图中最小直接依赖。**M12 的验收前置闭包显式包含 M00、M01、M02、M03、M04、M05A、M05B、M06、M07、M08、M09、M10、M11 全部 13 节点**，不仅检查图中末端任务。M08 消费 M05A 的 patch result 公共契约，因此有真实产物依赖。

**Waves（非屏障）：**
- Wave 0：M00。
- Wave 1：M01、M02、M05A、M05B、M06、M07、M10、M11，依资源立即派 ready 项。
- Wave 2：M03（消费 M02 的显式 active 默认）、M09（消费 M02 的 skills selector 合并）。
- Wave 3：M04（消费 M03 拆出的 bash 显示边界）；M08 在 M05A 完成即可执行，不等 M03。
- Wave 4：M12。

**关键路径：**M00→M02→M03→M04→M12。M05A→M08 为另一较短链，其他分支不阻塞 ready 项启动。

**Resources：**同一 `src/<feature>`/package renderer 文件由一个任务写；M05B 修改 dispatch 工具定义，M06 修改 main entry 与 TUI 工厂，两者路径不同，可并行。M02 与 M09 都涉及 Doctor，但 M09 已依赖 M02，因此不存在并发覆盖。M03/M04 的 bash entry 交接按真实依赖串联。M00 独占 tsconfig 写入，其后任务不得扩大 include；需要新增路径时上报。`unit-runner` 容量 1，统一覆盖 Node 单测和 `tsc`（包括 listFilesOnly/noEmit）；所有静态检查也必须持有该资源，不另增第二套并发规则。资源锁只限制验证，不限制无冲突代码任务并行。M07 另外需要用户明确的 append 决策，未经确认不得派发。

## 验证方式

```bash
# NODE 为当前已安装且满足 >=22.19.0 的 Node 物理绝对路径；记录实际版本，不要求 Node26。
# REPO 为本仓根，不另安装 Node 或重复多版本矩阵。
env -i PATH="$SAFE_PATH" HOME="$ARENA/home" \
  XDG_CONFIG_HOME="$ARENA/config" XDG_STATE_HOME="$ARENA/state" \
  PI_CODING_AGENT_DIR="$ARENA/agent" \
  PI_TEST_CODING_AGENT_ROOT="$REPO/node_modules/@earendil-works/pi-coding-agent" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  "$NODE" --test --test-concurrency=1 "$TEST_FILE"
```

每个任务保留真实退出码和完整本地测试日志；不得 `cmd | head; echo $?` 或 grep 成功掩失败。单次命令 60 秒预算；超时先定位 own process，不执行全盘搜索或延长成升级矩阵。不重复跑无关套件，M12 对已验收且文件未变的日志复用，只补一次跨分支的最小组。新增 TS 最终 root/enhanced `tsc --noEmit`，用本仓 TypeScript 脚本，不 npm/npx。

所有“Test”文件表示**既有测试更新/执行候选**，不是新增 case 的授权。若断言调整不足以直接覆盖新分支，记录覆盖缺口；不能以纯静态源断言假称运行行为已验证。

---

## M00：冻结当前工作区、公开接口和静态覆盖

**Deps：**none。
**WritePaths：**`tsconfig.json`；`docs/plans/records/2026-10-10-runtime-modernization/baseline.json`。
**Resources：**`tsconfig-write`、`unit-runner`。
**Files：**Modify `tsconfig.json`；Create baseline；Read 三份审计、本计划、当前 manifests 与 dirty 列表。
**契约：**产出每个允许路径的 `{exists,sha256,owner}`、未纳入任务的 dirty 保护清单、三方版本及公开 export 检查结果；真实 settings/auth/models 不读取、不 hash。

- [x] 汇总各任务 WritePaths 并冻结 task-before，而不是恢复 HEAD。保留后续 title/list 修复；已恢复 unit 任务日志 `/tmp/notify-tests-sync-unit.log` 为 110/110，但 `.exit` 缺失，退出代码无法独立验证；不把早前 107/110 或旧失败回执当全绿，不重跑全矩阵。
- [x] 仅从已安装 package 根核实公开 `registerToolRenderer`、`create*ToolDefinition`、`withFileMutationQueue`、`SettingsManager`。四核心为 1.0.4、pi-subagents 为 0.75.0；记录 sibling 1.1.0，不变更依赖。
- [x] 在根 tsconfig 一次补齐计划指定根 TS 领域及入口，JSON 使用 9 个精确新增 include（不使用花括号语法）；已有 compilerOptions 与既有 include 保持。
- [x] 静态核对索引为空、root 配置未纳入真实本机文件；baseline 已写入 `docs/plans/records/2026-10-10-runtime-modernization/baseline.json`，arena 为 `/tmp/pi104-modernization-1XMAot`。未运行测试/tsc/业务验证。

**验收：**未覆盖 dirty；路径清单完整；计划新增 TS 能被最终静态检查覆盖；未安装或读取秘密。

## M01：移除 security-gates 的结果流程提醒，保留权限门禁

**Deps：**M00。
**WritePaths：**`src/security-gates/extension.ts`、`src/security-gates/shell-policy.ts`、`test/security-gates-extension.test.mjs`、`test/shell-policy.test.mjs`。
**Resources：**`security-gates`、`unit-runner`。
**Files：**Modify 上述文件。
**契约：**`tool_call` 的路径/shell/cwd/commit 判定不变；成功和失败 `tool_result` 均不被插入流程文字。

- [x] 记录来源：合法 write/edit→`codingReminderFor`→成功 `tool_result` 追加 TDD，首偏离在 reminder 职责而非 Host。此缺陷已由生产调用链证明，不能为新默认禁令增加另一条回执兜底。
- [x] 删除 `tool_result` reminder handler、`appendReminder` 和不再被生产调用的 `codingReminderFor`/仅供其使用常量；删除前限定检索调用方，不能扩大 shell-policy 行为。
- [x] 同步既有 reminder case 为 handler 不存在或结果不改的原生合同，保留 tool_call 阻断及 raw 输入校验。测试标题不再要求默认 TDD。
- [x] 只运行既有两个纯测试文件一次；静态确认 `tool_call` handler、路径/shell/cwd/commit 判定实现未删除或放宽。既有纯测试只证明其实际覆盖的拒绝分支，不扩成全部权限矩阵验收。

**验收：**工具结果无流程注入；`tool_call` 拒绝通道静态保持，既有纯测试通过或明确阻塞；未覆盖门禁列为验证限制。

## M02：配置 owner 合并与原生工具默认选择

**Deps：**M00。
**WritePaths：**`src/pi-settings/index.ts`、`scripts/ensure-pi-settings.ts`、`pi/settings.template.json`、`test/ensure-pi-settings.test.mjs`、`scripts/doctor.ts`（仅配置检查的一致性）。
**Resources：**`settings-policy`、`unit-runner`。
**Files：**Create feature index；Modify 现有 CLI/template/tests；Doctor 只在检查语义需同步时改。
**契约：**`ensureSettings(options)` 保留现有参数；输出由明确字段 owner 决定，不覆盖本机模型、认证、theme 或未知字段。

- [x] 将可复用 merge/check 移入 `src/pi-settings/index.ts`，CLI 只解析 `--check`/默认路径和错误退出。CLI 可调用该公开函数；生产模块不得 import CLI。
- [x] 定义共享默认标量 allowlist **只有 `hideThinkingBlock`**：缺失时补模板默认，显式 true/false 都保留；类型非法报配置错误，不将未知键普遍复制。`--check` 检查缺失/非法，不要求显式 false 改 true。
- [x] scheduler 同 source 条目以 source 去重，并将该共享 source 的 `extensions/skills/prompts/themes` 四资源收敛为空，保留该条目其他未声明属性。其他 package source 的本机资源不改。
- [x] r2c 不回模板：使用与配置 source 同一解析根，目录存在则补一次本机 source，缺失仅清陈旧 source。EACCES 等错误不等价于不存在；不删除实体目录。Doctor 使用相同目录/可读性判定，不出现 ensure 成功、Doctor 必然失败的矛盾。
- [x] 模板声明增量 `+grep/+find/+ls`；`+codemode/-tool_search` 和 builtin exclusions 保留，不写 plain names 覆盖 read/bash/edit/write。模板本身不是 Host 配置：只有 ensure 的合并产物作为 `<agent-dir>/settings.json` 被 Host 读取后默认才生效；本轮不写真实配置、不宣称旧 Host 已激活。项目 `defaultTools` 的 plain list 可替换用户选择，增量 list 按原生规则叠加；CLI `--tools/--no-tools/--no-builtin-tools` 和 child profile 的限制优先，renderer 不调用 `setActiveTools` 绕过。
- [x] 模板添加 `skills: ["!**/plan-runner-dispatch/**"]` 并保 `!/+/-` selector 合并/反向冲突检查；它仅声明所在配置 scope 的排除策略，不保证压过项目显式资源或 `resources_discover` 的追加。源码依据：package manager 的 `addAutoDiscoveredResources` 对各 scope 应用 overrides；resource loader 的 `extendResources` 另外 merge callback paths。M09 删除本仓 scanner 后仍须独立核对本仓声明根的排除，不声称全局权限白名单。
- [x] 移除 owner 不明的全标量覆盖建议。SettingsManager 仅在有公开 setter 且不破坏单次 owner 合并时复用；本轮 **不分两套存储分别重写同一个 settings 文件**，不 deep import FileSettingsStorage，不造通用 lock framework。保现有原子 rename/0600 创建与失败前不写；文档承认当前存储不保证与外部同字段写入的无冲突事务。
- [x] 更新既有 ensure fixtures：模板无 r2c 仍可按本机目录生成；scheduler 已存在条目资源纠正；Thinking 缺失补默认、已有本机值保留可放既有合并 case 内，不增加 case。运行该纯文件一次；**不对真实 `pi/settings.json` 执行 ensure/check/Doctor**。

**验收：**三个生成缺口闭合，真实配置没写；既有合并 fixture 与静态原生解析依据支持所声明的默认工具/skills 策略，供 M03/M09 消费；反向 selector 冲突仍在写入前失败。不以 fixture 或模板字符串证明真实 Host/每个 child 的 active 集。

## M03：compact-tools 改为纯 renderer 注册

**Deps：**M02（消费原生工具默认可用策略与 selector 合同）。
**WritePaths：**`src/compact-tools/index.ts`、`src/compact-tools/renderer.ts`、`pi/extensions/compact-tools.ts`、`pi/extensions/bash-cwd.ts`（只拆出显示绑定）、`test/compact-tools-extension.test.mjs`、`test/compact-tools-renderer.test.mjs`、`test/compact-tools-error-visibility.test.mjs`。
**Resources：**`compact-display`、`bash-entry`、`unit-runner`。
**Files：**Create feature index；Modify 入口、既有组件与测试。
**契约：**`createCompactToolRendererResolver(dependencies)` 返回公开 `ToolRendererResolver`，只处理六 native 工具与 bash 的显示，不注册/执行/激活工具。

```ts
pi.registerToolRenderer((name, next) => {
  const mine = renderers[name];
  if (!mine) return next();
  const base = next();
  return { ...(base ?? {}), renderShell: "self", renderCall: mine.renderCall, renderResult: mine.renderResult };
});
```

- [x] 将入口内可复用的摘要/skill read/single-line 装配归 feature 公共入口；入口只绑定 public TUI 依赖与 resolver。删除 `nativeTools(cwd)` 缓存、six factories、重注册工具与 execute wrapper。
- [x] 保 state/args/context.isError、4 物理行错误、expanded 分支、窄列宽和 summary 清理行为。不修改原始 result 或图片数据；未知工具调用 next。
- [x] bash 显示从 `bash-cwd` 的 definition wrapper 剥离到同一显示 owner；`bash-cwd` 工具 definition/execute/schema 留在原执行领域。
- [x] SkillInvocation 的 private patch 不扩作用范围、不变外观；去掉重复实现后只由 feature owner 装配一次，保 Symbol 去重。报告仍私有耦合，不能称 registerMarkdownTransformer 已替代技能外壳。
- [x] 现有 compact-extension fake API 改为收集 resolver 而不是工具；旧“execute selects cwd”case 改验扩展未注册工具、未调用 setActiveTools、原工具 metadata/execute 身份未替换（同一既有 case，不增加数量）。在已有 resolver fixture 内核对 next 返回 undefined、已有 renderer、未知工具 passthrough；不能容纳时如实记录覆盖缺口，不新建 case。原生 factories 只读比较，不执行真实工具。
- [x] 明确 resolver owner：本扩展对 read/edit/write/grep/find/ls 六工具及 bash 的显示字段有意覆盖 `base`，其余字段保留；其他工具直接 next。链按 Host 注册顺序解析，前置扩展不调用 next 可以截断后续 resolver，不宣称跨扩展 last-wins 或能绕过这种截断。
- [x] 运行三个既有纯显示测试文件一次。`defaultTools` 生效/真实 load-order/partial/theme 缺直接覆盖的项目列限制，不启动视觉 smoke。

**验收：**compact 本身不再注册/执行/激活工具，definition 和原生 metadata 不被其替换；撤销旧注册副作用后 active 集以 M02 声明和 Host 选择为准，不承诺迁移前后完全等价。纯组件覆盖的 compact 展示保持，真实视觉效果未验证。

## M04：bash-cwd 用公开 spawnHook 保证显式 cwd

**Deps：**M03（bash entry 的显示已分离）。
**WritePaths：**`src/bash-cwd/extension.ts`、`pi/extensions/bash-cwd.ts`、`test/bash-cwd-extension.test.mjs`、`test/bash-cwd-policy.test.mjs`。
**Resources：**`bash-entry`、`bash-policy`、`unit-runner`。
**契约：**未声明 cwd 保 native `ctx.cwd || factoryCwd`；声明 cwd 经原 validator 后写入最终 spawn context。配置 trust 与目标 cwd 分离，不替换 Host session context。

- [x] 记录 public 入口链：validated factory cwd→native execute 使用 `ctx.cwd || cwd`，不可把旧 fake factory 通过当实际 cwd 证明。
- [x] 初始化 definition 只取得 schema/metadata，不读取真实 SettingsManager：调用 factory 使用空 options。每次 execute（无论是否声明 cwd）才以原始 Host ctx 解析 shell options 并创建执行 definition；不再让无 cwd 分支直接使用初始化时缓存的项目配置。
- [x] `getBashOptions` 的 no-context 分支直接返回 `{}`，不读取任何 settings；有有效 ctx 时以 `ctx.cwd` 和 `ctx.isProjectTrusted?.() === true` 调用公开 `SettingsManager.create`，缺失 trust 方法按 false。false 仅加载 agent-directory 全局设置，公开 `loadFromStorage` 在 project scope 提前返回空对象，不读取项目文件。只有可信 ctx 才合并项目 shell 配置；不能以 validated 目标目录换成另一项目的配置来源。保留可合法读取的 shellPath/commandPrefix，不写设置。
- [x] 显式 cwd 组合 hook：`const next = options.spawnHook?.(spawnContext) ?? spawnContext; return { ...next, cwd: validatedCwd };`。先调用既有 hook、保 command/env，再强制已验证目录；无 cwd 不加目录 override。原 ctx/signal/onUpdate 原样传递，不 spread ctx 伪造 sessionManager/trust，保 session env。
- [x] 更新既有 fake operations/factory case，在 native definition + fake operations 中观察最终 cwd/command/env；已有 fixture 内核对 no-context 不访问 SettingsManager、false 不读取 project、true 可用项目配置（只合成设置）。覆盖不足列限制；运行两个既有纯文件一次，不派生 shell。

**验收：**最终 backend cwd 与 trust 配置来源两项分别核对；静态无未授权项目读取、既有 fake operations 证明 spawn 参数，取消/output 契约保留。未进行真实 Host trust 或 shell 执行验证。

## M05A：本地业务工具补原生提示与稳定数据契约

**Deps：**M00。
**WritePaths：**`src/basic-memory/extension.ts`、`src/apply-patch/result.ts`、`src/apply-patch/index.ts`、`pi/extensions/apply-patch.ts`、`pi/extensions/context-usage.ts`、`src/context-usage/snapshot.ts`、`test/basic-memory-extension.test.mjs`、`test/context-usage-extension.test.mjs`、`test/context-usage.test.mjs`。
**Resources：**`business-tool-definitions`、`unit-runner`。
**契约：**不改变工具名称、参数、exposure 或 CLI backend；使用原生 S/G，不编制工具组合手册。

- [x] memory 五工具加明确 label、短 snippet 和单工具时机（查找/读取/构建相关笔记/近期活动/写可复用结论）；秘密写入拒绝保留。stdout 未证稳定 schema，保持文本通道，不乱加 outputSchema。
- [x] apply_patch 加“多文件结构化补丁”的 snippet 与相对 edit 指导，保 patch 格式 description。新建 feature-owned `result.ts`，以公开 `@earendil-works/pi-ai` 导出的 `Type` 定义 `Type.Object({added: Type.Array(Type.String()), modified: Type.Array(Type.String()), deleted: Type.Array(Type.String())})`；三个字段均 required，不增 ok/error 包裹。显式类型 `ApplyPatchOutput = {added: string[]; modified: string[]; deleted: string[]}` 与 schema 一致，经 `index.ts` 导出 schema/成功结果装配函数。成功 structuredContent 等于当前 added/modified/deleted 数据，旧 content 和 details 的值保持。
- [x] patch 错误通道只保原错误文本、`isError: true`、`details: undefined`，**不返回 structuredContent**；outputSchema 只承诺成功结果。codemode 的公开转换在无 structuredContent 且 isError 时 reject，不能返回零计数伪成功，也不增加未确认的 partial/error envelope。成功不等于整个 patch 事务。
- [x] context_usage 从现有 snapshot 类型产生完整 schema：tokens/percent/remainingTokens/remainingRatio/tokensBeforeHandoff/tokensBeforeUrgentHandoff 为 number|null；contextWindow 为 number；estimated 固定 true；status 为 unknown/normal/prepare-handoff/urgent-handoff；两个 should* 为 boolean；handoffPath/note 为 string，所有字段 required。显式 `ContextUsageOutput = ContextUsageSnapshot & {note: string}`；snapshot.ts 导出 schema/type，并让成功 structuredContent 与现有 JSON content 表示的 payload 值相同，details 仍为不含 note 的旧 snapshot。类型与 Type schema 双向保持一致，不承诺 provider 精确 tokenizer，阈值/handoff 功能消息不改。
- [x] 参数也用公开 Type 构造，注册用 `ToolDefinition` 泛型或 `defineTool`，删除这些入口的 `as any` 掩盖；未知 context 不捏造快照，使用既有 unknown 结果。错误不按成功 schema 转换；不借此改变 profile 工具白名单。
- [x] 更新已有纯 fixture 断言的 label/metadata/result 通道，运行对应现有测试；没有直接 patch entry schema 覆盖则记限制，不新增专项 case。

**验收：**S/G 单工具职责清晰；成功 structuredContent/schema/显式类型一致，patch 错误无 structuredContent，不把 details 冒充程序通道；旧 model-facing content/details 值与安全规则保持。codemode 转换依据公开源码与既有 fixture，未运行真实 codemode/Host，缺直接 entry 覆盖明示。

## M05B：控制与调度工具的单工具提示

**Deps：**M00。
**WritePaths：**`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`（仅 tool metadata）、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts`、`packages/pi-subagents-enhanced/src/workspace/tool.ts`、`src/task-scheduler/adapter.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/task-scheduler-adapter.test.mjs`。
**Resources：**`enhanced-tool-metadata`、`scheduler`、`unit-runner`。
**契约：**仍 model-only，description 保精确参数与权威边界；只加可见性正确的能力摘要与单工具 when。

- [x] subagent 的 snippet 表达委派与控制；guideline 只说明要完整任务合同、启动与完成不同、不得用无权限工具替代。完整派发→决策→恢复→workspace 流程留 GLOBAL。
- [x] supervisor 的 guideline 说明针对实际 request 回复，不把 writeReply 提交当 child 已收到/消费/理解；workspace 指明按状态和 token 操作、coding 集成 child-owned，不复制整状态机。follow-up 已改为本侧提交≠投递/消费事实，主直接读取确认，membrane 91/91 通过。
- [x] scheduler 四工具补齐摘要与 when；保上游 spread 的 schema/S/G、model-only、create/delete UI 确认、持久化内容检查及隔离 stateHome。定时触发给模型的功能 prompt 不改为 UI-only。follow-up 已先保上游 guidelines 顺序再追加本仓规则，scheduler 21/21 通过。
- [x] 不给 model-only 工具新增 nested 入口，不用 annotations 替代确认；不改 RPC、model selection、title resume 映射或注册工具集。
- [x] 同步现有 tool factory/description 断言，运行既有 pure membrane 与 scheduler adapter 相关用例一次；无真实 scheduler clock/service/任务触发。

**验收：**原生 default system 能采集 S/G；缺失/隐藏的工具不被全局常驻手册强行推荐；权限不扩大。

## M06：child conversation 正确消费 renderer，而不是 ToolInfo

**Deps：**M00。
**WritePaths：**`packages/pi-subagents-enhanced/src/tui/tool-renderers.ts`、`packages/pi-subagents-enhanced/src/tui/native-conversation.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/extensions/custom-footer.ts`、`test/subagent-native-conversation.test.mjs`、`test/custom-footer-subagents.test.mjs`。
**Resources：**`enhanced-main-entry`、`child-preview`、`unit-runner`。
**契约：**`resolveToolRenderer(name)` 返回 `ToolRenderers | undefined`，绝不返回 ToolInfo；entry 和 custom message 保各自输入类型。

- [x] 从当前 `extensions/subagent-runtime.ts` 的 `createSubagentToolRenderers` 提取到**新建** `src/tui/tool-renderers.ts`，连同纯 `spawnStartingSummary`/显示 state key 及公开 TUI/compact-rendering 依赖。工厂返回既有 renderSubagentCall/renderSubagentResult/renderSupervisorRequest/renderControlNotice/renderSupervisorCall/renderSupervisorResult/renderSupervisorReplyEntry/renderCompletionNotification；不把 broker/required extension/tool definition/control 接线搬入 TUI。入口保 Host tool/message/entry 注册并消费该工厂，现有 named export 如需保调用合同只做入口绑定，不让 production 反向 import 入口。
- [x] custom-footer 给 preview 注入本 package 自有工具 renderer；原生工具从 public create*ToolDefinition 只取渲染字段，未知工具返回 undefined 让原生 fallback。**不借 package 引用根 compact feature 内部文件**，不访问私有 Host registry，不宣称取得全部 child 扩展 renderer。
- [x] custom entry 对本仓拥有的类型调用对应 EntryRenderer；未知 entry 用明确的显示 fallback（不把 JSON 临时 message 误称原生 entry parity），不新增回写 session。custom message 同理提供本仓有 owner 的 renderer。
- [x] 保 SessionManager.buildContextEntries/sessionEntryToContextMessages、安全 snapshot/O_NOFOLLOW/dev+ino/trustedRoots/compaction 分支。RPC mode 不安装 fullscreen overlay，以 `ctx.mode === "tui"` 而非只看 hasUI 判定终端组件；受支持 RPC dialog 逻辑不受此限制。
- [x] 保当前只读 viewport/字符串输出与 thinking 默认，不借此声称 MouseRegion 点击已恢复。保持 reply 工具完整正文、entry dim padding=1。
- [x] 更新既有注入测试以真实 ToolRenderers 合同驱动，运行两个既有纯组件文件一次；不打开用户 child 文件或真实 Option+O。

**验收：**接口误用消除、主/预览 renderer owner 清晰、安全边界不减；未知第三方显示能力如实受限。

## M07：保留原生 prompt，落实角色与偶发失败 resume 规则

**Deps：**M00。
**WritePaths：**`pi/AGENTS_GLOBAL.md`、`pi/agents/delegate.md`、`pi/agents/executor.md`、`pi/agents/reviewer.md`、`test/reviewer-agent.test.mjs`。
**Resources：**`agent-instructions`、`unit-runner`；额外前提为用户明确确认三 profile 的 `systemPromptMode: append`。
**契约：**角色正文在 system；单次 task 在 user；主治理与角色方法分离。SHARED 不新增工具流程。未获 append 确认不派发本任务，执行方式授权不替代该决策。

- [x] 三 profile 明确 `systemPromptMode: append`，使 Pi 原生 preamble/tools/rules 保留，角色正文作为 addendum；只改 mode 与已过期的 delegate description 中 TDD 字样，其余 models/thinking/tools/inheritance 元数据逐项保持。不能设置 inheritGlobal=true 或为拿指南扩大 active/tools。
- [x] 采用短角色正文：delegate 负责跨模块归因、方案取舍与获授权实现；executor 负责具体合同的范围可控实现、现场核对与验证；reviewer 负责只读对照真实源码/diff/产物/验收，发现格式为严重性、路径、证据、影响、建议。每份引用共通规范但不抄全部安全清单；不接管父 DAG、不新增委派、不自动写计划或真实业务验证。
- [x] GLOBAL 的多工具流程明确 list→选择角色→派发→处理 reply/steer→结果验收→受管 workspace 按状态处理；保首轮计划 reviewer 自动唯一一次、后续每轮用户授权、无次数上限，不复制工具完整参数手册。
- [x] 在 GLOBAL「生命周期」加入主管恢复规则：收到 runtime-failed，先按错误与现场判断；明确上游过载/暂时流中断且原 child 持久化 session、身份和执行合同仍有效时，**优先 `resume` 原 run，附非空的新指导，继续已有会话历史**。恢复前核对已完成改动、正在执行的工具/命令与剩余验收，不重放已完成步骤。没有工具副作用是最简单情形；已有合法写入不机械禁止 resume，但必须先核实并明确从停点继续。
- [x] 规则同时说明：resume 新 run 打开旧 child session，不是 live 进程原地继续；不恢复父会话全部 history；不可恢复/stopped/权限或身份失败/不明来源不是偶发 provider 故障。无法证明安全续跑就报告阻塞，不自动 fresh 重派、不改模型、不无限重试；同一故障恢复再次失败时重新决策，不建立 daemon。此规则不授权绕过写路径、用户审批或 API guard。
- [x] 同步既有角色测试：不再把正文出现“runtime”等字样本身当违规，改为验证配置仍在 frontmatter、角色不能授新权限；现有 case 内核对 append、无 TDD 默认流程、只读职责不丢。运行该纯文件一次；不调用模型比较调用频率。

**验收：**用户明确确认后，三份 mode 配置与其余 frontmatter 保持可静态/单测证明，工具流程归属正确，恢复规则不是模型 fallback。这里只证明配置事实与公开 prompt 分支依据，不证明实际模型行为等价或效果变好。用户未确认/拒绝 append 时保持原文件，由主会话先调整计划范围，不静默退回 replace。

## M08：apply_patch 纳入原生文件 mutation queue

**Deps：**M05A（消费明确的 patch result/data 契约，不改变成功/失败含义）。
**WritePaths：**`src/apply-patch/apply.ts`、`pi/extensions/apply-patch.ts`、`test/apply-patch-apply.test.mjs`。
**Resources：**`apply-patch`、`unit-runner`。
**契约：**仅 add/delete/不含 move 的 update hunk 的完整 read-modify-write 进入单路径原生队列；move 保持当前实现、不纳入队列保证。不声称全 patch/多路径/跨进程事务。

- [x] feature 通过可注入 `withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>` 依赖消费公开能力，入口从 Host 包根传入，不反向 import 入口。保 parser/fuzzy 寻址、原始文本与 M05A 结果契约；不把 Host import 藏进脚本或深层模块。
- [x] add 的 mkdir/write、delete 的 rm、不含 move 的 update 的 read/compute/write 全部放同一 hunk 的 queue callback，路径 key 交原生 API canonicalize；不能只锁 write。hunk 顺序保持。
- [x] move 明确沿用既有 read/write destination/rm source 分支，**不嵌套拿 source/target queue，不用 sequential 或新全局锁冒充双路径保护**。该分支仍与 native edit/write 存在未覆盖并发边界，交付必须明示。要扩到 move 先另行定义多路径 API/证明并获授权，不塞进本任务。
- [x] 同步既有 add/update/delete fixture 的依赖注入与结果断言，move fixture 仅证明旧业务行为未变，不能计为队列覆盖。运行该纯文件一次；不新增 race case，不把部分成功当整体成功。

**验收：**静态/fake 注入证明单路径完整操作进入公共 queue，原生 canonical queue 实现为同进程复用依据；move、整 patch 原子性、跨进程及真实并发均不在已验证保证内，保留业务语义和错误通道。

## M09：删除伪 whitelist 的重复 discovery，保声明排除与管理 CLI

**Deps：**M02（消费 `skills` selector 合并及退役名称排除）。
**WritePaths：**`pi/extensions/skill-whitelist.ts`、`src/skill-whitelist/extension.ts`（删除）、`scripts/doctor.ts`（仅删除旧入口必需断言）、`test/skill-whitelist-extension.test.mjs`、`test/doctor.test.mjs`；执行后发现的入口闭环追加 `scripts/pi-shell.zsh`、`test/pi-shell.test.mjs`（只移除普通入口的隐式 `--no-skills`，`pi-lite` 保显式禁用，不改真实 Host）。
**Resources：**`skills-discovery`、`unit-runner`。
**契约：**原生发现 `~/.agents/skills`、受信项目祖先 `.agents/skills` 和 `.pi/skills`；本仓 managed skill 校验/同步工具仍保留。

- [x] 删除仅返回 resources_discover.skillPaths 的入口及实现，不留 no-op/re-export facade；Doctor 不再要求该旧入口文件存在。`src/skill-whitelist/skill.ts`、sync CLI、managed symlink 校验不删除或改名泛化。
- [x] 分开核对两个产物：A）本仓不再额外返回 resources_discover.skillPaths，原生为本仓发现 owner；B）M02 selector 对其配置 scope 的自动发现根有排除效果。依据 package manager 的 `addAutoDiscoveredResources`/`isEnabledByOverrides` 和 resource loader 的 `extendResources`：后者追加的第三方 callback、CLI 显式路径、项目另一 scope 不能被用户模板字符串一概排除；不改第三方资源，不声称任何入口都无法发现退役技能。
- [x] 不删除用户技能文件。退役排除是声明资源策略，不是权限门禁；已有合成 loader fixture 若能证明 scoped 排除则记运行证据，否则仅静态源码依据。若连本仓声明 scope 的排除也无法成立，停止本任务并报告，不恢复手写 scanner 或宣称完成；不能把“旧 scanner 不返回”等同不可见。
- [x] 现有两 case 改为静态/原生 public loader 的**不启动 session**资源 fixture：用合成 HOME/项目验证声明根/排除规则；不扫描真实 `~/.agents/skills`，不调用模型或启动 Host。如需 SDK loader 运行已越出用户单测范围，则只做源码/配置契约核对，并标集合未经运行验证，不能绕禁令。
- [x] 运行允许的既有纯用例和 Doctor static fixture 一次；仍有 skipped 因本机真实技能目录为空的 case 应改 fixture，不靠 userdirs 取数据。
- [x] 闭合 shell 入口：`_pi_config_invoke` 不再隐式传 `--no-skills`，普通 pi/pi-inline/pi-full 使用原生资源发现；`pi-lite` 显式保 `--no-skills` 与两指定 skills。追加路径单独冻结非敏感 task-before，既有 fake physical CLI 用例仅同步参数、不新增 case。主核对13/13、exit0，14现有case中裸 pi 非 bypass case明确排除。未启动真实 Pi/Host、未改变 owner/工具/trust 策略；用户显式 `--no-skills` 原样转发。

**验收：**本仓额外 scanner 消失，native discovery 唯一 owner；声明 scope 的排除有源码依据或既有 fixture 支持，两者证据分列，跨 scope/第三方 callback 集合等价不承诺。managed skill 工程规范保留，project trust 不提前绕过。

## M10：进度通知只进 UI，资源按 session 生命周期管理

**Deps：**M00。
**WritePaths：**`src/async-progress/index.ts`、`pi/extensions/async-progress-watcher.ts`、`test/async-progress-watcher.test.mjs`。
**Resources：**`async-progress`、`unit-runner`。
**契约：**普通进度不是模型上下文；继续使用原始事件的独立显示投影，不添加 session/custom message。

- [x] 从**现有** `pi/extensions/async-progress-watcher.ts` 提取 parser/tail/watch 到**新建** `src/async-progress/index.ts`，入口绑定公开 UI/lifecycle；更新已有测试导入。保现有 offset 与 watch+fallback，不为 delivered/空闲系统通知新增 watcher，不承诺当前 tail 已解决所有分片/截断问题。
- [x] 普通进度唯一采用 `ctx.ui.setStatus("async-progress", text)`：属于 TUI-only 的 feature-owned 聚合状态 key，非 TUI no-op，不改成 RPC toast。保多个 run 的最新摘要 map，结束一个 run 只移除该项；全部结束清 key。删除 `sendMessage(display:true,triggerTurn:false)`，不 appendEntry、不添加模型消息。主验收发现 RPC setStatus 并非 no-op；follow-up 已在入口以 `ctx.mode !== "tui"` cleanup/return 门控，三个 SHA 与最终报告匹配。未进行真实 RPC/TUI 验证。
- [x] 每次 session_start（含 reload/new/resume/fork）先幂等 cleanup 前一代 watcher/timer/状态/bus subscription，再绑定当代 started/complete 监听，保存 `pi.events.on` 返回的 unsubscribe。shutdown 幂等调用同一 cleanup；入口工厂不启动 watch/timer。异步 tick/回调只在 generation 匹配且未 stopped 时更新当前 UI，不让已在途的旧 tick 清理后复写状态。不删除其他领域 durable shutdown debt。
- [x] context-usage 的 handoff 消息是模型功能提醒，不迁成 UI；上游 async completion 也不重发或加第二 sender。
- [x] 同步已有 parser/tail fixture 与导入路径；只跑现有不等待6秒 timer 的纯 case，watch 真实 timer 用例不执行、不计通过。记录资源清理只能由静态结构与已有 fake lifecycle 断言支持，非真实 Host 验证。

**验收：**普通进度输出只走指定 UI status key，不入模型/session；资源注销、key 清理与 generation 防护由源码及既有 fake lifecycle 支持。真实 UI 可见性、实际 reload 运行与 timer 场景未验证，不能以静态结构宣称全场景无残留。

## M11：公开边界保留账本与 delivered 阻塞契约

**Deps：**M00。
**WritePaths：**`docs/plans/records/2026-10-10-runtime-modernization/public-boundaries.md`。
**Resources：**none。
**Files：**仅 Create 文档，不修改协议或安装包。
**契约：**明确哪些是现代化可简化机械代码，哪些是本仓不可替代的权威事实；delivered 不能被写成已完成。

- [x] 根据实际根 package exports/declarations 复核生命周期报告中错误的缺包路径，保留精确出处。记录当前已有 unsubscribe/required/RPC/extensionBindings，未发现重复机械代码则不强造重构任务。
- [x] 保留 shell early guard、public SessionManager.list/listAll、physical peers、root broker/authority/lease/grant/processBirth、terminal proof、integration queue、supervisor correlation/consumption、跨 reload debt。公共 event 成功不等这些事实成立。
- [x] 写出 delivered 事件最小需求：现有 upstream tail 转发 `runId/requestId/index/ts/late/deliveryStatus/message` 为公开 bus，带父 session 归属；TUI 仅 `ui.notify(info)`，按 run/request/index 去重与清理，title display lookup，不加模型消息。没有转发能力时明确 **阻塞、未实现**。
- [x] 不提交上游 issue/PR、不打补丁/node_modules，不加轮询/私有 IPC。是否推动上游属于用户另行决策；本计划完成不要求本地虚构 delivered 可见性。
- [x] 记录推迟项：GLOBAL/SHARED structured sections（child forced hook 顺序需证据）、原生 Skill 外观、ScrollView/组件树交互、Codex-only 代理作用域、通用 SettingsManager 替换。无已证等价就保持现有实现，不能以“完整计划”强行删除。

**验收：**可实施与保留/阻塞边界完整，每项明确处理结论，不把观察回执当 proof。

## M12：一次聚焦汇总验收与交付

**Deps：**直接前驱为 M01、M04、M05B、M06、M07、M08、M09、M10、M11；**完整验收前置闭包为 M00、M01、M02、M03、M04、M05A、M05B、M06、M07、M08、M09、M10、M11**。ready-set 必须确认全部 13 节点完成，已集成才可消费；不省略 M02/M03/M05A/M00 的验收。
**WritePaths：**`docs/plans/records/2026-10-10-runtime-modernization/acceptance.md`、`README.md`、`packages/pi-subagents-enhanced/README.md`、`test/joint-upgrade-feature.test.mjs`（只同步被 M01/M09 删除的 handler/scanner 消费；不新增 case、不运行其真实流程）。本计划状态仅由本会话更新。
**Resources：**`unit-runner`（单测、listFilesOnly、root/enhanced noEmit 共用容量 1）。
**契约：**每项 `{scope,files,publicApi,evidence,limitations}`；通过的行为与未验证能力分开。

- [x] 对照 M00 before/after 检查 task scope、没有新 production deep import/旧 facade、新 tool 权限、真实配置写入或 raw 展示改写；确认所有规则和原生接口字段实际存在。
- [x] 同步既有 `test/joint-upgrade-feature.test.mjs` 的删除项消费者：移除对已删 skill scanner 的 import/调用，旧 reminder case 改为没有 `tool_result` 注入的真实原始合同，skills case 改为 public resource discovery/scoped 排除合同，不保留 facade。此为执行中发现的必要 fixture 同步（此前 M01 child 未获越界授权，现在主会话明确纳入 M12）；新增路径单独冻结 task-before。其真实工具/CLI/provider 场景禁止运行，仅静态/语法核对，不将未经运行的更新计为通过，不增加 case。
- [x] 收集各分支既有 pure unit 日志。只补一次交叉最小组：`compact-tools-extension`、`compact-tools-error-visibility`、`bash-cwd-extension`、`subagent-native-conversation`、`subagent-compact-rendering`、`reviewer-agent`、`ensure-pi-settings`；实际已在组合后执行且文件未变的日志可复用，不复制全矩阵。纯度或60秒预算不满足时明确排除，不包装成0用例通过。
- [x] 一次 `tsc --listFilesOnly -p tsconfig.json` 证明根入口包含；一次 root 和一次 enhanced `tsc --noEmit`（当前 Node），必要 task 已覆盖且其后 source 未变时复用最后日志。静态检查不等运行验收，不重复最低 Node 长矩阵。
- [x] 更新 README 的当前版本与职责：compact 仅显示；原生 metadata/loadout；GLOBAL/角色流程与 SHARED 共同规范；失败优先主管 resume 但不自动换模；template本机生成边界；delivered 公开事件仍阻塞。历史升级审计/冻结 NO-GO 文档不改写成今天结论。
- [x] 交付真实计数、排除项目、直接覆盖不足；特别列明 active 集实际生效、project trust/真实 shell、模型 append 行为、skills 跨 scope/第三方追加、UI 可见性未验证，patch move 未纳入 queue，private skill patch保留、预览互动/代理/delivered边界。提示 fresh Host 生效，无 commit/push/真实流程。成果 review 须用户另外授权，不复用首轮计划 reviewer 例外。

**验收：**所有核心任务完成且证据如实，阻塞项明示而非假通过；无活跃遗留资源/任务，无机器或凭据内容进入文档。**主会话已核对 M12 acceptance、最终四文件哈希、M06 类型修正后 enhanced noEmit、M09 shell fake CLI 验收及全部 checkbox，接受本计划在授权验证范围内完成。**

## 停止与回退

- 新 API 不存在、版本/路径与证据矛盾、需要写路径外文件、验收不可同时满足时，停止相关操作联系主管；不通过 private deep import、注册隐藏客户端或扩大工具集合补救。
- partial 实施不能用全文件 checkout/stash 回退。只在 task-before 确认本任务范围内撤销自己的精确改动；并发产生的合法改动要保留。实际改变配置/Host 是另行授权，不在回退中自动执行。
- 用户已授权 Subagent-Driven 与 append，计划进入执行；checkbox 只由主会话在核对实际产物/日志后更新，dispatch/completion 回执不等于验收完成。成果 review 仍须用户另外授权。
