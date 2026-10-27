# Subagent 名册注入 C5 验证记录

日期：2026-10-27。结论：本轮在既有 261 项回归之外，新增并实际执行唯一行为测试文件 `test/subagent-agent-catalog.test.mjs`（8 项，0 skip），用真实 Pi 1.4 SDK 会话与真实 admission 的**首请求/重复请求/派发/compact/resume/双 Host/child 形态**请求捕获补齐 F1–F7；本轮合计执行 **269 项检查，269 passed、0 failed、0 skipped、0 cancelled**。F1–F7 全部取得当前候选的实际请求证据，逐项剩余边界在矩阵中列明，未把未测项写成通过。

本报告对应 root dirty 候选，HEAD 仍为 `8bc4a88f43550c342fbe3318ca295e93f3eb850c`，不是提交产物。当前父/child 会话仍加载原有模块；本轮没有全局 reload、安装、发布、提交或切换当前会话模型。计划复选框由父会话维护。

## 候选与变更边界

合同 `dispatch-c65114fb`（前序合同 `dispatch-5df65ee8`，延续 run `7fa29613-ac1c-47a3-95ac-ec7e3875fdbf`）。持久工具证据位于 `var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7/7fa29613-ac1c-47a3-95ac-ec7e3875fdbf/run-0/session.jsonl`；恢复时只提取该文件中的工具名、参数和错误标记，随后补读首审及 package AGENTS。临时 provider 容量故障没有被当作验证失败，也未建立重试循环。

本轮（F1–F7 行为验收）只写两个声明路径：

- `test/subagent-agent-catalog.test.mjs`（新增，641 行，8 个 `test(...)`）：复用 `test/helpers/joint-upgrade-session.mjs` 的真实 SDK 会话与 `test/fixtures/joint-upgrade/provider-capture.mjs` 的合成 provider 定位，不新建 harness、provider 或 fixture 框架。
- 本报告。

前序 C5 轮次写入的五个声明路径（现有证据的基础）保持原样：

- `test/subagent-runtime-membrane.test.mjs`：移除旧 roster 枚举与 list→roster 映射；明确 fresh 不注册 roster；无 supervisorAdapter 时数量从 11 改为 10，保留六个 subagent 工具的 schema 检查。原 C3 fixture/SessionManager 适配与 steer 的九行字段诊断断言完整保留。
- `test/subagent-model-selection.integration.mjs`：原两个 list 案例改为调用已经存在的 `runtime.tool.execute(..., { action: "list" }, ...)` 内部诊断入口，并明确断言 roster 不注册；保留 repository admission、全 description、metadata 投影和无 RPC/registry 副作用要求。
- `test/subagent-dispatch-extension.test.ts`：移除旧 list→roster 映射，在原注册 recorder 内拒绝 roster 注册，继续执行所有原派发/身份/授权案例。
- `test/pi-runtime.integration.mjs`：当前精确工具集合从 14 改为 13；真实隔离 Host 内分别断言 roster 不在 registered、active、callable 集合。
- `test/subagent-agent-catalog.test.mjs` 之外的报告内容。

没有删减准入、身份、权限、steer 或 schema 标准。内部 list 诊断与历史 renderer 是现有真实消费者，未为旧 mock 添加 production fallback。`test/helpers/system-prompt-fixture.mjs` 本轮**未**改动（它此前的 C1 适配已够用），当前 SHA-256 为 `6e944bc5bd7fa769f72f6373d3a2b979daf3242a44b13059d45a62124ca1232a`。

相对 HEAD，四份既有测试 diff 仍为：membrane `+39/-23`（包含承接的 C3/steer dirty，并非全由 C5 新增）、model-selection `+9/-8`、dispatch-extension `+2/-2`、pi-runtime `+4/-1`。新增文件不计入既有 diff。

最终候选主要文件 SHA-256（用于识别未提交内容，不是运行行为证明）：

| 文件 | SHA-256 |
| --- | --- |
| `src/agents-global/index.ts` | `8e369619b9b8e9dc6846c75c8fea7898e4e7716b078b823a507d4385030fb965` |
| `src/agents-shared/index.ts` | `a7c60a1890a43f4df7d6f66abbff3217beb9ca385012cf2c7b5b90b3ac153dcc` |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/agent-catalog.ts` | `fbc475f09d3e4f20fe5708ac5be0f506d692c82a0fee1edb81677989f213cb2a` |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | `6c33a7a08b672a3be1cca63c6ae9ba546e915d6208eab42a30bf306ee93c01a2` |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts` | `cf159aaaaf84259f0d905864a95f842caa0bd461eae447edea86026235190132` |
| `pi/AGENTS_GLOBAL.md` | `dab5fc5906120188b8bc3089c3c366c9f648073596478a7807116ad718c104dc` |
| `test/subagent-runtime-membrane.test.mjs` | `f3cbe2153c6dc757be3bff14d52cb4e48b70e35e90301a0927bcecabe6317787` |
| `test/subagent-model-selection.integration.mjs` | `82bd2a43d1b28df6ea14f90fd25ac22a4baa455dc3f17cb073106c63a987d061` |
| `test/subagent-dispatch-extension.test.ts` | `a4eb023fa7d9c3232f882a00d5b62e121baf2c3f75714a0d1679eff1fe9c273a` |
| `test/pi-runtime.integration.mjs` | `8a1312b53263105e3608a3fa77fca1af70b36dc8caf73922957f347de6095f81` |
| `test/system-prompt-override-policy.test.mjs` | `6153c6535f3dfc5ded5fadc8ff1b509259723d848929878ce28e5f660c6b871e` |
| `test/subagent-agent-catalog.test.mjs`（本轮新增） | `adf975ee362be6097495e9ab11e25afac71e6bc4e325e8350490c2702364ee2f` |

来源异常记录（如实标注，不加预防性改动）：`operation-tools.ts` 在当前报告起草后被外部改动，mtime `2026-10-27 20:21:04`，晚于前序报告写入时间 18:24。实际 diff 内容是 steer 模型可见定位字段收窄（`STEER_TARGET_FIELDS`，删除 `dir`）与该任务注释，**不含** catalog/roster 逻辑变化；roster descriptor/注册仍处于退役状态。因此该文件 SHA-256 由上表前序值 `fe670ca1…` 变为 `cf159aaa…`。本执行者未修改该文件；本轮全部证据基于当前内容执行，`test/subagent-operation-tools.test.mjs`（13 项）与 `test/subagent-dispatch-extension.test.ts`（36 项）在改动后仍全绿。

## 新增行为验收的观测边界

本轮唯一新测试不手工拼 system prompt，也不把 helper 的最终字符串当请求证据：

- **真实编排**：`openJointSession()` 使用本仓物理 Pi 1.4（`@earendil-works/pi-coding-agent@1.4.0`）创建 `SettingsManager`/`DefaultResourceLoader`/`ModelRuntime`/`SessionManager`/`AgentSession`，`bindExtensions({mode:'print'})` 真实执行 `session_start` 与 `before_agent_start` 链路；GLOBAL/SHARED 用生产 factory 读取仓库真实 `pi/AGENTS_GLOBAL.md`、`pi/AGENTS_SHARED.md`。
- **真实 admission**：`registerBuiltinAgentsViaEvents()` 解析仓库 `pi/agents/{delegate,executor,reviewer}.md`，同一实例既供 catalog 初始化，也供真实派发 discovery（测试只在外部包裹计数，未替换行为）。
- **请求捕获**：合成 provider 只替代远端响应。测试通过公开 `ModelRuntime.getRegisteredProviderConfig/getRegisteredProviderConfig(...)+registerProvider` 在同一 `streamSimple` 入口做只读包装，捕获真实 `normalizeContext()` 之后的请求 transcript（`system` 消息带 `sections`/`toolsAdded`/`toolsRemoved`），随后原样委托既有合成 provider。有效 system prompt 用 pi-ai 公开 `getCurrentSystemMessage/getCurrentSystemPrompt/getCurrentTools` 重放，与 provider 侧渲染同一套重放逻辑。
- **不做什么**：不读取本机 models/auth/credential；不发起真实付费或 `127.0.0.1` 以外请求；不伪造 `before_agent_start`/compaction/checkpoint；不改写历史；不 patch SDK 内部；不新增依赖或 fixture 框架。

## 副作用与环境审计

实际 Node 为 `v26.8.1`，仓库最低要求仍为 `>=22.19.0`。`npm run typecheck` 消费现有 TypeScript 7.0.2 根/package 类型配置；未安装依赖。

启动前只检查 allowlist 环境：`PI_REAL_BIN` 已设为本仓 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`；`PI_TEST_CODING_AGENT_ROOT`、`NODE_OPTIONS` 未设；本执行进程带 `PI_SUBAGENT_CHILD`、`PI_SUBAGENT_PARENT_SESSION`、`PI_CODING_AGENT_DIR`、`PI_CODING_WORKSPACE_DIR`。未读取本机 models/auth、credential、私有 authority 或任意全量环境。

| 检查入口 | 已审计副作用与隔离 |
| --- | --- |
| 新增 `test/subagent-agent-catalog.test.mjs` | 每个 Host 用 `mkdtemp` 合成 `agentDir`/`cwd`（含指向仓内权威 `pi/extensions/agents-shared.ts` 的既有 symlink），`SettingsManager.inMemory`、`modelsPath:null`、`allowModelNetwork:false`；合成 provider 不联网。resume 场景在同一临时目录内 `SessionManager.open()` 打开本测试自己写入的 session 文件；全部临时目录由 `t.after`/显式 `rm` 清理（本轮实测无残留）。F5 只通过 `settingsManager.applyOverrides({compaction:{keepRecentTokens:1}})` 调小阈值，`session.compact()` 代码路径未改动。RPC 为既有形状的最小替身（`ping`/`spawn`/`dispose`），只替代子进程，不替代 admission。 |
| prompt policy / helper | 真实 ExtensionRunner 调用生产 GLOBAL/SHARED handler；scanner 只读枚举生产源码；合成文本仅落既有临时目录并清理。无模型请求。 |
| membrane | RPC、workspace、broker、control plane 等由既有 DI/stub 驱动；临时 package closure 拷贝只使用本机已安装 upstream，无 npm；持久 mailbox/trace/required-child 场景使用 mkdtemp 并由既有 finally/after 清理。 |
| operation-tools / guidance / compact-rendering | 本地 factory、schema、renderer、源码/规范断言，不启动真实 child。compact-rendering 是 TUI 渲染回归，名称中的 compact 不代表 session compaction。 |
| model-selection / dispatch-extension | 原有 stub RPC/discovery/workspace/authority registrar，现有 upstream timeout resolver 导入与受控 timer（finally 清除）；不分配真实 worktree、不调用外部模型。 |
| joint-upgrade-model-only | 既有 `openJointSession` 使用本仓真实 SDK、临时 agent/cwd、合成 provider 和真实 codemode 管线；模型网络禁用，无真实 provider。临时共享入口为现有权威 binding 的 symlink。该场景继承 child 标记，并非 fresh main/child 双 Host 名册证明。 |
| pi-runtime Host 注册 | `createIsolatedHostRepository()` 创建独立临时 Git common-dir（只 init，无 commit），临时 agent/session/state；测试局部清除并恢复 child/父 session/broker/workspace 标记；ModelRuntime `modelsPath:null`、`allowModelNetwork:false`、`refreshOnCreate:false`，不发 prompt。shutdown/dispose 后删除临时 root。 |
| pi-runtime model mutation / fallback | 全部模型/auth/settings 文件由现有案例写在 mkdtemp 内，值为合成 placeholder；不读取本机配置。fallback 只访问 `127.0.0.1` 随机端口 HEAD，不向外转发；finally 关闭 server、dispose session、删除临时目录。 |
| pi-runtime RPC | `PI_REAL_BIN` 实际可用，故没有 skip。既有案例以受限 env、临时 HOME/agent/session 运行 zsh wrapper，`--mode rpc --no-session --offline`，只发送 `get_commands`。non-interactive 走已有 bypass，不进入 owner registry 私有读取/写入分支；finally 清理临时资源。 |
| publishable pinned package contract | 仅用 test-name-pattern 执行 manifest/lock 元数据案例，不调用同文件其他场景的 preparedPackageFixture/setup/install/verify/npm pack。未变 export，未运行网络 npm pack。 |

`unit-runner` 和 `catalog-host-acceptance` 在本合同内独占；所有测试命令串行（合并套件与新增文件均带 `--test-concurrency=1`）。没有新开委派，没有触碰旧 workspace `183f86ee...`，没有应用 footer 补丁或变更 Goal、计划、用户 Playwright/writing-plans dirty，也没有触碰并发的 `src/background-activity/*`、`test/background-activity-*`、`docs/investigations/*` 收尾路径。

## 命令与实际结果

以下为本候选上的实际工具回执；成功命令 exit 0，所有 test 统计中 cancelled/todo 均为 0。

| 编号 | 实际命令 | exit | 实际统计/输出 |
| --- | --- | --- | --- |
| V1 | `npm run typecheck` | 0 | 根 `tsc --noEmit -p tsconfig.json` 与 package `tsc --noEmit -p tsconfig.json` 均通过；不是仅 type-stripping。 |
| V2 | `node --test test/system-prompt-override-policy.test.mjs` | 0 | 32 tests / 32 pass / 0 fail / 0 skip；1079.342 ms。 |
| V3 | `node --test --test-concurrency=1 test/subagent-runtime-membrane.test.mjs` | 0 | 112 tests / 112 pass / 0 fail / 0 skip；1084.228 ms。 |
| V4 | `node --test --test-concurrency=1 test/subagent-operation-tools.test.mjs test/operation-guidance-contract.test.mjs test/joint-upgrade-model-only.test.mjs test/subagent-compact-rendering.test.mjs test/subagent-model-selection.integration.mjs test/subagent-dispatch-extension.test.ts` | 0 | 111 tests / 111 pass / 0 fail / 0 skip；2117.769 ms。 |
| V5 | `node --test --test-concurrency=1 --test-name-pattern='configured enhanced local package registers\|installed Pi SessionManager preserves\|real Pi Host model mutation\|real Pi Host session_start provider fallback\|real Pi RPC without wrapper ownership' test/pi-runtime.integration.mjs` | 0 | 5 tests / 5 pass / 0 fail / 0 skip；1856.819 ms。该文件五个既有案例全部实际执行。 |
| V6 | `node --test --test-name-pattern='publishable pinned package contract' test/pi-subagents-enhanced-package.test.mjs` | 0 | 1 test / 1 pass / 0 fail / 0 skip；70.461 ms。 |
| V7 | `node --test --test-concurrency=1 test/subagent-agent-catalog.test.mjs` | 0 | 8 tests / 8 pass / 0 fail / 0 skip / 0 cancelled / 0 todo；977.220 ms。 |
| V8 | 同一命令再执行三次（稳定性复跑） | 0 | 每次 8/8、0 fail、0 skip、0 cancelled、0 todo；964.553 / 989.292 / 939.121 ms，统计一致，非 flaky。 |
| V9 | `git diff --check` | 0 | 无 whitespace 诊断。 |
| V10 | `git diff --cached --name-only` | 0 | 空输出，无 staged files。 |
| V11 | 只读 formatter 字节统计（由新增测试的 `t.diagnostic` 输出） | 0 | 正文 714 UTF-8 bytes / 392 code points；SHA-256 与前序实测一致。 |
| V12 | 只读 Python：HEAD/current test 声明计数、候选 SHA-256、已审计临时前缀/mtime、staged 查询 | 0 | 声明数不变；临时资源已清理；仅保留两份 10-16 旧 joint-session 目录，未动它们。 |

V2–V6 合计 **261/261**，复现前序报告的全绿基线；V7（8 项）为本轮新增证据。本轮总计 **269/269、0 skip**。name-pattern 在 Node 26 输出中只统计选中案例，没有把未选案例充作 passed；没有依赖环境 skip。

## 新增测试逐项证据（V7）

| 用例 | 覆盖终态 | 真实观测（断言事实） |
| --- | --- | --- |
| `F1/F3/F7 首个真实请求…` | F1、F3、F7 | 首个模型请求（`requests[0]`，provider `joint-synthetic/fixture`）的 system prompt 中 `<advertised_subagents>` 与 `</advertised_subagents>` 各出现 1 次；section 文本逐字节等于 `formatAgentCatalog(projectAgentCatalog(同代 admission agents))`；反解后的条目与 admission 的 name/完整 description 精确相等（顺序 delegate、executor、reviewer）；首请求前 admission 只被查询 1 次；请求内无 `subagent_roster` 调用，roster 也不在 registered/active/callable 集合。同时断言 `pi_global_instructions`、`pi_shared_instructions`、`preamble/tools/rules/docs` 与第三方 extension 写入的 canary section 共存，GLOBAL/SHARED 正文等于仓库真实规范文件快照，main scope 无 `pi_child_execution_boundaries`，工具清单含 `- subagent_start:`，工具 guideline canary 与第三方 canary 均未被遮蔽。 |
| `F2/F7 同 session 重复请求…` | F2、F7 | 第二轮请求的 section 与第一轮逐字节相同；纯请求期间 catalog discovery 计数恒为 1；一次真实 `subagent_start` 执行路径使用同一 `discoverAgents` 追加 1 次 admission 查询（`calls[1].cwd === session cwd`），而 catalog 初始化计数不变，派发后 section 仍相同；`session_shutdown` 入口后下一请求的 section 被 `null` delta 撤回、GLOBAL/SHARED 保留、计数不再增长。 |
| `F4/F2 含旧 roster declaration 的历史会话 resume…` | F4、F2 | 历史会话的 transcript `toolsAdded` 真实包含 `subagent_roster`（active 也含）；用新 resource loadout（不含该 factory）与 `SessionManager.open()` resume 后，首请求 system delta 的 `toolsRemoved` 恰为 `["subagent_roster"]`；重放后的 tool loadout、registered/active/callable 三集合均无 roster；resume 触发 catalog 新 generation（discovery 计数 +1），section 与同代 admission 精确相符且唯一，GLOBAL/SHARED 保留。 |
| `F5 真实 compact…` | F5 | `session.compact()`（非 `appendCompaction` 拼装）写入 compaction entry，其 `systemMessage.sections.advertised_subagents` 与压缩前请求逐字节相同，且含 `pi_global_instructions`/`pi_shared_instructions`；compact 不重新初始化 catalog；下一请求 system prompt 中 `advertised_subagents`、`pi_global_instructions`、`pi_shared_instructions`、`rules`、`tools` 各出现 1 次；user 普通消息恰为 compaction summary 与新提示 2 条，压缩前两轮文本不再重复保留。 |
| `F2 第二个 Host 与不同 cwd…` | F2 | 两个独立 Host（不同临时 cwd、不同 `SessionManager`）各只初始化自己的 catalog（各 1 次），section 分别等于各自 admission 的 formatter 输出；第二个 Host 关闭后其请求不再发布名册，而第一个 Host 的下一请求仍为同一文本、计数仍为 1（无跨 Host 缓存与失效传播）。 |
| `F6 fresh child scope…` | F6 | child 形态 session 的请求 sections 只有 `pi_shared_instructions` 与 `pi_child_execution_boundaries`；无 `pi_global_instructions`、无 `advertised_subagents`；边界正文含来源、`不得新增委派`、`contact_supervisor`；`subagent_start`/`subagent_run_*`/`subagent_supervisor`/`subagent_integration`/`managed_workspace_*` 均未注册且非 active。 |
| `F6 start 不可用或 admission 未就绪…` | F6 | `setActiveToolsByName` 去掉 `subagent_start` 后，下一请求 `advertised_subagents` 被 `null` delta 撤回（撤回项恰为自有 key），GLOBAL/SHARED 保留，计数不变；恢复 `subagent_start` 后名册回归同一文本。admission 抛 `AGENT_ADMISSION_UNAVAILABLE` 时，`session_start` 记录该扩展错误，请求不发布名册，且 system prompt 中 `<agent name=` 出现 0 次（无硬编码角色兜底），GLOBAL/SHARED 仍在。 |
| `F2/F7 名册 module…` | F2、F7 | 投影按 canonical name 排序、只保留 `name/description`、返回新对象并保留 description 原文（含制表符/换行）；formatter 编码 XML 特殊字符并清理终端控制符；同代重复 `initialize` 不重复读取；cwd/session 变化即新 generation，旧代 ctx 的 apply 不发布当前代名册；`selectedTools` 缺 `subagent_start` 时删除自有 key；`invalidate`/`dispose`（幂等）后不再读取也不再发布；非 `repository-configured` 初始化 reject 并保持 unavailable。 |

## F1–F7 证据矩阵

| 条件 | 状态 | 本轮实际证据 | 剩余边界（如实保留） |
| --- | --- | --- | --- |
| F1 第一个模型请求含同代名册 | **passed** | V7 用例 1：真实 SDK 首请求捕获，`<advertised_subagents>` 唯一，条目/完整 description 与同代 admission 精确相等，首请求前只查询 1 次 admission，未先调用 roster。 | 无。名册文本的 token/字节成本归 F7，不作为 F1 结论。 |
| F2 按生命周期更新且请求内稳定 | **passed** | V7 用例 1/2/3/5/8：同 session 两请求逐字节稳定且 catalog 只初始化 1 次；真实派发入口追加 1 次独立 admission 查询（计数分离）；resume 与新 Host/不同 cwd 各建新代；closing 撤回；两个 Host 无跨实例缓存。 | “reload”以**新 runtime 实例**（resume/新 Host）等价覆盖，未在真实 Host 进程内触发一次 reload；两个 Host 是同进程内两个独立 SDK Host 实例，不是两个 OS 进程。 |
| F3 GLOBAL/SHARED/名册组合无完整 override 遮蔽 | **passed** | V7 用例 1：三个自有 section 与 preamble/tools/rules/docs、第三方 canary section 在同一真实请求共存；工具清单与两条 guideline canary 未被遮蔽；GLOBAL/SHARED 正文等于仓库真实文件快照。V2 32/32 提供两种 handler 顺序、main/child scope、缺文件/input 门禁与 AST 默认拒绝。 | 外部 extension 显式设置完整 `forceSystemPrompt` 的组合仍不在默认自有 loadout 通过证据内；未通过删除他人 override 达成“通过”。 |
| F4 工具面与规范同步退役 roster、历史可读 | **passed** | V7 用例 3：含旧 roster declaration 的真实历史会话 resume 后首请求 `toolsRemoved` 恰为 `["subagent_roster"]`，三集合无 roster，当前名册同代重建。V3/V4/V5/V6 各自覆盖注册面、schema、真实 Host 三集合与历史 renderer 26 项回归。 | fork 行为仍只由历史渲染回归与“不改写历史”的代码事实覆盖，未做 fork 请求级验证。 |
| F5 compact 后名册和指令可恢复 | **passed** | V7 用例 4：真实 `session.compact()` 的 compaction entry `systemMessage.sections` 保留当前三个 section；下一请求仍有名册与 GLOBAL/SHARED 且各 tag 唯一；普通 user 消息只有 summary 与新提示。 | 摘要由合成 provider 生成（`done`），未接真实摘要模型；这不影响 section/checkpoint 判据，但摘要质量不属本项证据。 |
| F6 派发 authority 与 child 边界不回归 | **passed** | V7 用例 6/7：fresh child 形态请求只有 SHARED 与 child 边界、无 GLOBAL/名册/父级工具；start 不可用时名册被 `null` delta 撤回并可恢复；admission 未就绪时不发布名册且无硬编码兜底。V3 112/112（owner/runtime/steer/workspace/shutdown/reload/required-child fail-closed）与 V4 111 项（admission/model/workspace/authorization 合同）保持。 | child 场景是**合成 child 形态 session**（真实 SHARED factory + scope=child + 无根扩展），不是由真实 dispatch 派生的 child 子进程；child 进程级工具白名单由既有 membrane/pi-runtime 案例覆盖，本轮未重复派发真实 child。 |
| F7 成本和交付证据明确 | **passed** | V1 类型检查；V2–V7 共 269 项回归全绿且无 skip；V11 字节与 SHA-256；V7 用例 2 的 catalog/dispatch 计数分离；无新扫描/进程/依赖（manifest 未变）。 | tokenizer token、provider usage、cache 命中与网络字节/延迟**未测**，不报告估算值也不承诺收益；稳定 section 是否减少传输未证明。 |

没有把任何未测项写成通过：上表每项的“剩余边界”就是本轮证据的真实覆盖上限。计划复选框与整体验收结论由父会话依据本矩阵维护。

## 成本实测与估计

本轮成本观测全部来自真实请求/真实 formatter，没有估算 token：

| 对象 | 实测值 |
| --- | --- |
| delegate description | 81 UTF-8 bytes |
| executor description | 57 UTF-8 bytes |
| reviewer description | 183 UTF-8 bytes |
| formatter 正文 | 392 Unicode code points，**714 UTF-8 bytes**（本次断言未漂移） |
| 正文 SHA-256 | `6176a39ea8b68fd28bc3574f6715b0bae1ea150bba6bfeb1602999e57afff02a`（与前序实测一致） |
| 首个真实请求中的 `<advertised_subagents>` section | **761 UTF-8 bytes**（714 + SDK 外层 tag 与换行） |
| 首个真实请求的 system prompt（含目录/docs/rules/GLOBAL/SHARED） | **25543 UTF-8 bytes**（合成 cwd 与最小 loadout 下的整段提示） |
| catalog snapshot 初始化计数 | 1/generation（同 session 重复请求保持 1；resume/新 Host 各 1） |
| 真实派发 admission 查询计数 | 每次派发 +1（本轮用例 2 观测到独立 +1，未与 catalog 计数混算） |
| 实际 tokenizer/provider usage/cache/延迟 | **未测**，不报告估算 token 或缓存命中 |

源码可推导投影排序 O(n log n)、文本格式化随 description 总长度增长，apply 只做内存 identity/`selectedTools` 检查并设置自有 section；这是代码审查结论，未做 benchmark。真实 dispatch 仍逐次重查准入；stable section 可能减少 SDK transcript delta，但本轮没有证明减少整段请求传输、token 或费用。

## 资源清理、保留现场与下一步边界

所有命令已正常 terminal 返回，没有超时/取消。既有 Host 入口执行 session_shutdown/dispose，loopback server 执行 close，temporary repository/agent/session/mailbox/trace 走既有 finally/after。新增测试的两个 resume/双 Host 场景显式 `rm` 自己的临时目录，实测执行前后 `joint-session-*` 目录数不变；本轮排查中由临时探针脚本产生的 2 个 20:40/20:41 目录与 `/tmp/roster-resume-*` 已按“自建资源自清”删除。`joint-session-pngOoh`、`joint-session-ZDwJg9` 两目录的 mtime/ctime 均为 2026-10-16，早于本轮，保留原样，未访问其 session/auth 内容。

开始/结束 `git status --short` 保留了 production C1–C4、resume PID binding、steer 修复、detail 初选、background-activity 与用户其他 dirty；本轮新增只有 `test/subagent-agent-catalog.test.mjs`（untracked）与本报告。`git diff --cached --name-only` 空输出；未 stage/commit/stash/reset，未执行 raw git worktree、真实 provider 或权限放宽。

在现有证据边界内已无独立待跑事项。若需要进一步缩小“剩余边界”，最小增量为：真实 Host 进程内 reload 一次、真实 dispatch 派生的 child 子进程首请求、以及接入真实 tokenizer/usage 的字节与缓存观测；这些都需要新的具体授权，本轮未执行，也不以 skip 或估算值替代。
