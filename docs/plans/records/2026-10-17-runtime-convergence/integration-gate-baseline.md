# 全量 integration gate 基线与失败分类（2026-10-20）

## 执行事实

命令：`PI_REAL_BIN=<repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js npm run test:all-integration`（`scripts/run-integration-gate.ts`，41 个 `*.integration.mjs`，`--test-concurrency=1` 单进程串行），异步 job `bf46378e-2d42-4298-8eb6-3688a2a2e9d5`，日志 `/tmp/rc-integration-gate-full.log`。

wrapper exit 0，**`GATE_EXIT=1`**，约 1031 秒：`tests 342 / pass 304 / fail 28 / skipped 10 / todo 0`。

此前“把 28 个文件塞进单进程会超时”的推断**未被本次门禁证实**：门禁同样是单进程串跑 41 个文件，没有出现大批重 Git 用例超时；先前两次超时集中在同一批重 Git/proof 用例，属那两次运行的资源竞争，不作为门禁结论。

## 失败分类（28 项，按文件归组）

| 文件 | 数量 | 首个偏离点 | 分类 | 处置 |
| --- | --- | --- | --- | --- |
| `joint-upgrade-contact-supervisor.integration.mjs` | 17（13 场景 + C8/C9×2/C10） | `const host = process.env.PI_TEST_CODING_AGENT_ROOT` 未设 → `join(host,'dist/cli.js')` 收到 undefined，`ERR_INVALID_ARG_TYPE` 于 1–4ms 内抛出 | 类别 2：fixture 缺少与 `resolvePiCodingAgentRoot()` 一致的缺省解析 | 已修：缺省回落本仓物理 SDK 根（显式 env 仍可 pin） |
| `pi-subagents-project-workflow.integration.mjs` | 2 | fixture provider 仍发 `subagent` union 调用 → `Tool subagent not found` | 类别 2：S4 工具面迁移遗漏 | 已修：迁移到 `subagent_start`（含 `setActiveTools`、记录检索） |
| `subagent-completion-notification.integration.mjs` | 1 | 同上（provider 发 `subagent`），60s 后 “typed subagent dispatch receipt is missing” | 类别 2 | 已修：迁移到 `subagent_start` |
| `subagent-steer-text-insertion.integration.mjs` | 1 | 同上 + steer 仍以 `{action:"steer"}` 走 union | 类别 2 | 已修：派发迁移到 `subagent_start`，steer 迁移到 `subagent_run_steer({runId,message})`，诊断投影按工具名而非 `args.action` |
| `subagent-runtime-root-broker-startup.integration.mjs` | 1 | fixture agent dir 只复制 `pi/agents`，缺 required child extension `extensions/agents-shared.ts` → `session_start` ENOENT | 类别 2 | 已修：补 symlink；随后暴露第二个 fixture 缺陷（Host 在仓库根启动 + 临时 `PI_CODING_WORKSPACE_DIR` → `Coordinator state root scope mismatch`），已改为 `createIsolatedHostRepository()` 独立 Git common-dir |
| `managed-workspace-repository-identity.integration.mjs` | 1 | 断言把 `originRoot` 当 canonical realpath，但 production 的 `displayPath` 在 darwin 上有意剥掉 `/private` 前缀（`repository-identity.ts:16`），身份哈希另用 realpath | 类别 2：断言混淆“展示路径”与“身份哈希输入” | 已修：fixture 根先 realpath，断言改为对照 display 形态，并新增 `storageRepositoryId === sha256(canonical)` 钉住身份/展示分离。production 未改 |
| `session-owner-install.integration.mjs` | 2 | 断言仍要求普通入口传 `--no-skills`，而 `scripts/pi-shell.zsh:11-12` 已明确普通入口使用 Pi 原生 Skill 发现、只有 `pi-lite` 分支固定禁用（提交 `7aa0e18`/`6ad3d05` 系） | 类别 2：断言过期 | 已修第一项（argv 期望）；第二项 `fresh zsh wrapper … status 1` 待复跑取证后再分类，未猜测 |
| `pi-subagents-045-workflow.integration.mjs` | 1 | 用例自断言 `["0.87.1"].includes(piVersion)`，本机受支持 Host 是 `1.0.4`（`pi-subagents-compat.ts:41`），上游也已 0.75 | 历史版本 pin 的 lane，在当前机器**不可能通过** | **未改**：属覆盖范围决策（退役 / 登记门禁排除 / 保留常红），等用户裁决 |
| `pi-subagents-runtime.integration.mjs` | 2 | upstream `extension/rpc.js:587` 在 `getContext()` 为空时抛 `no_active_session`；lane 以 `--mode rpc --no-session --no-extensions` 启动，只挂本仓 runtime 与 fixture probe，upstream bridge 没有 extension context；第二个用例随后 60s RPC 超时 | 待裁决：本仓 typed runtime 自有派发路径，该 lane 验的是 upstream top-level RPC 兼容面是否仍由本仓激活 | **未改**：先前“非隔离 live state 导致”的推断已被否证（该 lane 本就使用临时 packageRoot/projectRoot/runtimeTmp、独立 `PI_CODING_AGENT_DIR`/`PI_CODING_WORKSPACE_DIR`/`TMPDIR` 并剥离 `PI_SUBAGENT_*`）。需要用户裁决：退役该 lane、登记门禁排除，还是在本仓 runtime 恢复 upstream bridge context |

`skipped 10` 为默认关闭的 harness（含 heartbeat SIGKILL 实验），未启动。

## 方法论纠正

先前 F3 fixture inventory 漏掉上述 4 个文件，原因是扫描命令的排除过滤（`rg -v 'pi-subagents|subagent-|…'`）按**文件路径**匹配，把 `test/subagent-completion-notification.integration.mjs` 这类文件名整体过滤掉了。纠正：旧工具名扫描必须按**内容**过滤、不得按路径过滤；本记录的门禁结果即该纠正后的全量事实。

## 复跑

已迁移文件的复跑：异步 job `8f34945f-6836-495c-abfd-cf90968c18b3`，命令 `PI_REAL_BIN=<repo cli> node --test test/managed-workspace-repository-identity.integration.mjs test/subagent-runtime-root-broker-startup.integration.mjs test/session-owner-install.integration.mjs test/pi-subagents-project-workflow.integration.mjs test/subagent-completion-notification.integration.mjs test/subagent-steer-text-insertion.integration.mjs test/joint-upgrade-contact-supervisor.integration.mjs`，日志 `/tmp/rc-gate-remediation.log`。结果以完成通知为准；启动回执不代表成功。

## 复跑结果（job `8f34945f-…`，301s）

`REMEDIATION_EXIT=1`：**31 tests / 23 pass / 8 fail**（同 7 个文件在门禁里贡献 24 项失败，现降到 8 项）。逐项：

| 失败 | 首个偏离点 | 分类与处置 |
| --- | --- | --- |
| contact-supervisor `empty` | 断言 `launchResolvedExtensions.required` 仍是两项，实际含 required child extension `agents-shared` | 类别 2，已修（期望改为三项） |
| contact-supervisor `invalid-reply` | 期望 3 次 reply 全部 `SUPERVISOR_REQUEST_NOT_PENDING`，实际不成立 | 待基线对照与 capture 取证，未猜测 |
| project-workflow `typed worktree commit…` | `WORKSPACE_SERVICE_UNAVAILABLE: managed workspace service is unavailable`（`worktree:true` 派发） | 待基线对照 |
| project-workflow `hostile legacy .pi-subagents tree` | `CAPABILITY_NEGOTIATION_FAILED`，D1 诊断 `sessionIdPresent:false / lifecycleIdentityPresent:false / sessionCwdPresent:false / cwdEqual:false`，缺 `rpc:v1/session` | 待基线对照；诊断面本身按设计工作 |
| session-owner-install `fresh zsh wrapper…` | wrapper 退出码 1（第 1 项 argv 期望已修） | 待取证 |
| completion-notification / steer-text-insertion | 60s 后 `typed subagent dispatch receipt is missing`（旧 union 名已迁移，仍未拿到派发回执） | 待基线对照；疑似与上面 `rpc:v1/session` 同源 |
| root-broker-startup | 断言 `allToolNames/activeToolNames` 含旧 union `subagent`；实际是 14 个独立工具 | 类别 2，已修（改为断言 `subagent_start` 存在且旧 union 不注册） |

## 基线对照（区分“本批引入”与“既有/栈升级遗留”）

`git worktree add` 被本仓 security-gates 拦截（`worktree lifecycle bypass：必须使用受管 lifecycle CLI`），因此改用只读 `git archive 92b0302 | tar -x` 生成 `/tmp/rc-baseline-92b0302`，symlink 当前 `node_modules`（`package.json`/lock 相对基线无差异），再把**当前**测试与 fixture 覆盖进去：这样只让 production 回到基线，测试保持现状，可判定失败是否由本批生产改动引入。

对照运行：job `54610015-8e58-4423-88b4-902b8687ba6c`，日志 `/tmp/rc-baseline-compare.log`。结果以完成通知为准。

## 基线对照结论（job `54610015-…`）

`/tmp/rc-baseline-compare.log`：**31 tests / 23 pass / 8 fail**，失败清单与顺序与当前树**逐项相同**（`empty`、`invalid-reply`、project-workflow 两项、session-owner zsh wrapper、completion-notification、root-broker-startup、steer-text-insertion），耗时也接近（60s 级两项同为超时形态）。

因此判定：这 8 项**都不是本批生产改动引入**（基线 production `92b0302` + 当前测试/fixture 同样失败）。本批 9 个 commit 的生产改动没有造成门禁回归。

对照方法补充：`git worktree add` 被 security-gates 拒绝（`worktree lifecycle bypass`），改用只读 `git archive` 展开基线树 + symlink 当前 `node_modules`（`package.json`/lock 相对基线无差异）+ 覆盖当前测试与 fixture；`/tmp/rc-baseline-92b0302` 为临时目录，不在仓库内、未注册 worktree。

## 复跑后已修并单独验证的两项

`node --test --test-name-pattern='supervisor: empty|persisted root session shares its broker registry' …` → **2/2 exit 0**（`/tmp/rc-two-assertion-fixes.log`）：

- contact-supervisor `empty`：required child extensions 期望补 `agents-shared`。
- root-broker-startup：旧 union `subagent` 断言改为 `subagent_start` 存在且旧 union 不注册。

即门禁 28 项失败中，已修并验证 17+2=19 项对应文件的那部分（contact-supervisor 17 项里的 `empty`、root-broker 1 项），其余按下表。

## 剩余 6 项（基线同样失败，非本批引入）

| 失败 | 现场信号 | 当前判断（未定论） |
| --- | --- | --- |
| project-workflow `hostile legacy .pi-subagents tree` | `CAPABILITY_NEGOTIATION_FAILED`，D1 诊断 `sessionIdPresent:false / lifecycleIdentityPresent:false / sessionCwdPresent:false / cwdEqual:false`，缺 `rpc:v1/session` | lane 以 `--mode rpc` 启动且未传 `--session-dir`（只设了 `PI_CODING_AGENT_SESSION_DIR`）；而 compat 合同明确 session 身份只从 Host session manager 投影、不从 cwd 猜测。疑似栈升级后收紧的合同，lane 未跟进。需实验确认（补 `--session-dir` 后是否恢复） |
| project-workflow `typed worktree commit…` | `WORKSPACE_SERVICE_UNAVAILABLE`（`worktree:true` 派发） | 待与上项一并取证；不猜测 |
| completion-notification / steer-text-insertion | 60s `typed subagent dispatch receipt is missing` | 疑似同源（派发在 capability 门禁处 fail closed，provider 走 fallback 文本） |
| contact-supervisor `invalid-reply` | 3 次 reply 未全部返回 `SUPERVISOR_REQUEST_NOT_PENDING` | 需 capture 取证；本批 H1/M1 改的是 intent 派生与 guard 持久化，基线同样失败说明不是其首因 |
| session-owner-install `fresh zsh wrapper` | wrapper 退出码 1 | 需 wrapper 输出取证 |

这 6 项一律**先取证再分类**，未加任何生产兼容分支，也未放宽断言。

## 用户裁决与后续实验（2026-10-20）

- 用户裁决：`pi-subagents-045-workflow` 的 `0.87.1` 版本 pin 属过期断言，直接改。已改为接受 `SUPPORTED_PI_VERSIONS`（当前 `1.0.4`）或显式 `PI_HISTORICAL_REAL_BIN` 提供的 `0.87.1`；该 lane 的真实前提是“upstream `pi-subagents@0.62.0` 装在受支持 Host 内”，版本 pin 只是历史组合的守卫，不代表当前 Host 版本。
- top-level RPC 两条 lane：先前“是否退役/排除/改生产”的三选一是基于错误假设（以为要保 upstream 兼容面）。取证后确认本仓 runtime 本来就 bootstrap upstream（`extensions/subagent-runtime.ts:319` `bootstrap: upstreamSubagentRuntime`），而生产合同要求 spawn 具备 `rpc:v1/session`，session 身份只从 Host session manager 投影、不从 cwd 猜测（`compat/pi-subagents-0.75.ts:17`、`subagent-dispatch/extension.ts:545`）。lane 用 `--no-session` 启动，因此 ping 无 session 身份 → `no_active_session` / `CAPABILITY_NEGOTIATION_FAILED`。处置改为 fixture 迁移：`--no-session` → `--session-dir <临时目录>`，不动生产、不退役、不排除门禁。
- 验证运行：job `fcde6205-efcb-466b-85b0-dc15867db508`（`test/pi-subagents-045-workflow.integration.mjs` + `test/pi-subagents-runtime.integration.mjs`），日志 `/tmp/rc-rpc-lane-session.log`。结果以完成通知为准；若仍失败则按现场重新分类，不假定 session 就是唯一偏离点。
- 同一 `rpc:v1/session` 假设也适用于 project-workflow / completion-notification / steer-text-insertion 三条 lane（它们同样只设 `PI_CODING_AGENT_SESSION_DIR` 而未传 `--session-dir`）；待本轮结果确认后再统一迁移，不提前批量改。

## 实验结果：session 假设被否证（job `fcde6205-…`）

`/tmp/rc-rpc-lane-session.log`：**6 tests / 4 pass / 2 fail**。

- `pi-subagents 0.62.0 rejects clarify and correlates a public workflow leaf` **通过**（8.2s，含从官方 registry 安装 `pi-subagents@0.62.0`）→ 用户裁决正确：`0.87.1` pin 是唯一障碍，改为接受 `SUPPORTED_PI_VERSIONS`（1.0.4）或显式 `PI_HISTORICAL_REAL_BIN` 后该 lane 在 1.0.4 Host + upstream 0.62 组合下真实通过。
- 两条 top-level RPC lane 在补 `--session-dir` 后**仍以完全相同形态失败**：`compat_spawn failed: No active extension context for subagent RPC.`（1.1s）与 60s RPC 超时。因此“缺 session 身份”不是首个偏离点，该假设被否证；`--session-dir` 改动已回退，避免留下与结论不符的 fixture 差异。

当前可证事实：错误来自 upstream `extension/rpc.js:583-587`（`options.getContext()` 为空即抛 `no_active_session`，`ping` 例外），而本仓 runtime 通过 `bootstrap: upstreamSubagentRuntime`（`extensions/subagent-runtime.ts:319`）装载 upstream，并在 `runtime-membrane.ts` 拦截其工具注册。也就是说：本仓自有 typed 派发路径不依赖 upstream bridge 的 active context（其它真实 Host lane 的派发均成功），该 lane 验的是 upstream 顶层 RPC 兼容面本身。

结论保持“需产品裁决”，但选项含义已更精确：
1. **退役该 lane**：承认本仓不再承诺 upstream 顶层 RPC bridge 的 active context；
2. **门禁登记排除**：保留文件作为已知未验证面，门禁不红；
3. **生产激活 upstream bridge context**：让 `getContext()` 在本仓 Host 内返回真实 session context（生产改动，需评估与 typed 路径/membrane 的重叠）。

未选 1/2/3 前不改生产、不删用例、不登记排除。project-workflow / completion-notification / steer-text-insertion 三条 lane 的 `rpc:v1/session` 缺失**不能**沿用本次已被否证的 session 假设，需各自取证。

## top-level RPC lane 取证（用户选 A：有界取证）

### 已确证的机制

1. bridge 服务端只有一处注册：upstream `extension/index.js:631-637`
   `registerSubagentRpcBridge({ events: pi.events, getContext: () => state.lastUiContext, execute: executeSubagentReady, state, disabledFeatures })`。
2. `handleRequest`（`extension/rpc.js:583-587`）对 `ping` 放行，其余方法在 `getContext()` 为空时抛 `no_active_session`（即 lane 看到的 `No active extension context for subagent RPC.`）。
3. `state.lastUiContext` 只有两个赋值点：
   - `index.js:767-772`：`pi.on("tool_result")` 且 `event.toolName === "subagent"` 且 `ctx.hasUI` —— 本仓栈里**永不可能**成立（S4 后旧 union 工具不注册/不 active，RPC 模式也没有 UI）；
   - `index.js:816-845` `resetSessionState(ctx, …)` 末尾 `state.lastUiContext = ctx` —— 由 session 生命周期（session_start / 切换 / rebind）驱动。
   清空点：`:303-304`、`:327-328`（stale context 守卫）、`:960`。
4. **本仓生产派发是这条 bridge 的客户端**：`src/subagent-dispatch/rpc-client.ts:3-4` 使用同一对通道 `subagents:rpc:v1:request` / `subagents:rpc:v1:reply:`，`:276` emit、`:230` 订阅回执；`extensions/subagent-runtime.ts:21` 注入该 client，`:319` 以 `bootstrap: upstreamSubagentRuntime` 装载 upstream。因此 bridge 的 active context 是生产派发的真实依赖，不是无关兼容面（上一轮“生产不依赖它”的说法已在记录中更正）。

### 结论：不能退役

退役这条 lane 会同时失去：bridge context 可用性的唯一外部视角哨兵、`ping` capability 投影（含 `rpc:v1/session`）的端到端校验、child 环境 marker 卫生、nested 事件隔离、workflow root/leaf 关联。这些一旦在 Host/upstream 升级中破坏，症状会散落成 `CAPABILITY_NEGOTIATION_FAILED` / `WORKSPACE_SERVICE_UNAVAILABLE` / “dispatch receipt is missing”（正是当前另外 4 项失败的形态），而不是一句精确的 `no_active_session`。故选项 1（退役）不采纳；选项 2（门禁排除）只在取证失败时作为临时手段。

### 尚未解释的不对称（保留为未证实，不猜测）

contact-supervisor lane 同样以 `--mode rpc --no-session` 启动 Host，其经本仓 typed 工具的派发**成功**（13/15 场景通过）；而本 lane 的独立客户端调 bridge 得到 `no_active_session`。且本轮实验已否证“补 `--session-dir` 即可”——补了仍同形态失败（`/tmp/rc-rpc-lane-session.log`）。两个互斥候选：

- H1：该 Host 里 `resetSessionState` 从未执行（RPC 模式 + `--no-session` 下 session 生命周期未触发），而 contact-supervisor 的成功派发并不经这条 bridge（即本仓在该形态下走了另一条 in-process 路径）；
- H2：回答请求的 bridge 实例与本仓 bootstrap 的实例不是同一个（多实例/多 state），因此其 `lastUiContext` 永远为空。

### 下一步（单一有界实验，未执行）

在该 lane 的 Host 里加一个只读观测扩展，记录三件事：`session_start` 是否触发及其 ctx 是否存在、`subagents:rpc:v1:ready` 是否发出（`rpc.js:712` `emitReady` 会带 `pingData(ctx ?? getContext())`）、以及 `ping` 回执里 `session` 投影是否非空；同时对 contact-supervisor lane 做同一观测。两边对照即可在 H1/H2 之间判定，无需改生产。判定前不加兼容分支、不放宽断言、不登记门禁排除。

## 观测实验判定（child `88284cdc-4765-47d0-9601-f945da2ad7db`）：H1/H2 均否证，第三解释成立

原始记录：`/tmp/rpc-obs-run3.log`（测试输出内 `FORM1/FORM2 OBSERVATION` 段）；async dir `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/88284cdc-4765-47d0-9601-f945da2ad7db`；session `var/sessions/2026-10-17T04-49-51-175Z_01a14831-e247-7044-a36d-676dd611aed1/99adc873-002a-4d17-a7ed-3480f5a78324/run-0/session.jsonl`。

| 观测项 | 形态一（失败 lane Host） | 形态二（contact-supervisor 成功 Host） |
| --- | --- | --- |
| `session_start` | 触发，ctx 存在、sessionManager 可用（sessionId `01a15cab-c972…`，sessionFile null） | 触发，ctx 存在、sessionManager 可用（`01a15cab-ce0f…`） |
| `subagents:rpc:v1:ready` | **从未发出**（`readyEvents: []`） | 发出 1 次，session 投影非空 `{cwd, sessionId, sessionFile: null}` |
| ping 回执 | success，methods 9、capabilities 全量，但 **`session: {}` 空** | success，同上但 session 投影非空 |
| request 通道监听者 | load 1 / session_start 1 | load 1 / session_start 1 |

形态一 stdout 的决定性错误：`extension_error … subagent-runtime.ts … event:"session_start" error:"Required child extensions 'agents-shared' is not an importable file: ENOENT …/config/extensions"`。

判定：
- **H2 否证**：两形态监听者恒为 1，不存在多实例 bridge。
- **H1 否证**：失败 lane 的 `session_start` 确实触发且 ctx 完好；形态二的成功派发**就是**经这条 bridge（单实例、已 primed），不是绕行 in-process。
- **第三解释（成立）**：typed extension 的 session_start 链中，`registerRequiredChildExtensions` 校验（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2102`）先于 `await beforeSessionStart(event, ctx)`（`:2113`）；该 lane 的 `PI_CODING_AGENT_DIR`（configRoot）缺 `extensions/agents-shared.ts` → 在 `node_modules/pi-subagents/src/shared/required-child-extensions.js:36` 抛错 → upstream 的 session_start handler（含 `resetSessionState` `index.js:816-845` 与 `emitReady` `index.js:1041`）**从未执行** → `state.lastUiContext` 保持 null → ready 不发、ping 的 session 投影为 `{}`、spawn 在 `rpc.js:585` 抛 `no_active_session`。

首个偏离点：
- 环境层：`test/pi-subagents-runtime.integration.mjs:157-178`（configRoot 无 `extensions/agents-shared.ts`）对照 `test/joint-upgrade-contact-supervisor.integration.mjs:15`（symlink 提供该扩展）。
- 代码层：抛错顺序 `src/subagent-dispatch/extension.ts:2102` 早于 `:2113`；要求该文件存在的绑定是 `extensions/subagent-runtime.ts:216-218`。

分类与处置：门禁这两项失败属 **类别 2（测试制造的非预期数据）**——合法生产形态的 agentDir 都带 `agents-shared`（`subagent-runtime.ts:216-218` 明确要求），缺它的 agentDir 由 fixture 造成；修法是给该 lane 的 configRoot 补同样的 symlink，**不需要生产兼容分支**。

另记一个**独立的、需用户裁决的设计问题**（本次不实施）：当 required child extension 缺失时，我们的校验先抛错会让 upstream 的 session_start 整体不执行，外部可见症状退化成难以定位的 `no_active_session`（bridge 静默未 primed），而不是明确的“缺 agents-shared”。是否要调整顺序（把 required-child 校验移到 `beforeSessionStart` 之后）或降级为非致命 + 明确诊断，属生产可诊断性决策；在裁决前保持现状 fail-closed。

## fixture 修复结果（child `ea5f44a9-4d7e-4586-b522-776219a841b3`）：根因消除，暴露一条过期断言

改动只落在 `test/pi-subagents-runtime.integration.mjs`（+6/-1）：为 configRoot 补 `extensions/agents-shared.ts` symlink，指向仓内权威来源 `pi/extensions/agents-shared.ts`（存在，849B），做法对齐 `test/joint-upgrade-contact-supervisor.integration.mjs:20`；不复制内容、不新建实现。

重跑（`/tmp/rpc-lane-fix.log`，串行）：tests 5 / pass 3 / fail 2 / skip 0，约 5862ms（两条 RPC lane 2075ms、2744ms）。**原根因已消除**：日志中 `ENOENT`、`not an importable`、`no_active_session` 出现次数均为 0；`compat_spawn` 成功返回 details，`ping.version` 与 `REQUIRED_METHODS` 断言通过 → session_start 链已跑通、bridge 已 primed。

新的首个偏离点：`test/pi-subagents-runtime.integration.mjs:429` 的 `assert.ok(details.activeTools.includes("subagent_supervisor"))`，两条 lane 均在此失败。实际 activeTools 含全部新名工具（`supervisor_request_pending/status/reply`、`subagent_start`、`subagent_run_*`、`managed_workspace_*` 等）但**不含** legacy 名 `subagent_supervisor`。定性为**类别 2 的过期断言**，不是缺件也不是生产缺陷：`src/subagent-dispatch/runtime-membrane.ts:174-179` 拦截上游 `registerTool`，对 `name === "subagent_supervisor"` 只 bind `execute` 进 adapter、不注册为可见工具，`:187-189` 的 `getAllTools` 代理显式 filter 掉该名字；模型面替代物见 `supervisor-operation-tools.ts:5`，legacy→新名的一次性映射权威定义在 `pi/AGENTS_GLOBAL.md:82`。

处置：已授权该 child 把断言迁移为表达当前合同且更严的形式（legacy 名必须**不在**、`supervisor_request_*` 三者必须**在**、保留原有其它检查、旁注 membrane 坐标），并同文件内一并迁移其它引用 legacy 名之处；仍禁止改生产、禁止放宽、禁止 skip/only、禁止自行 commit。复跑日志 `/tmp/rpc-lane-fix2.log`。

## 复跑全绿（child `b5c99195-26ed-4c17-8932-1931fe106669`）

`/tmp/rpc-lane-fix2.log`：**EXIT=0，tests 5 / pass 5 / fail 0 / skipped 0**，duration 6023.86ms（两条 RPC lane 2135ms、2815ms）。累计改动只有 `test/pi-subagents-runtime.integration.mjs`（+15/-3），生产文件零改动（已用 `git diff --stat` 与 `git status --porcelain` 自证）。

断言迁移内容：probe 的 `setActiveTools` 移除 legacy 名 `subagent_supervisor`（其余观测能力全部保留）；`:429` 处由 1 条正向包含检查改为 **1 条 legacy 名负向断言 + 3 条 `supervisor_request_pending/status/reply` 正向断言**，并保留 `bg_wait` 在、旧 union `subagent` 不在；旁注 membrane 坐标（`runtime-membrane.ts:174-179`、`:187-189`）与映射权威（`supervisor-operation-tools.ts:5`、`pi/AGENTS_GLOBAL.md:82`），注明“不是 fixture 缺件，勿再按缺件排查”。严格性净提升，未放宽任何断言、未 skip/only、未改生产。

据此，门禁 28 项失败中由本 lane 贡献的 2 项已消除（045 lane 1 项此前已消除）。该 child 的 run 状态在报告后显示 failed，但结论已由日志与 git 状态独立复核，不再续跑。

## project-workflow 取证日志：同根因的效果签名（child `d5045380-fb5b-4c59-9ee7-e547d5291fcf` 修复前取证）

`/tmp/project-workflow-before.log`：tests 2 / pass 0 / fail 2，duration 2660ms。两条失败与已确证根因的对应关系：

| 失败 | 坐标 | 现场错误 | 对应根因后果 |
| --- | --- | --- | --- |
| `project typed worktree commit completes Auto Integration and release` | test 在 `test/pi-subagents-project-workflow.integration.mjs:241`，断言在 `:326` | `subagent_start` 的 tool_execution_end：`WORKSPACE_SERVICE_UNAVAILABLE: managed workspace service is unavailable`（`details.code` 同名） | session_start 在 required-child 校验处抛错后，排在其后的 workspace service / coordinator 初始化未执行 |
| `non-Goal executor ignores a hostile legacy .pi-subagents tree` | test 在 `:359`，断言在 `:441` | `CAPABILITY_NEGOTIATION_FAILED: pi-subagents RPC capability negotiation failed; missing: rpc:v1/session`，诊断包 `negotiation`：`stage:"spawn-capability-assertion"`、`dispatchPath:"coding"`、`capabilitiesEnvelopePresent:true`、`versionOk:true`、`spawnMethodOk:true`、**`sessionIdPresent:false`、`lifecycleIdentityPresent:false`、`sessionCwdPresent:false`、`cwdEqual:false`** | 正是 ping 的 `session` 投影为 `{}`、bridge 未 primed 的直接后果 |

方法论要点（必须记住，否则会误判）：**`Required child extensions 'agents-shared' … ENOENT` 原文不会出现在这些 lane 的 TAP 日志里**，因为 lane 不回显 Host 的 stdout/stderr；上一轮能看到该行是因为观测 harness 自行捕获了 Host 输出。因此判定同根因应使用上表两类**效果签名**，而不是 grep ENOENT 原文。据此已 steer 该 child（request `38e3692e-111a-4565-90af-a36b5546590c`，排队不等于已消费），澄清“签名缺失”不构成“非同一根因”，并授权按效果签名继续修复；若补 symlink 后效果签名仍在，才是新根因。

同批取证进行中：`/tmp/completion-notification-before.log`（`async typed dispatch delivers the upstream subagent-notify custom message into the main session log` 60596ms 失败，与门禁记录一致）。

## 三个同构 lane 修复结果（child `d5045380-fb5b-4c59-9ee7-e547d5291fcf`）

修复前取证（效果签名，均无 `agents-shared` 字样——这些 lane 的 TAP 不回显 Host 输出，属预期，不作反证）：

| lane | 日志 | `WORKSPACE_SERVICE_UNAVAILABLE` | `missing: rpc:v1/session` | 失败坐标 |
| --- | --- | --- | --- | --- |
| project-workflow | `/tmp/project-workflow-before.log` | 1（test1） | 1（test2） | test `:241`→断言 `:326`；test `:359`→断言 `:441` |
| completion-notification | `/tmp/completion-notification-before.log` | 0（该 lane `worktree:false`） | 1 | test `:258`→断言 `:353`（`dispatch receipt is missing`，60596ms 打满等待） |
| steer-text-insertion | `/tmp/steer-text-insertion-before.log` | 0 | 3 | test `:196`→断言 `:281`（同上，60627ms） |

修复：三个文件各补 `mkdir(configRoot/extensions)` + `symlink(repoRoot/pi/extensions/agents-shared.ts → configRoot/extensions/agents-shared.ts)`（project-workflow 两处 scenario `:286`/`:408`，completion-notification `:323`，steer `:252`，另各加 `symlink` import）。无内容复制、无新实现、无断言改动。已提交。

修复后复跑：三个 lane 的 `WORKSPACE_SERVICE_UNAVAILABLE` / `rpc:v1/session` / `no_active_session` 计数**全部为 0**，派发恢复正常。

| lane | 日志 | tests/pass/fail | 结果 |
| --- | --- | --- | --- |
| completion-notification | `/tmp/completion-notification-after.log` | 2/2/0（5804ms） | **全绿** |
| project-workflow | `/tmp/project-workflow-after4.log`（4 次一致） | 2/1/1（13170ms + 35168ms） | test2 ✔；test1 新偏离点 |
| steer-text-insertion | `/tmp/steer-text-insertion-after.log` | 1/0/1（8139ms） | 新偏离点 |

### 新偏离点 A：project-workflow test1（类别 2，断言相对当前生命周期过期）

`:355` `readFile(handle.dispatch_cwd/README.md)` → `ENOENT …/workspaces/repositories/6ad34b7…/worktrees/e41b05e2-…/README.md`。旁路 watcher 抓到的 managed workspace ledger 记录：`state: "released"`、`disposition.action: "discard"`、`integrationReceipt: {candidateHead: 52bf66a7…, targetRef: refs/heads/main, completedAt: …}`；`project` 仓侧 `git log` = `8703f14 child-marker` / `6d5f22d fixture`，`project/README.md` 末行含 `PROJECT_TYPED_CHILD_COMMIT`。即 Auto Integration 已把 child 提交并入 main，随后 release 按现行生命周期删除 worktree 目录，而 `:355`/`:357`（同一已删除 cwd 上的 `git status --porcelain`）仍在读 worktree ⇒ 断言过期，不是生产缺陷、也不是缺件。授权迁移方向：改断 `projectRoot/README.md` 含 marker、`projectRoot` 工作树干净、并以 ledger `state === "released"` + `integrationReceipt` 作为 release 证据。

### 新偏离点 B：steer-text-insertion（疑似类别 1：schema 与执行期强制不一致）

> 后续（2026-10-17，同一目录）：已判定为**类别 1** 并按选项 2+3 实施——steer 的 `index` 已收紧为 schema 必填，描述/错误文案同步，fixture 补 `index: 0`。本节的「schema 把 index 声明为可选」是该次 lane 观测时刻的事实，自收紧后失效；解析语义矩阵、死码证明与无法在本仓修复的 upstream 提示冲突见 `steer-locator-contract.md`。

`:319` 失败原文：`child hit the no-steer fallback path (STEER_CHILD_FALLBACK) — steer text was not inserted`，`steerResult.text = "SUPERVISOR_STEER_CHILD_AMBIGUOUS: Supervisor control request blocked."`、`details.code` 同名，`childSteering` 全 0（requested/scheduled/pending/delivered/failed）。`subagent_start` 已 `isError:false`，偏离点前移到 steer 投递：fixture 的 steer 调用（`:85`）只传 `{ runId, message }`，而生产在缺 `index` 时硬拒绝（`src/subagent-dispatch/extension.ts:1479`、`supervisor-control-plane.ts:300`、`supervisor-gate-policy.ts:558`），但工具 schema 把 `index` 声明为**可选**（`operation-tools.ts:40`、`:248`，描述“可选定位”）。

主会话本会话内的独立复现支持“类别 1”方向：对 `d5045380` 执行 steer 时只给 `runId` 即被 `SUPERVISOR_STEER_CHILD_AMBIGUOUS` 拒（该 run 的 fan-out 是 1/1，只有一个 child），补 `index: 0` 后才投递成功；而 upstream 状态回执自己给出的提示是 `subagent({action:"steer", id:"…", message:"…"})`（不含 index）。因此“模型按公开合同只给 runId 就会被拒”是可从合法 typed 入口产生的事实，不是测试制造的非法组合。已派只读诊断确定各定位组合（id-only / runId-only / index-only / dir）的确切解析语义与首个偏离点，再决定修生产解析、修 schema/描述、还是修 fixture；判定前不改任何一侧。

## session-owner lane 修复结果（child `781f57d8-3f78-4bef-af33-9ca9123efd2e`，已提交 `99a0a01`）

改动只在 `test/session-owner-install.integration.mjs`（+53/−11）：导入权威 helper `resolvePiCodingAgentRoot`（`test/helpers/pi-runtime.mjs:29-38`），把 `officialPiBin` 常量换成运行时解析的 `officialLauncherPaths()`（`PI_REAL_BIN` 显式优先含 trim、缺省 `join(hostRoot,"dist/cli.js")`；`PI_HOST_ROOT`/`PI_PACKAGE_DIR` 共用同一 `hostRoot`；解析放在用例运行期而非模块加载期）；新增 `describeFailure(result, transcriptPath)` 统一断言消息（status/signal/stdout/stderr + pty 日志），覆盖 `assertCompleted`、`verifyInstalled` 的 `runFreshZsh`、`init` 与原 `:235` 四条；expect 程序首行加 `log_file -a $env(PTY_LOG)`（`<state.root>/official-pty.log`），不改行为语义。

主会话独立复核：`git diff --stat` 只有该文件（53/11）；`/tmp/so-fix-full.log` 尾部 `tests 3 / pass 3 / fail 0`（8492ms）；`/tmp/so-fix-noenv.log`（`env -u PI_TEST_CODING_AGENT_ROOT`）`pass 1 / fail 0`；`grep -c 'process\.env\.PI_TEST_CODING_AGENT_ROOT'` = **0**；负向对照 `/tmp/so-fix-pin-bogus.log`（pin 指向不存在路径）预期红，且断言消息首次自带首个偏离点原文：`status=1 signal=null stdout="ENOENT: … lstat '/private/tmp/definitely-missing-pi-root'" stderr="" ptyLog="同一段原文"` —— 同时实证了诊断修复与 `log_file` 生效。child 另验证首尾空白容忍 pin 绿、双变量全缺省绿。

## `invalid-reply` 定性（child `ae2253b7-14c9-4132-b65f-f75034e5833e`）：**类别 2**，并更正本文件 `:42` 的记录

**更正**：本文件 `:42` 记的“实际不成立”形态不完整，我后来在派发里写的“2 次成功投递 + 1 次 `NOT_PENDING`”**在两个现场里都不存在**。真实形态是 **3/3 `isError=true`**：

| 次序 | 请求参数原文 | 回执 |
| --- | --- | --- |
| 1 | `{"replyTo":"unknown-request","message":"bad"}` | `isError:true`、`details:{code:"SUPERVISOR_REQUEST_NOT_PENDING"}` |
| 2 | `{"to":"executor","message":"bad"}` | `isError:true`、`details:{}`、text `Validation failed for tool "supervisor_request_reply": - replyTo: must have required properties replyTo …` |
| 3 | `{"message":"bad"}` | 同上（`Received arguments: {"message":"bad"}`） |

durable 权威面印证零投递：`xlUbIK/workspace/supervisor-control/supervisor-4451029c….json` → `requests=[{state:"expired"}]`、**`receipts` 为空**。所以“成功投递”是把 Host schema 校验拒绝误读成投递成功。

机制：Host 在 tool 执行**前**做 schema 校验并直接拒绝——上游 `prepareToolCall`（`node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-H33F2TZD.js`，`validateToolArguments` → `createErrorToolResult`，`kind:"immediate"`）调用 `node_modules/@earendil-works/pi-ai/dist/utils/validation.js:280`（`validateToolCall` 见 `:266`），顺序在 `config.beforeToolCall` 与 `prepared.tool.execute(...)` 之前。因此参数**根本没到**我们的 typed 工具：本仓二层校验 `supervisor-operation-tools.ts:64-70`（`SUPERVISOR_OPERATION_REQUIRED_FIELD`、`keypath:$.replyTo`）未执行（现场 `details:{}` 即证据），membrane 的 `executeReply`/`commitDelivery`（`extension.ts:1568-1620`）未执行（无 receipts）。`replyTo` 确实必填：`supervisor-operation-tools.ts:93`/`:151` `required:["replyTo","message"]`、`:95` `minLength:1`；`to` 只是无控制面/控制面停用路径的 native 兜底（`:97`、`:108`），受控路径不消费 ⇒ “有 `to` 无 `replyTo`”是**非法工具调用**，不是“待决请求不存在”。fixture 也未绕过校验：`contact-provider.mjs` 经 `stream.push({type:'toolcall_end', toolCall})` 产出普通 assistant toolCall，走 Host 标准通道，不是 legacy `subagent_supervisor` union 面。

判定：`test/joint-upgrade-contact-supervisor.integration.mjs:69` 要求三次坏 reply 全部 `SUPERVISOR_REQUEST_NOT_PENDING`，等于要求“非法调用穿透 Host 校验进入控制面”，是 S0 冻结合同下**设计上不可达**的状态组合 ⇒ **类别 2（过期断言）**；生产侧无缺失，反而按设计 fail closed。**不需要任何 production 兼容分支。**

已授权的最小修法（保留“schema 非法调用不得投递”这条有价值覆盖）：`:69` 保留 `replies.length===3` 与 `every(isError===true)`；按回执顺序改为 `replies[0].details.code==='SUPERVISOR_REQUEST_NOT_PENDING'`，`replies[1]`/`replies[2]` 断言 `details.code===undefined` 且 `content[0].text` 匹配 `/must have required properties replyTo/`；可选强化：读 `workspace/supervisor-control/*.json` 断言 `receipts` 不含 `consumed===true`（零投递）。**不采纳**改 fixture 让三次都进控制面的方案（会牺牲上述覆盖，语义不同）。

附带事实（供后续断言/渲染参考）：Host 校验失败的 toolResult `details` 是**空对象**，任何依赖 `details.code` 的断言或渲染都必须容忍“无 code”的错误形态（这不是缺陷，`compact-rendering.ts:252-268` 已按“缺结构化凭据”分支处理）。

## TUI 详情首行删除的口径差（child `71a01c1c-e776-4b33-8bcf-b5473ff75d78` 上报，主会话已独立核实）

child 按裁决删除了 header 身份行并端到端删除 `metaLabel`，但同时上报：`footer-runtime.ts:705-724 installFooter()` 在 presenter 挂载时把 footer 换成 `view.createFooter`，而 presenter 的 meta 只来自**父 ctx**（`presenter.ts:176-204 projectActivityFooterMeta(ctx)` 读 `ctx.model`/`ctx.thinkingLevel`），详情 footer 只渲染 `n/N glyph label · state`（`presenter.ts:299-313`）⇒ `footer-runtime.ts:407` 的 child 模型分支只在 **fallback/standalone** 路径成立。主会话核实属实。因此“删首行 + 删 metaLabel”会让选中 child 的模型/thinking 在 presenter 路径下**无处显示**，与用户“都放到 footer 去”的意图相反（等于重新引入 `docs/bugs/2026-10-19-subagent-detail-model-label-lost.md` 的症状）。

处置：已 resume 该 child 补第二步——恢复 `ActivityRow.metaLabel` 作为**只读展示投影**承载字段（仍由 `formatChildModelLabel` 生成、未知则不设），改由 `presenter.ts renderDetailFooterLines` 首行渲染（`n/N glyph label · state · 模型`，遵守宽度截断与 `DETAIL_FOOTER_MAX_ROWS`），header 保持无身份行、`过期观察` 仍留在滚动信息行（依据：overlay 打开时主 footer 的 stale 状态行不渲染，`presenter.ts:340-343`），主视图 entry 块保持现状不拥挤。断言随之迁移为新合同。其 stale 处置与“空态不占 header 行”的论证已采纳。

## 当前失败清单状态（截至 `b559cd6`，逐项对照首跑 28 项中已定位的部分）

| 项 | 首跑形态 | 分类 | 处置 | 验证证据 |
| --- | --- | --- | --- | --- |
| `pi-subagents-045-workflow` 历史版本 pin | 构造上必红（pin `0.87.1`） | 类别 2 | 改为接受 `SUPPORTED_PI_VERSIONS`（1.0.4）或显式 `PI_HISTORICAL_REAL_BIN` | `/tmp/rc-rpc-lane-session.log`：该用例 ✔（8.2s，含从官方 registry 安装 `pi-subagents@0.62.0`） |
| `pi-subagents-runtime` top-level RPC ×2 | `no_active_session` / 60s 超时 | 类别 2（fixture 缺 `agents-shared`）+ 一条过期工具面断言 | 补 symlink（`9a41518`）+ 断言迁移为“legacy 名必须不在、`supervisor_request_*` 三个必须在” | `/tmp/rpc-lane-fix2.log`：**EXIT=0，5/5 绿**（6023ms），主会话已复核 |
| `subagent-completion-notification` | `dispatch receipt is missing`（60596ms） | 类别 2（同根因） | 补 symlink（`eef71e8`） | `/tmp/completion-notification-after.log`：**2/2 绿**（5804ms） |
| `pi-subagents-project-workflow` ×2 | `WORKSPACE_SERVICE_UNAVAILABLE` / `missing: rpc:v1/session` | 类别 2（同根因）+ test1 断言相对 release 生命周期过期 | 补 symlink（`eef71e8`）+ 迁移已释放 worktree 断言为主仓 marker/整洁 + ledger `released`/`integrationReceipt`（`39c1852`） | `/tmp/project-workflow-migrated.log`：**EXIT=0，2/2 绿**（46739ms），覆盖加强（新增 `git log -S` 与 durable release 证据） |
| `session-owner-install` zsh wrapper | `:235` `1 !== 0`、断言消息空（约 1.8s） | 类别 2（fixture 不自足，依赖 ambient `PI_TEST_CODING_AGENT_ROOT`） | 改用权威 helper `resolvePiCodingAgentRoot` + `PI_REAL_BIN` 缺省 + `describeFailure`/`log_file` 取证（`99a0a01`） | `/tmp/so-fix-full.log`：**3/3 绿**（8492ms）；`env -u` 无 ambient 亦绿；负向对照证明 pin 被消费且消息自带 ENOENT 原文 |
| `joint-upgrade-contact-supervisor` `invalid-reply` | 期望 3× `NOT_PENDING`，实际 1× `NOT_PENDING` + 2× Host schema 拒绝 | 类别 2（断言要求非法调用穿透 Host 校验，设计上不可达） | 按回执顺序迁移断言 + 新增零投递覆盖（`b559cd6`） | `/tmp/contact-supervisor-migrated.log`：**EXIT=0，17/17 绿**（114188ms），`invalid-reply` 3973ms ✔ |
| `joint-upgrade-contact-supervisor` `empty` | 首跑失败集内 | 同上 lane | 随 `b559cd6` 一并复跑 | 同上：`empty` 2551ms ✔ |
| `subagent-runtime-root-broker-startup` | 旧日志为 `agents-shared` ENOENT（`lstat …/agent/extensions`） | 类别 2（fixture 缺件，已由 `f211702` 修复） | 无需再改：旧日志早于 `f211702`，当前 `:47-50` 已有 `mkdir(agentDir/extensions)` + symlink | `/tmp/root-broker-startup-current.log`：**EXIT=0，1/1 绿**（1423ms，duration 1484ms），Host 侧无 `extension_error`、工具面 14 个且旧 union `subagent` 不注册；child `b91be3d3-4125-4cbf-8f45-3378c7d158fb` 实测，主会话已复核日志与该文件零改动 |
| `subagent-steer-text-insertion` | `STEER_CHILD_FALLBACK`（60599ms） | **类别 1（生产合同缺陷）** | 裁决为选项 2+3：把 steer 的 `index` 同步为合同必填 + 描述/错误文案同步 + fixture `:85` 补 `index: 0`；不做唯一候选推断（完整性无 public 证明源） | child `ee588091-2eff-4401-bb46-10b893767ba1` 实施中；lane 复跑待 Host 槽位 |

已消除 **10 项**（045 ×1、top-level RPC ×2、completion-notification ×1、project-workflow ×2、session-owner ×1、contact-supervisor ×2、root-broker-startup ×1）；待定 1 项（steer 合同同步中，child `ee588091-2eff-4401-bb46-10b893767ba1`，在途 diff 为 `src/subagent-dispatch/{extension.ts,operation-tools.ts}` + `test/subagent-operation-tools.test.mjs` + `test/subagent-steer-text-insertion.integration.mjs`）。首跑 28 项中其余未逐项定位的失败，待两项落地后用全量门禁复跑统一对照。

方法论更正（必须记住）：**不得用首跑日志或基线对照日志判定当前 HEAD 的绿/红**。`/tmp/rc-integration-gate-full.log` 是首跑现场（早于 `f211702`），`/tmp/rc-baseline-compare.log` 是基线生产树 `92b0302` 配当前测试的对照，两者都只能用于“是否本批引入”的归因，不能当作当前状态。任何“已修”结论都必须有一次针对当前 HEAD 的单独复跑证据。

## 全量门禁复跑（job `ca52e033-5707-4cbf-9188-110afc7a945a`，HEAD `cd06cf9`）

`/tmp/rc-gate-rerun.log`：`running 42 integration files` → **344 tests / 332 pass / 2 fail / 10 skipped**，duration 813812ms（对比首跑 342/304/28/10，**消除 26 项失败**）。注意 `EXIT=1` 而 async 回执 `exitCode:0`：命令尾部是 `echo "EXIT=$?" | tee -a`，作业退出码取自 `tee`，门禁自身退出码只在日志文本里。

两项失败都在 `test/background-activity-runtime.integration.mjs`，且都由本批展示层提交 `6b1827e`（详情面身份行改由 footer 承载）引入 —— 门禁把自伤抓了出来：

| 失败 | 坐标 | 定性 | 首个偏离点 |
| --- | --- | --- | --- |
| `owner-first：package 唯一安装 footer，三 source 同 scope 握手，根只发布 factory` | test `:359`，断言 `:400` `assert.match(detailRendered(), /›/)` | **断言过期**，非渲染回归 | `detail-controller.ts:709-729`（header 只剩 `:717` 滚动信息行）对照 `6b1827e^` 的 `:704-709`（身份行是 `›` 的唯一渲染来源）。`›` 现只属主视图选择 cell（`layout.ts:90`、`:299-301`），而 detail 模式 footer 已换成详情 footer（`presenter.ts:349-351` → `:303-336`，首行 `:317` `n/N glyph label · state[ · metaLabel]`） |
| `late detail：旧选择在途详情返回后不覆盖新选择，旧组件被 dispose` | test `:695`，断言 `:704` `assert.match(detailRendered(), /printf fixture-one/)` | **断言对象过期**，非渲染回归；该断言此前从未验证正文，而是命中被删的身份行（其中含 `entry.label` = bash 命令原文） | `detail-controller.ts:762`（`if (this.requestInFlight) return ["加载中…"]`）：测试在 `handleInput` 后**同步**断言，此时 `requestDetail()`（`:514-553`）的 `promise.then`（`:546`）尚未进入 `settleSuccess`（`:556`）。`bodyContent`/`requestDetail` 在 `6b1827e` 中未被改动 |

排除 `headerRows`（2→1）造成视口错位的直接证据：加一次 `flush()` 屏障后正文完整渲染 7 行且位置自洽（`行 1-7/7`，高度 19 = 24 − 4 `DETAIL_RESERVED_BOTTOM_ROWS` − 1 新 headerRows）；若视口错位应出现 `行 1-18/7` 之类错值或缺行，实测没有。

处置（child `77bbb6c5-8366-472a-aa24-c9f51e149412`，只改 `test/background-activity-runtime.integration.mjs`，+51/−8；`src`/`packages` 零改动）：
- `:400` 迁移为“header 不含 `›` 且只剩滚动信息行” + “详情 footer 首行严格等于 `2/2 ⏱ 每日巡检 · 等待触发`”。后者比原 `›` **更强**：分母 2 = subagent 行 + scheduler 行合并后的同一 registry，握手少一个 source 分母就不是 2，因此同时钉住“统一详情看的是三 source 合并后的同一 registry”。
- `:704` 迁移为“footer 首行承载当前选择身份（`1/2 ⌘ printf fixture-one · running`）+ 切换瞬间正文为 `加载中…`（预期中间态）+ `flush()` 后正文 `command: printf fixture-one`”，并**新增真实迟回场景**：先 RIGHT 到 scheduler（deferred 在途）→ LEFT 回 bash → flush → `settleDetail()`，断言旧选择的迟到详情不覆盖新选择正文、不出现 `受控详情`、选择仍是 bash。
- “旧组件被 dispose”在集成层不可观测（真实 source 返回 pi-tui `Text`，无 `dispose` 方法，`component.dispose?.()` 结构性 no-op，迁移前也未断言）；保留可观测后果“迟回组件不得被应用”，dispose 计数由 `test/background-activity-details.test.mjs:664` 精确断言（`disposed === 1`）。
- **非空洞性证明（变异测试，已还原）**：去掉 `settleSuccess` 的 `record !== this.currentRequest` fence → `late detail` 在“旧选择的迟到详情不得覆盖新选择正文”处失败；把 `presenter.ts:317` 首行 label 截断为 2 字符 → `owner-first` 在身份断言处失败。两处变异均已按原文还原（`git diff --stat -- src packages` 为空）。

主会话独立复核：`node --test test/background-activity-runtime.integration.mjs` → **13/13 绿**（1028ms）；改动面仅该文件（+51/−8）；child 侧另有 79/79（四个 TUI 单测文件）与 `npx tsc --noEmit` 零错误。

另记一项事实：门禁 runner 按 glob 选文件，**未跟踪文件也会被执行**——本次 `running 42 integration files`（此前 41）且日志含 `[rpc-bridge-observation]` 输出，即两个未跟踪的观测文件已进入门禁（tests 342→344 的来源），每次多启动 2 次真实 Host 且 form1 会故意复现“bridge 未 primed”形态，而它们的断言几乎为空、无回归价值。是否删除或移至 `scripts/probes/` 待用户裁决。
