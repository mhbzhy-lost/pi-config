# G · 残留问题 R1–R7 逐项确认 与 20 项缺口重叠判定

> 生成时间：2026-09-21（调查进行中，增量落盘）
> 输入：`docs/plans/2026-09-21-subagent-lifecycle-residuals.md`（134 行）＋ `/tmp/wt-analysis/reports/00-INTEGRATED-runtime-gap-report.md` 等 A–E 分项报告
> 约束：只读调查；仅允许写入本文件与 `/tmp/` 临时导出目录

## 0. 调查方法与环境快照

- 只读调查 + 允许运行测试。未修改工作区任何文件；未执行任何 git mutation；`git archive HEAD` 导出目录为 `/tmp/wt-head-export/`（见 §R5）。
- 本 shell 环境快照：`PI_REAL_BIN` 未设置；`which pi` → `/opt/homebrew/bin/pi`（版本 `0.85.1`）；`colima` 0.10.3 存在于 `/opt/homebrew/bin/colima`，**daemon 正在运行**（`colima status` exit=0，输出 `colima is running using macOS Virtualization.Framework`，docker socket `unix:///Users/leshi.zhy/.colima/default/docker.sock`）——这一点比残留清单的「daemon 状态未验证」更新。
- Node 测试运行器：`node --test`（逐文件聚焦运行，见 §2）。
- 断言计数口径：`test/subagent-runtime-membrane.test.mjs` 全文 2047 行、67 个 `test()`、196 处 `assert.<fn>(` 调用（`grep -o 'assert\.[a-z]*(' | wc -l`）。

## 1. R1–R7 逐项确认表

| 项 | 文档声称 | 独立核实结果 | 证据 | 三分法分类 | 是否同意文档分类 |
|---|---|---|---|---|---|
| R1 | resolve→native→commit 三步非原子，并发相同 reply/steer 理论可双投递 | **成立**（代码级证实；并发场景未复现，属理论窗口，与文档口径一致） | `extension.ts:1038-1051`（steer）/`:1072-1081`（reply）；`supervisor-control-plane.ts:73-88,90-96`；`test/subagent-runtime-membrane.test.mjs:1690-1717` | (1) production 缺陷 | 同意 |
| R2 | receipt 幂等检查先于 pending 检查，新 pending 后重试旧 steer 返回旧回执 | **成立**（代码级证实） | `supervisor-control-plane.ts:82-84`（`:82` `receipts.get(key)` 早于 `:83` pending→REPLY_REQUIRED） | 语义边界（设计取舍，非缺陷） | 同意 |
| R3 | `PI_REAL_BIN` 未设置，真实 Pi lane fail 而非 skip | **成立**（已实测 fail：4 tests / 1 pass / 3 fail / exit=1） | `test/pi-subagents-runtime.integration.mjs:13,416-421`；实测输出见 §2 | 环境限制（非代码缺陷） | 同意；且已把 colima daemon 状态从「未验证」升级为「运行中」 |
| R4 | init-pi 测试引用已删目录，HEAD 既有 | **成立**（工作区 + HEAD 导出均复现；且意图已在仓库登记） | `test/init-pi.test.mjs:66`（ENOENT）；`c35c596` 删 13 文件未触 test/；附录 `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md:33,42` | (1) 已登记的实现↔测试期望漂移（遗留债） | 同意（但补正：非隐性漂移，意图已有 commit 记录） |
| R5 | compat "local package source" 期望 reject 实际 resolve，HEAD 既有 | **不成立——无法复现**（工作区×3、HEAD 导出×3、全量套件内×3 均 32/32 pass） | §2 实测矩阵；测试文件自 09-13 未改 | (3) 来源尚未证实（fail closed，观察项） | **不同意**：不应按「HEAD 既有缺陷、高优先」处理 |
| R6 | reviewer 测试失败源于用户预存 reviewer.md 编辑 | **成立**（工作区 1 fail；HEAD 导出 2/2 pass） | `git diff -- pi/agents/reviewer.md`（+4/-1，新增 `codex-pool/gpt-6-astra` 首行）；`r6-run.log`/`r6-head-run.log` | (2) 用户预存编辑↔测试期望漂移，只改测试 | 同意 |
| R7 | BROKER_TIMEOUT 全量负载偶现，单独跑稳定 | **成立**（3 次全量跑复现 1 次；另发现同族新例 durable-lifecycle） | `root-subagent-broker.test.mjs:394,429`（测试自传 `timeoutMs:500`）→ `root-broker-client.ts:169`；`durable-lifecycle.test.mjs:58,65`（`staleLockMs:1`） | (2) 测试制造的时序敏感 | 同意（机制修正：500ms 测试 deadline，非 5s production deadline） |

### R1 控制面 resolve→native→commit 非原子

**核实：成立（代码级）。**

三步序列在两处接线均可实证：
- steer：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1038`（`resolveSupervisorControl`）→ `:1043`（`await rpc[action](params)` native 发送）→ `:1047`（`commitDelivery` 写 receipt）；失败分支 `:1051`。
- reply：`extension.ts:1072`（resolve）→ `:1075`（`adapter.execute` native）→ `:1077`（commit）。

`resolveSupervisorControl`（`supervisor-control-plane.ts:73-88`）是纯判定：除 `:85` 过期时 `pending.state = "expired"` 外不翻转任何状态；receipt 只在 `commitDelivery`（`:90-96`，具体写点 `:94` `receipts.set(...)`）落盘。因此两个**并发**相同 reply（同 requestId/requestGeneration/payloadDigest）或相同 steer（同 runId/ownerGeneration/payloadDigest/liveRunEpoch）都会在任一方 commit 前拿到 `{status:"allowed"}`，各自调 native → 双投递。顺序重试则命中 `:82` `receipts.get(key)` 返回 idempotent，不再调 native。

现有测试确实只覆盖顺序幂等：`test/subagent-runtime-membrane.test.mjs:1690` "configured supervisor control plane fences reply and steer delivery..." 中 `:1712`/`:1715` 两次断言 `nativeCalls === 1`，但两次 reply 调用是**先后 await**（`:1707`/`:1709`），全文件仅 3 处 `Promise.all`（`:144,:804,:807`）且无一是并发 control-plane 用例。文档的「现有测试只覆盖顺序重试幂等」**成立**。

文档还提到「第一版曾有 `pending.state = "replying"` 但被移除」：该文件是本批次 untracked 新文件，无 git 历史可考，此历史细节**无法独立证实**，但不影响现行为判定（当前代码确实无状态翻转）。

另录一个文档未提的相邻事实（不改变 R1 结论）：`commitDelivery` 对失败投递也写 receipt（`status:"failed"`，`extension.ts:1051/:1080`），此后同 intent 重试会在 `:82` 命中幂等返回 failed receipt——即**失败投递也无法重试**。这是与 R1 同族的幂等语义边界，修复 R1 的 in-flight 设计时应一并考虑 failed receipt 的重试语义。

### R2 steer 幂等检查先于 pending 检查

**核实：成立（代码级）。**

`supervisor-control-plane.ts:82-84` 顺序：
```ts
const prior = receipts.get(key); if (prior) return { status: "idempotent", receipt: prior };  // :82
if (pending && intent.kind === "steer") return blocked("SUPERVISOR_REPLY_REQUIRED");          // :83
if (!pending && intent.kind === "reply") return blocked("SUPERVISOR_REQUEST_NOT_PENDING");   // :84
```
steer 的 pending 查找在 `:78-80`（按 runId+rootSessionId+ownerGeneration 匹配任意 pending）。故「steer 已投递（有 receipt）→ 同 run 新 pending 到达 → 重试旧 steer（同 payloadDigest+同 liveRunEpoch）」会命中 `:82` 返回旧 receipt 而非 `SUPERVISOR_REPLY_REQUIRED`，与文档描述完全一致。单投递不变量不受影响（不二次发送），模型可能误判 steer 已生效而漏对新 pending 的 reply——语义边界定性**同意**。

（R2 两方案评估见 §3。）

### R3 PI_REAL_BIN 未设置，真实 Pi lane 无法运行

**核实：成立（环境实况 + 实测 fail）。**

- `process.env.PI_REAL_BIN` 在本机未设置（`echo` 输出空）。
- `test/pi-subagents-runtime.integration.mjs:13` `const piBinary = process.env.PI_REAL_BIN;`；`:416-417` 第一个 test 内 `assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime")`——在 test body 内直接断言，**fail 而非 skip**。实测：`node --test test/pi-subagents-runtime.integration.mjs` → **4 tests / 1 pass / 3 fail / exit=1**，失败形态两种：`assert.ok` 版本测试失败 + 其余 2 个场景测试 `TypeError [ERR_INVALID_ARG_TYPE]: The "file" argument must be of type string. Received undefined`（`spawn(piBinary=undefined)`，`:50`）。
- `npm run test:subagents`（`package.json:14`）即指向该文件，同样不可运行。
- `/opt/homebrew/bin/pi` 存在，`pi --version` = **0.85.1**，且在 `scripts/probes/pi-subagents-compat.ts:41` 的 `SUPPORTED_PI_VERSIONS`（含 `"0.85.1"`）内；upstream 依赖 `packages/pi-subagents-enhanced/node_modules/pi-subagents` 版本实测 **0.62.0**，与测试 `:421` 断言一致。即文档说的「确认版本兼容 0.85.1 + pi-subagents@0.62.0」**已可正向证实**，`PI_REAL_BIN=/opt/homebrew/bin/pi` 是兼容值。
- colima 0.10.3 存在且 **daemon 正在运行**（`colima status` exit=0），比文档「daemon 状态未验证」更进一步。

### R4 init-pi 测试失败（external-llm-review 已删）

**核实：成立（工作区实测 + commit 实证 + 意图已在仓库记录）。**

- 实测（工作区）：`node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs` → **2 tests / 1 pass / 1 fail / exit=1**。失败：`init-pi.sh reproducibly installs Pi without reading OpenCode credentials`，`Error: ENOENT ... copyfile '/Users/leshi.zhy/pi-config/skill-overrides/external-llm-review/reviewer.py'`，抛点 `test/init-pi.test.mjs:66`。
- `git show c35c596 --stat`：2026-09-18 17:43 `refactor(skill): 移除 external-llm-review 覆盖目录`，删除 13 文件 / 3272 行（含 `reviewer.py` 734 行）；**未触碰任何 test/ 文件**（`git show c35c596 --name-only | grep -c test/` = 0）。
- 意图已在仓库记录（文档说「需向用户确认意图」，但 commit message + 附录已写明）：c35c596 message 原文「init-pi.sh 与 init-pi 测试对目录的引用属遗留债，已归档于测试分类附录」；附录 = `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md:33,42`（目录 2026-09-14 先被工作区删除，2026-09-18 随 c35c596 提交；遗留引用含 `init-pi.sh:104` 与 `test/init-pi.test.mjs`，「待该工作流收尾时处理」）；两个计划终报也登记过：`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:1004`、`docs/plans/2026-09-16-durable-fifo-resumed-child.md:387`。
- 遗留引用全景（均为 stale，只有 ：66 实际报错）：`test/init-pi.test.mjs:60,66-69,150`（copyFile + 命令串断言）；`test/external-review-config-home.test.mjs:15,25-28`（**仅字符串拼接断言、不检查文件存在，故通过**，引用同样 stale）；根目录 `init-pi.sh:104`（`python -m unittest discover -s skill-overrides/external-llm-review/tests`，指向已删目录）。
- HEAD 既有性：在 R5 的 `/tmp/wt-head-export/`（HEAD 快照）中验证 `node --test test/init-pi.test.mjs` 同样 ENOENT 失败（见 §2），与生命周期批次无关 ✓。

**三分法：** (1) 类边缘——production 决策（删目录）已提交而测试期望未同步，属「实现与测试期望漂移」的**已登记**遗留债（非隐性漂移）。同意文档「HEAD 既有缺陷」定位；修复方向应与 c35c596 意图对齐（同步引用，而非恢复目录）。

### R5 compat "local package source" 期望 reject 实际 resolve

**核实：不成立——无法复现（与文档结论相反）。**

实测矩阵（断言点 `test/pi-subagents-compat.test.mjs:244-247` `assert.rejects(... SUPERVISOR_TARGET_UNAVAILABLE)`）：

| 环境 | 次数 | 结果 |
|---|---|---|
| 工作区（含全部未提交生命周期改动） | 3 | **32/32 pass，exit=0** |
| `git archive HEAD` 导出（`/tmp/wt-head-export/`，符号链接两处 node_modules） | 3 | **32/32 pass，exit=0** |
| 全量 `npm test` 套件内（负载下） | 3 次全量 | 套件内通过（套件失败仅 R4+R6，见 §2） |

即文档声称的「工作区失败 + HEAD 导出同样失败」在 2026-09-22 当前环境**均不复现**。辅助事实：该测试文件自 2026-09-13 起无未提交修改（与 HEAD 同内容）；`supervisor-adapter.ts` 自 2026-09-09 未改；`extension.ts`/`subagent-runtime.ts` 最后修改 2026-09-21 20:55-20:56；残留清单文件 mtime 2026-09-22 11:53。

**可能解释（未证实，仅列出）：** 文档观察窗口（P0–P6 执行中，09-20/21）与现在之间存在环境漂移（全局 pi 版本、node_modules 状态、当时未提交文件中间态）；或其导出复跑缺 node_modules 链接导致 host 解析路径不同。无法从现有证据区分。

**三分法：** (3) 来源尚未证实——按门禁 fail closed：不视为 production 缺陷、不进修复批次，列为观察项；若再次出现，先 `git archive` 归因 + 保留现场再分类。**不同意文档「HEAD 既有缺陷、高优先」的处置**；文档自己的警告（「先归因、不预设回归」）同样适用于「不预设缺陷」。

### R6 reviewer-agent 测试失败（用户预存 reviewer.md 编辑）

**核实：成立（实测 + diff 实证；HEAD 干净导出通过）。**

- 实测：`node --test test/reviewer-agent.test.mjs` → **2 tests / 1 pass / 1 fail / exit=1**。失败：`reviewer and executor profiles keep configuration out of their operating instructions`，`AssertionError: The input did not match the regular expression /^models:\n  - openai-codex\/gpt-6-astra\n.../`，实际 models 列表首行多了 `codex-pool/gpt-6-astra`。
- `git diff -- pi/agents/reviewer.md`（+4/-1）：① models 列表头部新增 `  - codex-pool/gpt-6-astra`（在既有 `openai-codex/gpt-6-astra` 之上）；② 指令文案两处修改（新增「计划审阅与成果验收…综合评估」句 + bash 注意句措辞）。文件 mtime 2026-09-21 20:49。
- HEAD 导出（`/tmp/wt-head-export/`）中该测试 **2/2 通过**（见 §2），证实失败完全由工作区预存编辑引起 ✓。
- 文件为 ` M`（未提交、tracked），不在生命周期批次 WritePaths 内；本次未回滚，保持原样 ✓。

**三分法：** (2) 用户预存编辑与测试期望漂移——只改测试期望（待用户裁决），不动 production。同意文档分类。

### R7 BROKER_TIMEOUT 全量负载下偶现 flake

**核实：成立（3 次全量跑复现 1 次，机制比文档更精确）。**

- 单独跑：`node --test test/root-subagent-broker.test.mjs` → **39/39 pass，exit=0**（与文档「单独重跑稳定 39/39」一致）。
- 全量 `npm test`（node v26.8.1，每次约 31–33s）：第 1 次 955/953（仅 R4+R6）；第 2 次 955/**951**——R4+R6 之外多 2 个 flake：
  1. `test/root-subagent-broker.test.mjs:394` `authenticated Executor submits bound acceptance evidence only after its durable context exists` → `Error: Root broker request timed out`（stack 落 `root-broker-client.ts:169`，`BROKER_TIMEOUT`）；
  2. `test/durable-lifecycle.test.mjs:56` `storage quarantines demonstrably stale lock and refuses live lock` → `AssertionError: Missing expected rejection`（`:65`）；
  第 3 次 955/953，无 flake。
- **机制修正：** 文档说「5s RPC deadline 偶超时」，但 flake 用例用的是**测试自传的 `timeoutMs: 500`**（`test/root-subagent-broker.test.mjs:429`），非 production 默认 10s（`root-broker-client.ts:109`）、也非 recovery 的 `RECOVERY_RPC_DEADLINE_MS = 5_000`（`authority-contract.ts:3`，用于 `owner.read/rebind/revoke`，`root-broker-client.ts:253-255`）。500ms socket 往返在 955 测试并发下偶发超时——「测试稳定性」定性更稳固。
- **新发现（文档未列）：** `test/durable-lifecycle.test.mjs:56` 与 R7 同族但不同机制：测试设 `staleLockMs: 1`（`:58`），`:61` 仅等 5ms 后 `:64` 拿 `live` 锁、`:65` 立即断言第二次 `acquireLock("live")` 被 `DURABLE_LOCK_HELD` 拒绝——事件循环负载下延迟 >1ms 时锁被判 stale 而被成功接管，断言落空。建议并入批次 D。
- 全量套件每次 31–33s（远低于 15 分钟阈值），故跑 3 次。**判定：测试负载/时序问题，非 broker deadline 的 production 风险**（production 5s/10s deadline 未被证伪；R7 与本次调查的 3 次上游响应流中断亦不同源，见 §4）。

**三分法：** (2) 测试制造的非预期时序（测试自设紧 deadline/stale 阈值）。同意文档分类，补充 durable-lifecycle 同族新例。

## 2. 实际测试运行记录

环境：node v26.8.1；cwd = 仓库根；日志存 `/tmp/wt-analysis/*.log`。

| # | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `node --test test/pi-subagents-runtime.integration.mjs`（R3，无 PI_REAL_BIN） | 1 | 4 tests / 1 pass / **3 fail**：`assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime")`（`:417`）×1 + `TypeError [ERR_INVALID_ARG_TYPE]: The "file" argument ... Received undefined`（spawn(undefined)，`:50`）×2。`r3-run.log` |
| 2 | `node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs`（R4） | 1 | 2 / 1 pass / 1 fail：`ENOENT ... copyfile '.../external-llm-review/reviewer.py'`，抛点 `test/init-pi.test.mjs:66`。`r4-run.log` |
| 3 | `node --test test/pi-subagents-compat.test.mjs`（R5，工作区） | 0 | 32/32 pass ×3 次。`r5-worktree-run{,-1,-2}.log` |
| 4 | `git archive HEAD` → `/tmp/wt-head-export/`（+两处 node_modules 符号链接）后同命令 | 0 | 32/32 pass ×3 次。`r5-head-run{,-1,-2}.log` |
| 5 | `node --test test/reviewer-agent.test.mjs`（R6） | 1 | 2 / 1 pass / 1 fail：models 正则不匹配（实际多 `codex-pool/gpt-6-astra` 首行）。`r6-run.log` |
| 6 | HEAD 导出内：`node --test test/reviewer-agent.test.mjs`；`node --test test/init-pi.test.mjs` | 0 / 1 | reviewer 2/2 pass（R6 预存编辑归因 ✓）；init-pi 同 ENOENT 失败（R4 HEAD 既有 ✓）。`r6-head-run.log` / `r4-head-run.log` |
| 7 | `node --test test/root-subagent-broker.test.mjs`（R7 单文件） | 0 | 39/39 pass。`r7-single-run.log` |
| 8 | `npm test`（第 1 次） | 1 | 955 / 953 / 2 fail（= R4+R6）；无 BROKER_TIMEOUT；31.5s |
| 9 | `npm test`（第 2 次） | 1 | 955 / **951** / 4 fail：R4+R6 + broker `:394` BROKER_TIMEOUT + durable-lifecycle `:65` Missing expected rejection |
| 10 | `npm test`（第 3 次） | 1 | 955 / 953 / 2 fail（= R4+R6）；无 flake |
| 11 | `pi --version`；`colima status`（R3） | 0 / 0 | pi `0.85.1`；colima 0.10.3 running（Virtualization.Framework） |
| 12 | `git show c35c596`（R4 归因） | 0 | 删 13 文件 3272 行，未触 test/；message 自认遗留债 |

辅助只读命令：`git status/diff/log/show/ls-files`、`grep/awk/sed`、`stat`、`ls`、`cat`（queue/proof 现场 JSON）。`git archive HEAD` 导出仅在 `/tmp/wt-head-export/`，未影响工作区。

## 3. R2 技术决策评估（两方案对比，待裁决）

### 关键新证据：P3-T6 合同本身写的是 pending-first

`docs/plans/2026-09-20-subagent-lifecycle-overall.md:274`（P3-T6 接口契约）原文：

> `resolveSupervisorControl({intent,currentOwner,now})` **先加载当前 generation 的 pending request：存在匹配 pending 时只允许 reply**，无 pending 时 reply 返回 `SUPERVISOR_REQUEST_NOT_PENDING`，且仅当 `isRunRunningAndSteerable(...)` 为真才允许新 `steer`。

即：当前实现的「receipt 检查在前」（`supervisor-control-plane.ts:82` 先于 `:83`）与已写下的 P3-T6 合同（`:274`）语义存在偏差——方案①不是新设计，而是**把实现对齐到已验收计划自己写的合同**。

### 断言影响面实测（修正文档的「66 个」口径）

- 「66 个 membrane 断言」无法精确对上任何自然区域：整个 `test/subagent-runtime-membrane.test.mjs` 2047 行、67 个 `test()`、**196 处 `assert.<fn>(`**；supervisor 区域（1665–2047）= 68 处；control-plane 区域（1690–2047）= 63 处；两个 control-plane 专属 test（`:1690-1717` fencing + `:1721-1757` fails-closed）合计 **12 处**。文档的 66 应理解为「control-plane 相关回归面」的近似值。
- 更关键的是：**三个测试文件（membrane / supervisor-adapter / dispatch-rpc）中唯一的幂等重试断言是 membrane `:1713-1714`（reply 重试→同一 receiptId）**，属于 reply 路径；**没有任何既有断言锁定「steer 已投递 + 新 pending → 返回旧回执」这一顺序**（那正是 R2 描述的缺口本身）。因此方案①（只要按下面建议限定在 steer 分支）的既有断言改动感 ≈ 0，「回归 66 个断言」是回归运行范围而非预期失败数。

### 两方案对比

| 维度 | 方案①：pending 检查前移 | 方案②：幂等回执附 `pendingNotice` details 字段 |
|---|---|---|
| 语义 | 存在 pending 一律优先 reply，与 P3-T6 合同文本（`:266`）一致 | 维持现状，仅提示 |
| 对 reply 路径影响 | **必须豁免**：reply 的幂等键绑定 requestId，重试已 replied 的 request 时无 pending，若也前移会返回 `REQUEST_NOT_PENDING` 而破坏 `:1713-1714` 锁定的顺序幂等。故①只能限定 steer 分支（`:83` 移到 `:82` 之前，`:84` 不动） | 无 |
| 对 steer 路径影响 | 「已投递 steer + 无 pending」的合法顺序重试仍返回幂等回执（不变）；仅「已投递 steer + 新 pending」从旧回执变为 `SUPERVISOR_REPLY_REQUIRED` | 行为不变，模型可能仍误判 steer 已生效而结束 turn（R2 担心的漏 reply 依旧，只是多了提示） |
| 既有断言改动 | ≈ 0（唯一幂等断言在 reply 路径，不受 steer 分支前移影响） | 0 |
| schema 面 | 无新增字段 | `SupervisorDeliveryReceipt` 新增可选字段（向后兼容，但要在 fencing test 锁定其不进 raw payload/TUI 原则边界） |
| 与 R1 in-flight 锁的交互 | 正交，可同批 | 正交，可同批 |

### 推荐（待裁决）

**推荐方案①（限定 steer 分支的 pending-first）**，理由：(a) 对齐 P3-T6 已写合同；(b) 既有断言零改动、回归面清晰；(c) 方案②保留了错误语义、只加提示，模型端可忽略，R2 描述的漏 reply 风险仍在；(d) ①的「已投递 steer+新 pending→REPLY_REQUIRED」会让模型显式转向 reply，行为可预测。若裁决采纳②，需同时补一条测试锁定 pendingNotice 不改 raw payload。**此项为待主 agent/用户裁决的技术决策，本次未实施。**

## 4. R1–R7 与 20 项缺口（B1–B4/H1–H9/M1–M7）重叠判定表

| R项 | 判定 | 论证（证据） | 合并方式 |
|---|---|---|---|
| R1 | **与 M5 部分重叠（同域不同操作面），修复上独立新项** | M5 指 spawn RPC 无操作级 retry/幂等身份，盲重试 spawn 有重复派发风险（`root-broker-client.ts:70-154`、E 报告 M5 行）；R1 指 reply/steer **已有** receipt 幂等（`supervisor-control-plane.ts:82`）但缺并发 in-flight 锁。同一问题域（操作级 exactly-once），不同操作：本批 receipt/idempotency-key 机制是 M5 所求模式在 supervisor control 面的实例，**不覆盖 spawn**。M5 原判定不变 | R1 留批次 A；计划 C 的 M5 设计时**复用** control-plane 的 idempotency-key + in-flight 模式（设计参照，不共用代码）；不冲突 |
| R2 | **独立新项** | control-plane 内部检查顺序语义，与 20 项无对应；且属 P3-T6 合同对齐（§3） | 批次 A，随 R1 |
| R3 | **与 B3 协同（同一体制缺口），非修复重叠** | R3 是环境 gating（lane fail-not-skip：`...integration.mjs:417`；五-child 验收 probe 硬要求 `scripts/probes/repository-merge-queue-acceptance.ts:576-577`「never substitutes a fake model」）；B3 是 production claim 断点。两者不共享代码路径，但共享「真实环境验收长期缺位」根因（§5 详论）。注意 Task 10 已勾项 `...merge-queue.md:917` 证明 09-12 当晚 PI_REAL_BIN 可用，故 R3 并非步骤 8 未勾的直接原因，而是现在补跑的持续障碍 | R3 的补跑动作并入计划 A 的 live 验收门：确认 PI_REAL_BIN → 补跑 `test:subagents` + `repository-merge-queue-acceptance.ts --roots 2 --subagents 5 --require-conflicts 4`，与 B3 回归基线同 lane |
| R4 | **与 B1 同族（实现↔测试期望漂移），不同实例，不合并修复** | B1 = 修复打在孤儿 `src/subagent-dispatch/ir.ts` + 测试 import 孤儿 → **假绿**；R4 = production 删目录 + 测试仍 copyFile → **真红**（天然 RED）。方向相反、文件不重叠（B1：contracts/dispatch-ir.ts 等；R4：test/init-pi.test.mjs）。共同点是测试未对齐 canonical production 状态，且都是「登记过的债未被体制收敛」 | R4 独立小批或并入计划 B 尾部；与 B1 在同一计划内治理但不同 WritePaths |
| R5 | **暂无法判定（观察项，不入任何计划）** | 无法复现（§R5 矩阵：9 次运行全过）。主题上其断言面（`supervisor-adapter.ts:31` / `extension.ts:1486` 的 target 绑定）与 B2/H9 有 extension.ts 文件交集，但零失败证据，无法论证重叠或独立 | 不并入；若复现：先 `git archive` 归因 + 保留现场，再按门禁分类 |
| R6 | **与 H8 关联非因果（同一 astra 接入语境）** | 编辑内容确实是新增 `codex-pool/gpt-6-astra`（git diff）。但 live 失败（`MODEL_NOT_AVAILABLE: astra; agent=reviewer`，JSONL L276/277）机制是裸昵称 `astra` ≠ id 段 `gpt-6-astra` 的精确匹配必然失败（B 报告 §3.5 `:260-262`），与 reviewer.md 是否多声明一个 provider 无关——HEAD 本就声明 `openai-codex/gpt-6-astra`（diff 上下文行可证）。第二次失败 L318 是 executor 的 `qoder-pool/gpt-6-astra`（完整 id 但 catalog 不可用），更与 reviewer.md 无关。两者共享的只是「gpt-6-astra 接入」这一动机语境；H8（无候选清单）放大了恢复成本但非编辑所致 | 不合并；H8 照计划 B 修（错误文本带候选清单会让 astra 类失败一次改对）；R6 待用户裁决后仅同步 `test/reviewer-agent.test.mjs` 期望 |
| R7 | **独立新项（测试稳定性），与 3 次上游流中断不同源** | R7 = 本地 Unix socket + 测试自传 `timeoutMs:500`（`root-subagent-broker.test.mjs:429`）在 955 并发测试负载下超时；上游流中断 = LLM provider（codex-pool/gpt-5.6-sol）HTTP 流断，属 provider/网络层，与 broker socket 无共享机制。production broker deadline（5s/10s）未被证伪 → 非 production 风险 | 独立批次 D；**并入新发现的同族例** `durable-lifecycle.test.mjs:56`（`staleLockMs:1` 时序敏感）；两者均只改测试文件 |

**对 E 报告映射的一处修正：** E 报告将 H7（paused run 无 cancel）归为「已规划未执行 → lifecycle-overall P3-T6」。但本次直读 P3-T6 合同（`2026-09-20-subagent-lifecycle-overall.md:256-285`）：其范围是 Supervisor request/reply/steer 控制面 + progress stall，**不含 paused-run cancel/改态**；control-plane 的 `SupervisorRequestV1` 状态集（pending/replying/replied/expired/failed）是 request 投递状态，不是 run 状态，无 paused 迁移。P3-T6 完成也不解决 H7——**H7 应改判为无既有计划覆盖的独立缺口**（upstream `pi-subagents@0.62.0` `src/extension/rpc.ts:668-680` 硬限 `state==="running"`，E 报告引用），维持延后但需重新归属。

## 5. 「真实环境验收长期缺位」体制性缺口论证（R3 × merge-queue Task 9 步骤 8 × live 0/1）

三个事实均经本次直接复核：

1. **R3（当下障碍）：** `PI_REAL_BIN` 未设置；lane 设计为 fail-not-skip（`test/pi-subagents-runtime.integration.mjs:417`，实测 3 fail/exit=1）；五-child 验收 probe 明确拒绝任何替代（`scripts/probes/repository-merge-queue-acceptance.ts:576-577`：`acceptance probe never substitutes a fake model`）。即真实环境 lane 无自动 fallback，环境变量是手工门槛。
2. **Task 9 步骤 8（计划性欠账）：** `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md:826-834` `- [ ]` **未勾**（今日直读确认），它是该计划唯一的真实五 Subagent live 验收门。同时 Task 10 把「child `awaitIntegrationAdmission()` 同步触发 claim、admissionGeneration 0→1」写成独立验收条款（`:892`）并在 `:913-920` **勾选通过**，`:919` 勾选项证明 09-12 当晚 `PI_REAL_BIN=/opt/homebrew/bin/pi` 的真实 runtime 合同测试跑过；更硬的是 `:988` 也已勾选「public child committed → enqueue → agent_end → admissionGeneration 从 0 变为 1 → rebase/publish 完成全链确定性验证（非 LLM production wiring）」——而 live 现场 item 至今 `admissionGeneration: 0`。
3. **live 现场（必然后果）：** 本次直接读现场 JSON：`integration-queue/queue-index.json` 仅 1 项 `0ed45c9b...`，`state="queued", attempt=1, revision=3, admissionGeneration=0, workspaceId=3b8d0a57`；`queue-meta.json` `nextSequence=2`；`terminal-proof-outbox/terminal-proofs.json` 5 项 pending 全 `observed, conflict=false`，`receipts` **空**。与 C/E 报告记录一致。

**论证：** 三者构成同一根因的两个层面——

- **直接机制**是 production 缺陷（B3：coordinator 从未 claim，`queued→admitted` 断点；proof settle 失效）。R3 不产生 B3。
- **体制层**解释了 B3 为何能带到 live：验收体制产出假信号——合同级/隔离环境测试全绿且被勾选（Task 10 `:913-920`、`:988`），而唯一能暴露 claim 断点的真实环境验收门（步骤 8）从未执行；该门不可伪造（probe :576-577），又依赖手工环境变量（R3）。真实环境验收因此没有常设 lane，每次真实实践都是首发实验：用户 09-20 的 live 会话成为该链路第一次真实运行，得到 queue 0/1、proof settle 0/5。
- **诚实边界：** 步骤 8 未勾的原因无记录可证是「环境不可用」（Task 10 已勾项证明当晚环境可用），更可能是排期/收尾遗漏；R3 是「现在也无法补跑」的持续障碍而非当初未跑的原因。因此三者是**同一体制缺口的三个表现**（无常设真实验收 lane → 计划门不勾 → live 首发必炸），而非互为因果的链条。

**结论：成立，判定为同一根因。** 修复顺序建议：先修 B3 claim 断点（计划 A 第一优先），再把「确认 PI_REAL_BIN + 补跑五-child 验收（Task 9 步骤 8 的 probe）」建制化为常设回归门（R3 并入计划 A），避免「修完仍无法验证」的 E 报告 §8.1 假 ACCEPTED 重演。

## 6. 合并后的批次建议（含 WritePaths 与串并行判定）

**共同硬前置（E 报告 §8.3，本次重申）：** owner 先对工作区 17 个 tracked 修改 + 大量 untracked 生命周期文件做 commit/discard 决策并固定基线；批次 A'/D 的全部目标文件都在这批未提交产物内。

| 批次 | 内容 | WritePaths | 串并行 |
|---|---|---|---|
| **批次 A'（lifecycle 收尾，先行）** | R1（in-flight 锁）+ R2（steer 分支 pending-first，按 §3 裁决）+ R7 + durable-lifecycle flake（均为测试时序修复） | `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`.../extension.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/root-subagent-broker.test.mjs`、`test/durable-lifecycle.test.mjs`（回归面另含 `test/subagent-supervisor-adapter.test.mjs`、`test/subagent-dispatch-rpc.test.mjs`，只跑不改） | R1+R2 同文件同语义面**串行**；R7/durable-flake 与 R1/R2 的 WritePaths 不重叠（测试文件 vs production 文件），批内可并行 |
| **计划 B（零冲突合同速修，不变）** | B1/H8/M2/M4 | `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`、`src/subagent-dispatch/ir.ts`（删除）、`model-selection.ts`、`ledger.ts`/tool 文案、`test/subagent-dispatch-validation-errors.test.mjs` 等合同测试 | **与批次 A' 可并行**（无文件交集）；与计划 A/C 亦无交集 |
| **R4 小批（并入计划 B 尾部或独立）** | 同步 init-pi 测试/脚本对已删目录的引用（前置：用户裁决） | `test/init-pi.test.mjs`（必须）、`test/external-review-config-home.test.mjs` + `init-pi.sh:104`（stale 引用顺带） | 与所有批次无文件冲突，**可并行** |
| **R6 处置（用户裁决后）** | 若确认编辑：仅同步 `test/reviewer-agent.test.mjs` 期望 | `test/reviewer-agent.test.mjs` | 可并行；不碰 `pi/agents/reviewer.md`（用户自处） |
| **计划 A（+R3）** | B3/B4/H2/H5/H1/H6/M1 + **R3 环境确认与补跑**（`PI_REAL_BIN` → `test:subagents` + `repository-merge-queue-acceptance.ts --roots 2 --subagents 5 --require-conflicts 4`，建制化为常设 live 回归门） | workspace/coordinator/queue/proof 文件族（`service.ts`、`coordinator-server.ts`、`integration-queue.ts`、`git-worktree.ts` 等）；R3 本身无代码 WritePaths | 与批次 A'/计划 B 无文件交集，**可并行**；但须先与 merge-queue T10/T11 语义对齐（E §6.3）；建议先于计划 C |
| **计划 C（合同面重构，后置）** | B2/H3/H9/M3/M5/M6/M7 | `extension.ts`（双热点）、contracts、`rpc-client.ts`、skill | **必须串行于批次 A' 之后**（extension.ts 冲突）；M5 设计参照批次 A' 的 receipt+in-flight 模式 |
| **延后** | H4（→P6-T9）、H7（改判无既有计划覆盖，需重新归属） | — | — |
| **R5** | 观察项，不入批 | — | 若复现：先 git archive 归因 |

串行链：批次 A' → 计划 C；其余（计划 B、R4、R6、计划 A）与批次 A' 及彼此 WritePaths 不重叠，可并行。验证命令：R1/R2 沿用文档给出的 `node --test test/subagent-runtime-membrane.test.mjs test/subagent-supervisor-adapter.test.mjs test/subagent-dispatch-rpc.test.mjs && npm run typecheck:subagents-enhanced`。

## 7. 需要用户裁决的项清单

1. **R3（环境）：** 确认 `PI_REAL_BIN=/opt/homebrew/bin/pi`（本报告已验证：pi 0.85.1 ∈ `SUPPORTED_PI_VERSIONS`（`scripts/probes/pi-subagents-compat.ts:41`）、upstream pi-subagents 0.62.0 就位、colima 0.10.3 daemon 运行中）或改用 Colima lane；裁决后补跑 `PI_REAL_BIN=... node --test test/pi-subagents-runtime.integration.mjs` 与 `npm run test:subagents`，并与计划 A 的五-child 验收同批执行。
2. **R4（c35c596 意图）：** 意图已有仓库记录（commit message + `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md:33,42` 附录，自认遗留债）——真正的选择是「现在收尾同步引用」vs「留给 external-review 工作流收尾」；若现在收尾，修复方向应为同步 `test/init-pi.test.mjs`（及顺带 `test/external-review-config-home.test.mjs` 字符串引用、`init-pi.sh:104`），恢复目录与 commit 意图相悖。
3. **R6（reviewer.md 处置）：** 三选一（文档已列）：确认编辑→同步测试期望；放弃编辑→用户自行 checkout；提交编辑→再同步测试。不得由 agent 代为回滚。
4. **R2（方案二选一）：** 本报告推荐方案①（限定 steer 分支的 pending-first，对齐 P3-T6 合同文本，既有断言零改动）；详见 §3，**待裁决，未实施**。
5. **（提醒，主 agent 已知）工作区未提交生命周期改动的 commit/discard**：批次 A'、计划 C 及一切后续修复的硬前置（E 报告 §8.3）。
6. **（低优先，可不裁决）durable-lifecycle flake 并入批次 D**：建议直接并入，无争议。
