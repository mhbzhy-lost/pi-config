# Pi 1.3.0 升级发布就绪结论（U7 汇合记录）

- 计划：`docs/plans/2026-10-21-pi-1.3-upgrade-release.md` 的 **U7「汇合发布就绪结论与可审核交付包」**
- 收尾入口：`docs/todos/2026-10-21-pi-1.3-upgrade-closeout.md`（本文是它的附件级汇合记录，不替代入口定位）
- 生成日期：2026-10-21
- 机器可读版本：`reports/release/readiness.json`（`schemaVersion: pi130-readiness.v1`）
- 当前性质：**candidate-only**（可复核的隔离候选 + 已说明边界的文档附件），**不是** ready-for-isolated-trial，**不是**全仓绿，**不是**已切换生产，**不是**已提交

标注约定：`已证 / 未证 / 未运行` 严格按现场证据区分；任何「未运行」都不得被读成「已通过」。

---

## 1. 结论与交付层次

| 项 | 结论 |
|---|---|
| 决策 | `decision = candidate-only` |
| 为什么不是 ready | U5/U5C/U6 的真实 provider 链路为 `awaiting-user / not-run / not-run`（实际真实调用 0 次）；没有真实模型运行证据就不能给 `ready-for-isolated-trial` |
| 为什么不是 blocked | 没有安装/重放真实失败：R3 冻结 `passed`、owned replay 同步 `passed`、U4R3 `passed`；缺的是**用户尚未给出**的三项模型输入，不是产品失败 |
| 本轮授权范围是否已交付 | 是：候选冻结（三代包，byte 保留）、干净重放、受控终端 4 合同 + 8 视觉、文档附件与可审核入口全部可复核；不请求用户许可、不等待输入、不自动 U8 |
| 原环境 | `originalEnvironmentChanged = false`（运行面）；用户明确授权的 handoff 追加另见 §9 |

读法硬约束：本文所有计数只对**其自身那一轮命中用例**负责；不同轮次文件重叠，**求和没有意义**，也不构成全量覆盖。

---

## 2. 候选指纹与版本

| 项 | 值 |
|---|---|
| 基线 | HEAD `35e3e7706af99b43578c6771056a4968d08cc601`，分支 `upgrade/pi-1.3.0`，无 staged |
| 当前指纹 | **FP3 `e7b7d7a62cfa3ba6054f316999c4044357cd445f6bd87ba0677b93b2b42eab2d`**（`reports/release/candidate-r3.json`） |
| 前序指纹 | FP2 `e34eee2dd315141d8294352b879f580f27ccbd47db0c206da863372e258de37e`、FP1 `8e54a186f2012d64d74a0d71bff234ee4eb492d22970f01fd80e915b62277f7e` |
| 清单规模 | source 49 + lock 2 + document 9 = **60**（补丁内 54 tracked + 6 份新文档） |
| 完整补丁 sha256 | `3d3813ff6973e41706520181600bbe5b0318ffce5e44a3abbf7aa258f3a70e59`（`evidence/release/r3/candidate.patch`） |
| R2→R3 增量 sha256 | `2f14db9fc28f58acc210eba779af5df9747da0d10e83c3d368f1a0b8803ee0c8`（`delta-from-r2.patch`，仅 fixture） |
| 环境入口 sha256 | `8bf591df9b3bcdef9ba8eea8486af84c3c94f4a0aed6175749a76c6ade9cf30b`（`evidence/release/r3/env/isolated-env.sh`） |
| 隔离说明 sha256 | `d90d204a737356ac2445823dc33903dc8bfe63677ef16355aff48635430b3e25` |

9 个受控版本：Pi 五核心（`pi-agent-core` / `pi-ai` / `pi-codemode` / `pi-coding-agent` / `pi-tui`）精确 `1.3.0`；`pi-subagents` 精确 `0.79.2`；`@amaster.ai/pi-task-scheduler` `0.1.9`、`@amaster.ai/pi-shared` `0.1.9`、`croner` `10.0.1`（scheduler 不升，见 §10）。

**指纹只覆盖运行输入**：`sourceFiles` + `lockFiles` + `packageVersions` + `environmentSha256` + `baseCommit`；纯 `documentFiles`、`patchSha256`、`revision` 各有独立 hash，不参与指纹，也不会因为文档更新而改变 FP3。U7 的文档收尾（本文 + 收尾入口 + 计划勾选）**不改变 FP3**。

---

## 3. 三个必要生产适配（已落地，未提交）

| # | 适配 | 落点 | 不得扩大解读 |
|---|---|---|---|
| 1 | watchdog 身份谓词改为 **Host `Box` 子类同源** | `packages/pi-subagents-enhanced/src/host-runtime/index.ts` | 0.79.2 的 `subagent_watchdog_warning` 由 `renderSubagentMessage` 返回 `SubagentMessageBlock extends Box`；断言 `instanceof tui.Box && constructor !== tui.Box`，异源 `pi-tui` 副本与裸 `Box` 都 fail closed。未跳过 watchdog |
| 2 | fullscreen 滚轮走 **`handleMouse`**（两个 overlay + presenter 纯转发） | `packages/pi-subagents-enhanced/src/tui/session-viewport.ts`、`src/background-activity/detail-controller.ts`、`presenter.ts` | 只改显示投影的滚动来源；**MainScreen raw SGR 分支原样保留**，断言强度未放宽；未为展示改写 raw payload |
| 3 | supervisor 两段 wake 改由 `before_agent_start` 扫描活跃分支并**复用原** `registerSupervisorRequest` | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | 保留 busy `message_end`、durable 去重与 `root+session+requestId` 单飞；**无新 sender、无新授权来源、不改 payload/gate**，handler 仍返回 `undefined` |

## 4. 两个既有夹具迁移（类别 2，非生产放宽）

| # | 迁移 | 落点 | 事实与边界 |
|---|---|---|---|
| 1 | 视觉 helper 追加 `--no-approve` | `test/helpers/background-activity-visual.mjs`（新 hash `05ad2e40d4dbcc8b6b0873da98d79f10faf94fc4613cafe14818c60664e4aad6`） | R1/U4 首轮 base 场景在 `session_start` 之前卡在 “Trust project folder?”；官方 `docs/security.md`/`docs/cli.md` 与 `resolveProjectTrusted` 确认该公开参数对本进程一次性拒绝项目资源信任、不写 trust store。offline/no-mcp/全部资源发现关闭与显式扩展链未变 |
| 2 | lifecycle fixture 消费公开 `session_start.reason` / `previousSessionFile` | `test/fixtures/background-activity-visual.ts`（`c48121b8…` → `2c003589faf4630429357ef127440e11b4031537984ec194a412b9a38cdcc53c`，+4/−2） | R2 的 new→switch 失败来自 fixture 假定模块闭包跨 session 存活；产品按设计在新会话重建 runtime。未引入 sidecar/global cache，未手工拼 production event，未改断言、guard、epoch、timeout 或 driver |

两处都按「来源分类 → 类别 2 只修既有夹具」处理；没有为它们新增 production 兼容分支、新测试或新 fixture。

---

## 5. 验证范围与结果（按轮次分列，不可累加）

| 来源 | 指纹归属 | 结果 | 说明与边界 |
|---|---|---|---|
| R3 冻结（阶段 A） | FP3 | `freezeStatus: passed`，`runtimeVerification: not-run` | 白名单/不变输入/补丁重放/60 项 hash/包自校验真实 exit 0；不代表任何 runtime 检查通过 |
| R3 owned replay 同步（阶段 B） | FP3 | `replay-r3.json.status: passed`，`mode: owned-replay-update` | 60 项实际 hash 全匹配、指纹独立重算一致、9 依赖 + 4 peer realpath 全在 replay 内、17 个步骤真实 exit 0；**不是**第二次/第三次干净安装 |
| U2 既有 SDK/模型/RPC 合同 | **FP1 `8e54a186…`**（真实运行） | 5 个文件各 1 次独立进程，`exit 0`，**13/13 通过、0 失败、0 跳过** | 经 r3 证据映射标 `proved-unchanged`：5 个合同文件 + 4 个 helper 逐 hash 不变，传递闭包不含 R3 改动的 fixture。**不改写** `contracts.json` 的 FP1 归属，也不称 R3 又跑过 |
| 原 U3 干净安装 | **FP1**（真实运行） | `replay.json.status: passed` | 同样按 `proved-unchanged` 复用：2 个 lock、2 个 package.json、env 入口与 9 版本逐 hash 不变，改动 fixture 不在安装输入/安装期脚本闭包内。**不称**第二次安装、不重复 `npm ci`/`typecheck`/`doctor`/`verify:package` |
| 受控 PTY 合同 7/7 | **FP1**（真实运行） | `exit 0`，7/7 | 三个相关文件 hash 与 HEAD 一致且不在 R3 delta 闭包内；U4R3 只引用不重跑 |
| **U4R3 终端验收** | **FP3**（真实运行） | `tui-r3.json.status: passed`；helper 合同 **4/4**、视觉 **8/8** | 4 合同与 8 视觉是**两组独立计数，不加总**；每个 case 单次执行、各自 `.exit`、8 个 Host 全部自然 close `code 0` 且 reap 完整、无任何信号投递；lifecycle 真实到达 new/switch/fork/reload（probe start 5） |
| U5 / U5C / U6 | 选择与授权状态事实 | `awaiting-user` / `not-run` / `not-run`（真实调用 **0**） | 不能读成通过；也不阻塞 U1–U4；`agentProfile=null` 只是角色未定，不是用户输入缺失，也不构成独立 blocker |
| 历史 R1 / R2 | 各自指纹 | **保留原样** | R1 base 失败（信任询问）+ 其后 7 场景 not-run 与 close/reap 缺口、R2 7/8（lifecycle 失败）**永久保留**，不 retag、不改写、不删除 |

### 5.1 RPC 证据的精确范围（不要泛化）

- **已证 RPC wire**：U2 的 `test/joint-upgrade-rpc-wire.test.mjs` 1/1（`workflow-spawn.ts` 生成的 0.75 公开 script 只发 script、不发 `workflowScript`；leaf timeout/worktree 事实经 vm 新上下文验证）。
- **已证 RPC 视觉输出**：U4R3 的 `rpc` 场景——子进程 `exit 0`、stdout 每行合法 JSON、不含 ESC 序列、不含 fixture 私有文本。
- **不成立的推断**：这两条**不**等于「RPC lane 全部已验」，没有据此声明 RPC 整体支持或不支持；RPC 也不代表本仓 owner/queue/proof 语义已被替代。

### 5.2 现场共有的机器事实

U4R3 的 9 个 `.exit`（1 合同 + 8 场景）全为 `0`，无 `tee`/`tail` 替代真 exit；`manualObservations.performed = false`——**没有任何人工观感判定**，agent 读帧只是机器投影，不等于人工验收。

---

## 6. 证据索引（只引用，不复制正文）

| 用途 | 路径（相对独立根 `/Users/leshi.zhy/pi-upgrade-1.3.0`） |
|---|---|
| 当前候选 JSON | `reports/release/candidate-r3.json`（sha256 `c8a0c5b3ee2cafd7bfabd416e32e14605097a2e7834433c77fb468e796959dd0`） |
| R3 冻结包 | `evidence/release/r3/`（`candidate.patch`、`delta-from-r2.patch`、`files.sha256`、`documents/**`、`env/**`、`evidence-map.json`、`freeze-verification.json`、`self-check.json`、`artifacts.sha256`、`logs/**`） |
| owned replay 同步 | `reports/release/replay-r3.json`、`logs/release/replay-r3/**`（17 步各含 stdout/stderr/exit/cmd） |
| 终端验收 | `reports/release/tui-r3.json`、`logs/release/tui-r3/**`（9 个 `*.exit` + 帧与 probe 产物路径） |
| U2 合同（FP1） | `reports/release/contracts.json`、`logs/release/contracts/**` |
| 原 U3 干净重放（FP1） | `reports/release/replay.json`、`logs/release/replay/**` |
| 原 U4 / U4R2（失败保留） | `reports/release/tui.json`、`reports/release/tui-r2.json`、`logs/release/tui/**`、`logs/release/tui-r2/**` |
| 夹具迁移记录 | `reports/release/tui-fixture-correction.json`、`reports/release/tui-lifecycle-correction.json` |
| 真实 provider 状态 | `reports/release/provider-selection.json`、`provider-readiness.json`、`real-smoke.json`（FP1 记录，全部 not-run） |
| 证据复用映射 | `evidence/release/r3/evidence-map.json`（`reusedStatuses` / `closure` / `roundManifestCheck`） |
| 本记录 | `reports/release/readiness.json`、本文 |
| 文档补充附件 | `evidence/release/documentation/`（`documentation-supplement.patch`、`documentation.sha256`、`runtime-inputs.sha256`、`documents/**`、`self-check.json`、`artifacts.sha256`、`README.md`） |

R1 的 400 文件 manifest 当前为 **398/400** 相同，不同项恰是 R2 有意修改的视觉 helper 与 R3 有意修改的视觉 fixture；因此只报告实际相同数，**不声明**无条件的 400/400。

---

## 7. 复现与校验顺序（交付顺序固定）

**正确顺序：最新 R3 full patch → 同六份文档 + env → 文档补充附件。三代 full patch 严禁叠加。**

1. 包完整性：`shasum -a 256 -c evidence/release/r3/artifacts.sha256`（独立根 cwd）。
2. 文件完整性（**文档补充之前**，60 项）：`cd repo && shasum -a 256 -c ../evidence/release/r3/files.sha256`。
3. 指纹一致性：`python3 evidence/release/recompute-fingerprint.py reports/release/candidate-r3.json`。
4. base 新 clone（`35e3e77` 干净、自有 common-dir）→ `git apply` R3 `candidate.patch` → 复制 `evidence/release/r3/documents/docs/**` 六份与 `evidence/release/r3/env/**` → 得到 60 项 FP3 状态。
5. 再应用 `evidence/release/documentation/documentation-supplement.patch`（作用在 R3 文档快照上，仅三份声明文档）或直接复制 `documentation/documents/**` 三份。
6. 文档补充后校验：`runtime-inputs.sha256`（**51 项 = 49 source + 2 lock**，产品 repo 相对路径，**不含文档**）应仍全 OK；`documentation.sha256`（**3 份最终文档**）应全 OK；FP3 重算应仍为 `e7b7d7a6…`。
7. 一次性独立 clone 重放的真实 exit/stdout/stderr 见 `evidence/release/documentation/self-check.json`。

读法提示：**文档补充之后**再拿旧 `files.sha256` 去校验会出现两份文档 hash 变化——那是**合法的文档变化**，不是代码漂移；`runtime-inputs.sha256` 才是补充后的运行输入基线。

---

## 8. 回退

1. 本文与交付包**没有改动**运行面：回退不需要 downgrade npm、不需要 reset 原仓、不需要清理任何受管 workspace。
2. **默认回退方式就是继续用原 `1.0.4` 入口**：原 `~/.zshrc`、全局 skills、全局 Pi 均未被本次升级改动，原终端入口一直可用。
3. 若日后另开隔离新 shell 试用：正常退出该 Shell 即回到原入口，**保留当前独立目录（`repo/`、`replay/`）与全部验证证据即可，无需删除**；用户没有要求清理这些现场，本文也不建议清理。
4. 唯一允许清理的是按 §7 自建的临时文档校验 clone（脚本已自建自删；若残留可按既有记录删除），它不含任何冻结物。R1/R2/R3 冻结物与 `replay/repo` 快照**不参与**任何回退动作。
5. 文档附件可单独回退：重放 R3 的 `documents/**` 六份即回到 R3 文档快照；补充补丁不含任何运行输入。

---

## 9. 原环境与用户授权例外

- 除下方唯一例外，本轮**没有把升级写进原仓运行面**：未在 `/Users/leshi.zhy/pi-config` 安装、测试、启动 Host、写入升级运行状态或切换入口；未执行 `init-pi.sh`；未建立全局入口；原仓的 runtime / 代码 / 依赖 / 配置 / 入口均无升级写入。
- 原仓**不是「从未访问」**：「基线只读核对」与「U1 已披露的一次 `ls` 级范围偏差」是两件不同的事，都在既有记录中披露；本轮不掩饰、也不重新访问核对。
- **用户明确授权的唯一例外（handoff 追加）**：用户明确要求主会话写入会话恢复记录，实际落盘为**两份**：
  - 原仓侧：`/Users/leshi.zhy/pi-config/.pi/handoff/context-handoff.md`
  - 隔离侧（同步副本）：`/Users/leshi.zhy/pi-upgrade-1.3.0/repo/.pi/handoff/context-handoff.md`

  这两份 handoff 是原仓**唯一**已授权的写入；它们自 U1 起即被明确排除在产品补丁、`documentFiles` 与 `candidateFingerprint` 之外。因此 `originalEnvironmentChanged = false` 只指**运行面**（runtime / source / deps / config / 入口）无升级变更，**不能**被读成「原仓无任何写入」，也不能被读成「原仓从未访问」。除该 handoff 外，原仓无其它升级写入。
- 用户后续给出精确 provider/model、有限真实调用授权与独立配置方式时，只重开 U5/U5C/U6 的相应部分，不重跑已证项。
- 本文件对本例外的表述只消费已确认的事实，**不为此访问原仓或任何 handoff 文件**。

---

## 10. 未验范围（未验即未验，不填格子）

来自 `tui-r3.json.unverified` 的 10 条，原样保留：

1. **footer 空行与模型标签**：现有 base 断言只检查 3 条 fixture 行、缩进 3、行宽 78，文件内没有该 case 的明确断言，因此不声称已证。
2. **detail fullscreen 专门行为**（overlay 内滚动/焦点/隐藏）：8 个 case 未覆盖。
3. **多行/加速滚轮**（惯性、`|wheelDelta|>1`）：现有 case 只发单刻度。
4. **真实终端**的惯性/APC 光标表现：本轮只有自造 PTY。
5. 视觉 lifecycle 通过 **不等于** 14 个工具的历史恢复已证。
6. helper 的「source fixture 走公开协议」只证明源文本不含禁用 API，不证明运行时无伪造 production 事件。
7. 本轮未比较 `1.0.4` 与该候选在 lifecycle 行为上的差异（原仓禁访问）。
8. 无真实 provider / MCP / SIGKILL 调用，真实模型端到端仍 `not-run`；尚无真实终端手工观感验收。
9. controlled-pty 7/7 属引用复用，未再运行。
10. lifecycle 的 5 个 start epoch 全为 1：断言只要求 start 计数增长，「新模块 epoch 递增」从未被观测到。

额外边界（沿用收尾入口 §2 与联合评估 §8.4，不重开）：

- busy/held 分支的 supervisor 真实 Host 行为、长会话扫描成本、`details.runs[]` 一一对应、Host 级工具恢复/`/reload`、H2/SIGKILL/五 child/fullglob、跨平台与稳定性压测：均**未验**。
- `joint-upgrade-tool-policy` 按既有禁令（禁止实际运行 MCP）**未执行**；本轮也未调用任何 MCP。
- 2000 字符长结果截断行为未运行验证（该行为来自 `pi-subagents >= 0.77`，不是 Pi 1.3 核心）。
- 因此本交付**不**声称「全仓绿」「Pi 1.3.0 已验收通过」「可以切生产」。

## 11. 冻结的历史事项（不作为升级前置，本轮不重开）

1.0.4 低影响遗留（required-child 诊断顺序 `A2`、typed resume→activation 与跨 Host handoff `C1+C2`、child 作用域 `C3`、空闲通知 `E1`、`resume(model)` `E2`、`pi -c` guard `E3`、scheduler 并发 `D2`、`F8(作)` 五-child 主 Agent 接管）继续冻结；scheduler 保持 `0.1.9`，不升 `0.1.29`。

注意区分：冻结的 `F8(作)`（typed resume → workspace queue activation 的五-child 接管）与 `F8(悬)`（heartbeat 正常结算）**不是同一件事**；本轮 heartbeat 只复用既有 prepare-only 3/3 结论，没有真实父死恢复证据。

它们的恢复讨论条件仍然是「Pi 1.3.0 目标版实际需要」，本文不新增 fallback、不预置修复、不据同名上游功能删除本仓 root broker / workspace-queue-proof / session-owner / queue / proof / gate 能力群。

---

## 12. 本文边界

- 不新增测试、不新增 fixture、不改源码、不跑 test/typecheck/Host/模型/npm/网络、不 stage/commit/push、不切正式入口。
- 不把任何一轮定向验收的计数累加成全仓结论；不把 `not-run` 写成通过。
- 不复制凭据、token、认证头或真实会话数据；文档补充附件只含文档正文与本记录。
- 后续扩大验证时按实际获准范围留证，不能把定向通过外推成全仓兼容。
