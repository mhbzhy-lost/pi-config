# H2 实际父死 heartbeat 验收记录

## 结论（先给终态，不外推）

**本记录严格区分两件事：**

1. **heartbeat 核心验收 = VERIFIED（通过）**。父 Host 被一次真实 SIGKILL 后，managed child/runner 在已记录 lease 窗口内自行退出，harness 零补杀，残留进程为零。证据见下与「合同逐项验收」。
2. **fixture workspace cleanup = PENDING（独立 blocked-environment，未执行、未通过、未失败于心跳）**。root owner 被本实验刻意杀死，public `subagent_worktree status` 无存活调用方，故 `allowed_dispositions`/`action_token` **客观不可产出**。**不得宣称 workspace 已 released/discarded**；台账权威值仍为 `state:"active"`。该子项**不阻塞、不推翻**已证心跳结论（主管裁决，见「主管裁决」节）。

**H2 heartbeat 通过。**唯一授权门禁命令实际 **exit 0**，`tests 3 / pass 3 / fail 0 / skipped 0 / cancelled 0 / todo 0`，Host 用例 **79871.475292ms**。全新隔离 fixture 根 `hb-BXRJmy` 上：prepare readiness 全字段真实达成后，harness 对**其直接 spawn 的父 Host PID 91331 发出且仅发出一次 SIGKILL**（`parentExit {code:null, signal:"SIGKILL"}`，killAt→parent 消失 **12ms**）；managed child/runner（PID 91468，`runnerPid===childPid`）**未被任何补杀**，在已记录 lease 窗口内**自行消失**：`killAt 11:52:59.310Z` → `expiresAt 11:53:59.140Z`（+59830ms，父死后无任何续租）→ `childExitAt 11:54:01.759Z`（expiresAt 后 **2619ms**，落在 watchdog 5s 到期轮询粒度内），**latencyMs 62449**，`childIdentityEnd.state:"absent"`（精确 `ps` 缺失佐证，非仅 birth 不符 → 排除 PID 复用），`remainingFixturePids:[]`，`childSupplementaryKill:false`。观察期限按 harness `min(killAt+90s, expiresAt+15s)=11:54:14.140Z`，child 早于期限 **12381ms** 结束；未使用 `timeout` 命令、未杀进程组/负 PID、未 finally kill。

**本记录只证明「父死后 child watchdog 在 lease 到期时自行终止」这一件事。**以下均**不**由本轮证明，不得外推：

- child coding run 的**结算**结果：本轮**从未写 `release-barrier`**（`releaseBarrierExists:false`），child 一直在 fixture barrier 内，从未提交报告，acceptance 从未被评估；leaf `status.json` 终态仍为 `state:"running"`、`processTerminal.state:"pending"`、无 `error`。这是父死的**预期结果**，不是缺陷，也**不是**「child 结算通过」。
- H1 prepare-only 通过（`hb-b9YtbN`，见 `docs/plans/records/2026-10-13-heartbeat-experiment.md`「H1p run4」）与本轮是**两次独立运行、两个独立 fixture 根**；本轮不引用 run4 数据作为证据，也不把 run4 的 prepare 通过当作 H2 通过。
- `terminationReason` **不可得，如实记为 `null`**（见下节），未猜为 `authority_lease_expired`，未伪造 `exitSignal`。
- managed coding + worktree:true 拓扑**不外推** generic / binding-failed / detached / bash descendants 等其它拓扑；lease 更长序列（`renewalSequence>=2`）本轮未出现（父在第 2 次续租前已死），未验证。

## 授权与实际执行边界（逐项遵守，可复核）

- **唯一实际 Host 命令**即合同原样那条，输出重定向到 `/tmp/h2-run.log` 后以 `; EXIT=$?` 直接取真实退出码，**无 pipe 掩盖 exit**、**未使用 `timeout` 命令**、**未包裹任何自动杀**：

  ```sh
  env -u PI_RUNTIME_HEARTBEAT_PREPARE_ONLY PI_RUNTIME_HEARTBEAT_PARENT_KILL=1 node --test test/heartbeat-parent-death.integration.mjs > /tmp/h2-run.log 2>&1; EXIT=$?
  ```

  → `REAL_EXIT=0`，窗口 `2026-10-14T11:52:41Z` → `11:54:01Z`。bash tool 自身 timeout 设为 420s，**大于** harness 内部最大自持时长（120s readiness + 90s 观察上限 + fixture 建根），故 harness 必先自行终止，外部超时从未触发、从未向任何 fixture 进程发信号。
- **kill 面唯一性（开跑前静态复核 + 运行时事实双证）**：`grep -n "kill\|SIGKILL\|SIGTERM"` 全文件仅 `test/heartbeat-parent-death.integration.mjs:266` `assert.equal(f.host.kill("SIGKILL"), true)` 一处发信号，位于 `parentDeath()` 内，前置 `:255 assert.equal(process.env[KILL],"1")`、`:256 assertReady(ready)`、`:257 assert.equal(ready.parentPid, f.host.pid)` + `assert.notEqual(f.host.pid, process.pid)`、`:259 assert.equal(f.exit, undefined)`、`:260 ready.expiresAt > Date.now()`、`:261/:262` 父/runner 双 birth 活体复核、`:264` 先落盘 `before-sigkill.json`；`grep -nE "kill\(-|killpg|process\.group|detached"` **无匹配**（唯一 `detached` 命中是 `:50` 注释）；无 `finally` kill（`:333` 注释显式声明「无 finally kill/rm」）。运行时反证：child 在父死后 **62.4s** 仍在写 `child-91468.jsonl`（`observer-eof` 条目），证明 SIGKILL 未波及 runner/进程组。
- **只读 fixture，未改 harness/production/统一计划**：三源与 production mtime 开跑前后**逐字一致**——`test/heartbeat-parent-death.integration.mjs` `2026-10-14T19:20:01`、`test/fixtures/heartbeat-parent-host.ts` `19:20:01`、`test/fixtures/heartbeat-provider.ts` `16:18:46`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` `18:18:39`（H1-key 遗留）、`process-birth-identity.ts` `2026-10-03T13:03:29`（clean）；`git status --porcelain` 前后相同（三源 `??`、`extension.ts` ` M`）。本仓唯一写入为本文。`git diff --cached --name-only` **空**；未 commit/push/stash/reset。
- **未读真实用户数据**：未读真实 settings/models/auth/credential/authority/grant，未读任何真实 session 正文（含本执笔者自身 session/state），未读 fixture 的 `sessions/*.jsonl` 正文（仅 `readdir` + `stat` 名称与字节数：`…_heartbeat-92cf6810-….jsonl` 17020B、同名目录、`subagent-artifacts`）。fixture 侧只读 harness 自有诊断/公开运行元数据：`launch.json`、`ready.json`、`before-sigkill.json`、`parent-death-result.json`、`parent-observations.jsonl`、`child-91468.jsonl`、两个 asyncDir `status.json` 身份/扩展投影、`process-terminal.json`、`process-terminal-candidate.json`、`recovery-descriptor.json`、`events.jsonl` 的 type/phase 投影（未读 payload 正文）、`runner.stderr.log`、workspace 台账 `records/<workspaceId>.json` 的身份/状态/处置字段、fixture 仓只读 `git status/log/worktree list` 与 `probe.txt`。
- **共享 broker 目录未枚举**：仅对本次随机 `rootSessionId` 派生的**精确** namespace `/tmp/pi-root-subagent-501/cc6462554089fada726d9fe63af79d199e3dcb9a2706fb39a4860b870af64ea6.sock` 做单路径 `ls -l`（事实见「残留」节）；未 `ls` 目录、未读其它 root 的 socket/grant/authority。
- **旧现场零接触**：`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea`/`hb-b9YtbN` 仅做 `test -d` 存在性检查（四者均 EXISTS），**未复用、未读取、未列举内容、未删除**；本轮 fixture 根由 harness `mkdtemp` 新建为 `hb-BXRJmy`，与四者不同。
- **无网络、无真实 provider/模型、无真实业务任务**：fixture provider 全内存生成（`baseUrl: http://127.0.0.1:9` 从未请求），模型固定 `heartbeat-fixture/local`（`recovery-descriptor.json.modelOrigin:"explicit"`），工具仅 `["read"]`，agent profile 仅 fixture `agent/agents/{delegate,executor,reviewer}.md`。派发模型约束已满足：本任务运行于 `PI_MODEL=Qwen3.8-Max`（仅读该 env 变量名值，未读任何配置正文），未使用 GPT 系列。
- **未补杀、未删除、未 raw git worktree**：本轮对 fixture 未执行任何 `rm`、任何 `git worktree remove/prune`、任何信号发送；唯一 git 调用为只读 `status --short`/`log --oneline`/`worktree list`。
- 诊断辅助文件仅在 `/tmp`（`h2-run.log`、`h2-projection.mjs`、`h2-projection.json`），不在仓内、不属 fixture 现场。

## 开跑前静态校验（全文读取 + 前提逐项确认）

已完整读取：`docs/plans/records/2026-10-13-heartbeat-experiment.md` 全文（545 行，含 H1 首轮/rerun/run3/run4 全部现场与主管裁决）、统一计划 H1/H1-key/H2 段（`docs/plans/2026-10-13-remaining-runtime-execution.md:299-327`）、`docs/bugs/2026-10-14-required-child-session-identity.md` 全文（130 行）、harness 三源全文（`test/heartbeat-parent-death.integration.mjs` 338 行、`test/fixtures/heartbeat-parent-host.ts` 42 行、`test/fixtures/heartbeat-provider.ts` 156 行）、child watchdog `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts:70-135`（只读，用于解释机制，不作运行证据）。

| 前提 | 开跑前实证 |
| --- | --- |
| 门禁 env 干净 | `env \| grep -c PI_RUNTIME_HEARTBEAT` = **0**；`experimentMode(process.env)` 经 `env -u PREPARE` + `PARENT_KILL=1` 解析为 `parent-death`，互斥断言 `:29` 未触发 |
| 无残留 fixture 进程 | `ps -ax` 过滤 `hb-[A-Za-z0-9]{6}\|heartbeat-parent-death\|heartbeat-provider\|heartbeat-parent-host` → **(none)** |
| 无 staged | `git diff --cached --name-only` 空 |
| harness 可解析 | `node --check test/heartbeat-parent-death.integration.mjs` → **exit 0** |
| C locale birth comparator 保持 | `:14-22 cLocaleExecFile` 仅用 production helper 既有公开 `{execFile}` 选项注入 `LANG=C LC_ALL=C`，无字符串归一化 fallback；9 处取样点 `:136/:187/:205/:217/:224/:229/:261/:262` 全部传入（本轮亲自 grep 复核，`:261/:262` 即 SIGKILL 前父/runner 双复核） |
| post-title 同域权威 birth + alive 复核 | fixture `heartbeat-parent-host.ts` 在 `session_start` 内独立 `captureProcessBirthIdentity(process.pid)` 记为 `hostBirth`，与 registry 值单条原子落盘并附 `readLocale`；harness `:184-188` 双 post-title 相等 + `:187` registry 活体复核、`:217` ready 时父活体复核 |
| required-key production 修复在位 | `extension.ts:1734` `const sessionId = ctx?.sessionManager?.getSessionId();`（含中文注释，本轮零写入） |
| 环境 | Node **v26.8.1**（>=22.19.0）；physical SDK `@earendil-works/pi-coding-agent` **1.0.4**（`launch.json.cli` = 本仓 `node_modules/…/dist/cli.js`，无 global 回退）；`pi-subagents` **0.75.0**；`HEARTBEAT_LEASE_MS=60_000` / `HEARTBEAT_RENEW_MS=15_000`（`authority-contract.ts:4-5`） |
| 目标 record 不存在 | `docs/plans/records/2026-10-13-heartbeat-acceptance.md` 开跑前 `No such file or directory`（本文为新建，未覆盖任何现场） |

## 实际命令与退出码

| # | 命令 | 真实 exit |
| --- | --- | --- |
| 1 | 开跑前静态校验组（`node -v`、`env \| grep -c PI_RUNTIME_HEARTBEAT`、`git diff --cached --name-only`、`git status --porcelain <scope>`、`stat -f` mtime、`ps -ax` 过滤、`node --check` harness、SDK/包版本 `node -e`） | 全部 **0**（`grep -c` 返回 0 计数即预期） |
| 2 | 旧 root 存在性检查（4 × `test -d`，未读取内容） | 四条均 EXISTS |
| 3 | **唯一 H2 门禁**：`env -u PI_RUNTIME_HEARTBEAT_PREPARE_ONLY PI_RUNTIME_HEARTBEAT_PARENT_KILL=1 node --test test/heartbeat-parent-death.integration.mjs` | **0**（`tests 3 / pass 3 / fail 0 / skipped 0`，`duration_ms 79981.571`） |
| 4 | 只读证据投影 `node /tmp/h2-projection.mjs <fixtureRoot>` | **0**（`/tmp/h2-projection.json`，337 行） |
| 5 | 收尾复核：3 × `ps -p 91308 -p 91331 -p 91468`、`ps -ax \| grep -F hb-BXRJmy`、精确 socket `ls -l`、fixture 仓只读 `git status --short`/`log --oneline`/`worktree list`/`cat probe.txt`、scope mtime 与 `git diff --cached --name-only` 复验 | `ps -p` 三次均 **exit 1（无匹配，即三 PID 均不存在）**；其余 **0**；staged 仍为空 |

本轮**未执行**：tsc、fixture 类型检查、package typecheck、`test/subagent-runtime-membrane.test.mjs`、npm test / all-integration、任何其它 `.integration.mjs`、任何真实 typed dispatch、任何通知。（前三轮已验收的静态项不重复占用 `unit-runner`；本任务只占 `visible-host` + `heartbeat-fixture`，未与 I4 并发。）

Host 用例完整输出（`/tmp/h2-run.log` 原文）：

```
✔ heartbeat harness 默认关闭，prepare/H2 互斥，环境不继承真实 provider (0.892709ms)
✔ readiness 静态字段矩阵缺身份/ACK/lease 任一项均拒绝 (3.009791ms)
✔ 隔离 managed coding 实际父 Host/child heartbeat (79871.475292ms)
ℹ fixtureRoot=/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-BXRJmy；失败需精确 cleanup，harness 不补杀不删现场
ℹ tests 3 / suites 0 / pass 3 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 79981.571
```

## 现场身份与 birth（fixtureRoot=`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-BXRJmy`，证据根完整保留）

进程树：harnessPid **91308** → parentPid **91331**（`parent-started.ppid=91308`，direct spawn 成立；`ready.directSpawn:true`）→ runner/childPid **91468**（`child-91468.jsonl.ppid=91331`；父死后同文件 `observer-eof` 条目 `ppid=**1**`，即被 launchd 收养，独立佐证父已消失而 runner 仍活）。`workflowPid 91331 === parentPid`、`runnerPid 91468 === childPid` 且同 birth、`parentPid ≠ childPid`、`workflowRunId ≠ runId` 全部真实成立（`assertReady` 通过）。

| 项 | 值 |
| --- | --- |
| rootSessionId | `heartbeat-92cf6810-7df8-4318-8f82-6812471ea07a` |
| broker namespace（本次随机 ID 派生的精确路径） | `/tmp/pi-root-subagent-501/cc6462554089fada726d9fe63af79d199e3dcb9a2706fb39a4860b870af64ea6.sock`（`launch.json.brokerNamespaceAbsentBeforeLaunch:true`） |
| workflowRunId / agent | `40b5a4c6-c7e7-434d-9d4b-9506f93bc29b` / `workflow`（pid 91331 = 父） |
| leaf runId / agent | `a4637e34-4093-4afb-bc6a-34319bbb961e` / `executor`（pid 91468，`parentWorkflowRunId=40b5a4c6…`，`workflowKey typed-685738b9-0c55-465e-a3ea-36e301af27c6`） |
| ownerGeneration | **1** |
| workspaceId | `0ce4ddea-9284-49e9-890c-260fda350595` |
| managed worktree（containment 断言通过） | `<root>/state/repositories/60c323dc6a13991e2c4f490e7b59eca0734205459a08bfad429d05b512fe6055/worktrees/0ce4ddea-9284-49e9-890c-260fda350595`（分支 `refs/heads/pi-managed/0ce4ddea-…`） |
| leaseId | `lease-b443c53eca24874d02e09059279a327f17e174dc1ecf8823`（台账 `leaseId b1aa12e7fa51a8e4fb167c6b9e025b7e3380fdd2c656566366b98309bd2e27be` 为 workspace 侧独立租约标识，两者不同属不同 authority 面，如实并列不合并） |
| **parentBirth（权威，post-title + C locale）** | `12a16299955ae675206172d0766c25cc038fb11ba49bc678ede8e5ae2ea2d60f` —— `parent-started.hostBirth` == `registry.processBirthIdentity` == `ready.parentBirth` == `ready.hostBirth` == `ready.registryBirth`（两次独立 in-process 取样相等，且 harness 以 C locale `execFile` 对**活父**复核通过两次：`:187`、`:217`，SIGKILL 前 `:261` 第三次复核亦通过） |
| parent `readLocale` | `{LANG:"C", LC_ALL:"C"}` —— 与 harness `fixtureEnvironment` 白名单同域，跨 locale 伪差已消除 |
| `spawnBirth`（pre-title，仅历史诊断） | `6cf2d99b1a3c969eec2d382ac8c766b753401d044e328e2f47938d15e08cb0a6`（`spawnBirthCapturedBeforeProcessTitle:true`）——与权威值不等是**预期事实**，未当作 PID 复用 |
| **runnerBirth == childBirth** | `21c877b08ecb6ee18fdfb38cd6bc4deefdbd6c46012a729aa441bc64cab506ab`（harness C locale 取样 == runner 内 `owner.processBirth`；provider 内 `captureProcessBirthIdentity(process.pid)` 不等即抛错，未抛 → runner 侧自洽；SIGKILL 前 `:262` 活体复核通过） |
| sessionFile（持久会话事实，未读正文） | `<root>/sessions/2026-10-14T11-52-43-162Z_heartbeat-92cf6810-….jsonl`（17020B）；leaf `recovery-descriptor.sessionFile` 为 `<root>/sessions/…_heartbeat-92cf6810-…/002826fc-…/run-0/session.jsonl` —— 与 rootSessionId **ID 字符串同时存在且不相等**，即 H1-key 缺陷拓扑，本轮由 production 修复覆盖（required 三项实际注入） |
| fixture 仓 | 单一合法 commit `09dd5f9 test(heartbeat): 增加隔离只读探针`（仅临时仓、局部 `user.name/user.email`，未触本仓 index）；`git status --short` **空**；`probe.txt` 内容 `只读 heartbeat fixture` 未变；`git worktree list` 仅主工作树 + 本轮 managed worktree |

## 时间序（全部来自现场 jsonl / result 文件的 epoch ms 与 ISO，无推断）

| 序 | 事件 | epoch ms | ISO (UTC) |
| --- | --- | --- | --- |
| 1 | `parent-started`（registry endpoint/pid/rootSessionId 与 launch 完全一致） | 1791978764430 | 11:52:44.430Z |
| 2 | workflow `started`（pid 91331 = 父） | 1791978765594 | 11:52:45.594Z |
| 3 | leaf `started`（pid 91468，`parentWorkflowRunId=40b5a4c6…`） | 1791978765642 | 11:52:45.642Z |
| 4 | `subagent` typed 工具 `tool_execution_end` **success**（`toolExitAt`） | 1791978765699 | 11:52:45.699Z |
| 5 | `child-session-started`（cwd = managed worktree） | 1791978766502 | 11:52:46.502Z |
| 6 | **`acknowledged` `root-session-owner`**（真实 `subagent:acknowledge-extension`） | 1791978766509 | 11:52:46.509Z |
| 7 | **`owner` receipt 读取**（generation 1，`owner.processBirth` 与 runner 实测 birth 相等） | 1791978766521 | 11:52:46.521Z |
| 8 | `subscription-ready` + **`barrier-entered`** | 1791978766522 | 11:52:46.522Z |
| 9 | lease `renewalSequence:0`（`lastRenewedAt …765668` / `expiresAt …825668`） | 1791978766522 | 11:52:46.522Z |
| 10 | lease **`renewalSequence:1`**（同一 leaseId，`lastRenewedAt …779140` / `expiresAt …839140`） | 1791978779154 | 11:52:59.154Z |
| 11 | `ready.json` 落盘（`assertReady` 全字段通过 + ready 时父活体复核通过） | 1791978779289 | 11:52:59.289Z |
| 12 | `before-sigkill.json` 落盘（`birthRecheck:true`、`target:"direct-spawned-parent-pid-only"`、`childSupplementaryKill:false`）= **killAt** | 1791978779310 | **11:52:59.310Z** |
| 13 | **一次 SIGKILL → `parentExit {code:null, signal:"SIGKILL"}`**（+12ms） | 1791978779322 | 11:52:59.322Z |
| 14 | child 侧 `observer-eof`（broker 订阅因父死关闭；同 ms，`ppid` 已变为 **1**）→ **未触发立即终止**（watchdog 守卫 `expiresAt !== undefined && clock() < expiresAt`，见 `root-session-owner.ts:122`） | 1791978779322 | 11:52:59.322Z |
| 15 | 已记录 `expiresAt`（= `lastRenewedAt + 60_000`，父死后**无任何续租 push**） | 1791978839140 | 11:53:59.140Z |
| 16 | **child/runner 身份自行消失** `childExitAt`（`identityEnded` → `captureProcessBirthIdentity` 抛错后精确 `ps -p 91468 -o pid=` 空输出 → `state:"absent"`） | 1791978841759 | **11:54:01.759Z** |
| 17 | `observedUntil`（`parent-death-result.json` 落盘时刻） | 1791978841795 | 11:54:01.795Z |
| — | harness 观察期限 `min(killAt+90_000, expiresAt+15_000)` | 1791978854140 | 11:54:14.140Z（child 早 **12381ms**） |

派生量（算术，非推断）：`readyAt→killAt` **21ms**；`killAt→parentExit` **12ms**；`killAt→expiresAt` **59830ms**；`expiresAt→childExitAt` **2619ms**；**`latencyMs` 62449**；`expiresAt−lastRenewedAt` **60000ms** = `HEARTBEAT_LEASE_MS`。

`parent-observations.jsonl` **无 `process-terminal` 条目**（对比 run4 有）：该 proof 由父 Host 的 collector 写入，父已 SIGKILL，故 leaf 的 run 级 terminal proof 永远停在 `pending`。这是父死实验的**必然结果**，如实记录为「public terminal proof 不可得」，不以 harness 的 `ps` 缺失事实冒充 public proof。

## 合同逐项验收（全部以本轮现场数据成立）

| 合同/计划项 | 现场证据 |
| --- | --- |
| 全新隔离 fixture，不复用旧根 | `mkdtemp` 新建 `hb-BXRJmy`；`hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea`/`hb-b9YtbN` 仅 `test -d` 存在性检查，未读未动未删 |
| prepare readiness 完整通过后才 kill | `ready.json` 于 `…779289` 落盘（`assertReady` 六段断言全通过），`before-sigkill.json` 于 `…779310` 落盘，SIGKILL 在其后；`:256 assertReady(ready)` 在 kill 前**第二次**执行 |
| 只对直接 spawn 的父 PID 发一次 SIGKILL | `f.host.kill("SIGKILL")` 返回 true（`:266` assert 通过）；`ready.parentPid 91331 === f.host.pid`、`f.host.pid ≠ process.pid(91308)`、`parent-started.ppid=91308`；`parentExit.signal:"SIGKILL"` 单条；全文件唯一 kill 面 |
| 不杀 runner/child/进程组/负 PID、不 finally kill、不用 timeout 自动杀 | `grep` 无负 PID/killpg/进程组；`childSupplementaryKill:false`；child 在父死后仍写日志 62.4s；命令未包裹 `timeout` |
| SIGKILL 前 parent PID birth 仍相同 + 非当前 Host | `:261` 父 birth 活体复核通过（C locale `execFile`）、`:257` `notEqual(f.host.pid, process.pid)`、`:259 f.exit === undefined`、`:260 expiresAt > Date.now()`；`birthRecheck:true` 落盘 |
| managed child/runner 在 lease 窗口内自行退出 | `childExitAt …841759` < 期限 `…854140`，且 = `expiresAt + 2619ms`；`childIdentityEnd.state:"absent"`（同 birth 仍活→undefined、birth 变→`pid-reused`、ps 缺失→`absent` 三态区分，本轮为 `absent`，**非** PID 复用） |
| 观察期限 `min(killAt+90s, expiresAt+15s)` | harness `:267` 原样；本轮实际取 `expiresAt+15s` 分支 = 11:54:14.140Z |
| public process proof / terminationReason 可得性 | `publicProcessProof` = leaf `status.json.processTerminal` = `{version:1, state:"pending", runId:a4637e34…, runnerProcessInstanceId:8807eec5-…}`；`exitSignal:null`（proof 无 signal 字段）；**`terminationReason:null`** + `terminationReasonAvailability:"production watchdog 未公开 reason；不推断"` |
| 记录字段齐备 | `parent-death-result.json` 含 `ready`（全字段，含三 birth/runId/lease）`killAt`/`parentExit`/`childExitAt`/`exitSignal`/`terminationReason`/`latencyMs`/`childIdentityEnd`/`observedUntil`/`birthRecheck`/`childSupplementaryKill:false`/`remainingFixturePids:[]`/`publicProcessProof`/`cleanupDisposition` |
| required 三项 / ACK / owner / lease>=1 / barrier / containment / 拓扑 | 见下节「readiness 达成明细」 |
| H2 不写 release-barrier、不要求 child acceptance report | `releaseBarrierExists:false`；`failure.json` 不存在（`failureJsonExists:false`）；child 从未提交报告，acceptance 从未评估 |
| child-owned workspace 禁止父 integrate | 台账 `integrationIntent:null`、`integrationReceipt:null`、`integrationHistory:[]`、`publishedArtifact:null`、`request.owner.kind:"standalone-subagent"`；本轮无任何父侧 integrate 调用（父在 ready 后 21ms 即被杀） |
| 成功后确认全部被测身份结束 | harness `assert.deepEqual(remainingFixturePids, [])` 通过 + `assert.equal(f.exit?.signal,"SIGKILL")` 通过；执笔独立三次 `ps -p 91308 -p 91331 -p 91468` 均 exit 1（无匹配）、`ps -ax \| grep -F hb-BXRJmy` 无匹配、无任何 hb-/heartbeat fixture 进程 |
| fixture 仓零修改（child 未改文件） | `git status --short` 空、`probe.txt` 未变、仅一条 commit `09dd5f9`、worktree 分支仍指向同一 commit |

### readiness 达成明细（SIGKILL 前置条件，全部真实数据）

- **required 三项注入**：leaf `status.json.launchResolvedExtensions.required = ["root-session-owner","integration-queue","agents-shared"]`，`omitted = {runtime:0, configured:0, required:0, effective:0}`，`disableAmbientExtensions:true`，`runtime`/`configured` 各 1 项、`effective` 5 项 sha256 摘要；`recovery-descriptor.json.requiredExtensions` 独立佐证三项**真实仓内路径**（`packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`、`…/integration-queue.ts`、`pi/extensions/agents-shared.ts`，后者经 fixture `agent/extensions/agents-shared.ts` symlink 指向同一物理 production 文件，未伪造 ACK）。
- **ACK**：`child-91468.jsonl` `…766509` 真实 `subagent:acknowledge-extension` → `kind:"acknowledged"`、`runId` 与 handle 相等。
- **owner bound**：`…766521` `owner` 条目，`ownerGeneration:1`、`owner.processBirth === captureProcessBirthIdentity(process.pid)`（不等即抛错，未抛）、`owner.cwd === handle.dispatch_cwd`、`owner.rootSessionId === launch.rootSessionId`；`ready.bound:true`。
- **lease `renewalSequence>=1`**：同一 `leaseId` 两次 push（`0` → **`1`**），`lastRenewedAt …779140 <= leaseReceivedAt …779154`、`expiresAt …839140 > leaseReceivedAt`；旁路仅消费公开 `createRootBrokerClient` + `owner.read` + `lease.updated` push，未读 authority 正文、未新建 lease authority。
- **barrier 与工具回执**：`barrier-entered …766522`（cwd = managed worktree，`ackAt <= barrierAt`、`boundAt <= barrierAt`）；`toolExit:"success"`/`toolExitAt …765699`，`details.runId`+`workspace_id`+`asyncDir`+`dispatch_cwd` 齐备且 `contained(fixtureRoot, …)` 全部通过。
- **public status 交叉核对**：leaf `status.json.runId === handle.runId`、`status.pid === started.pid`、ready 时 `status.state === "running"`。
- `child-91468.jsonl` **无 `observation-error`**；`provider-observations.jsonl` **为空**（父侧 provider 无异常分支）。

## 父死后 watchdog 机制（静态源码解释 + 运行时事实对齐；不把源码阅读当作运行证据）

只读 `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts:74-135`：

- `:121` `expiryTimer = setExpiryInterval(() => { if (!terminating && expiresAt !== undefined && clock() >= expiresAt) void terminate("authority_lease_expired"); }, 5_000)` —— 每 **5s** 轮询已记录 `expiresAt`。
- `:122` `subscription.closed.catch(() => { if (!terminating && (expiresAt === undefined || clock() >= expiresAt)) void terminate(...) })` —— 订阅 EOF **仅在 `expiresAt` 未知或已到期时**才终止；本轮 `expiresAt` 已知且未到期，故**不立即终止**。
- `:81-87` `terminate()` → `kill(pid, "SIGTERM")`，即 **child 自身 watchdog 对 runner 自己 PID 发 SIGTERM**（非 harness、非父、非进程组）。

与运行时事实一致：`observer-eof` 于 `…779322`（父死同 ms）记录但 child 继续存活 **62.4s**，直到 `expiresAt(…839140)` 之后 **2619ms**（< 5s 轮询粒度）身份消失。**注意：`SIGTERM` 与 `authority_lease_expired` 均为源码级机制描述，本轮无任何 public artifact 记录该信号或该 reason**（`exitSignal:null`、`terminationReason:null`、`runner.stderr.log` 仅 `{"version":1,"phase":"integration-gate-passed","monotonicMs":1277648537,"eligible":true,"queueState":"absent"}` 一行，无终止日志），因此**不写入结果字段、不声称已观测**。运行时可证的只有：父死 → 无续租 → 已记录 lease 到期 → child 身份在到期后 2.6s 内自行消失（`ps` 缺失 + birth 不可捕获）。

## 观察与分类（按仓库缺陷数据来源分类门禁；本轮 production/harness/fixture 零改动）

1. **leaf `status.json` 停在 `state:"running"`、`processTerminal.state:"pending"`、`process-terminal-candidate.json.writers:{}`、`events.jsonl` 末条为 `message_start`（10 条，无终态事件）** —— **非缺陷，H2 的预期结果**。生成链：run 级 terminal proof 与 status 终态由**父 Host 侧 collector** 写入（run4 有 `process-terminal` 条目正因父存活）；本轮父在 ready 后 21ms 被 SIGKILL，runner 随后被自身 watchdog 终止，两侧都无存活 writer 完成结算。归类上**不属类别 1/2**（既非 production 数据被错误处理，也非测试制造非法数据），而是实验设计刻意制造的 owner 缺失终态；**不得**将其读成 production 结算缺陷，也**不得**为其增加兼容/fallback。
2. **`status.json.runtimeAcknowledgedExtensions:null`，而 `child-91468.jsonl` 有真实 `acknowledged` 条目** —— 同一原因（runner 未活到回写 ACK 快照的阶段；run4 该字段为 `{version:1,source:"child-runtime",ids:[三项],omitted:0}`）。ACK 事实由 child 侧独立日志与 required 注入共同佐证，**未以 status.json 单字段否定真实 ACK**，也未修改任何断言。
3. **共享 uid 目录内本次精确 namespace 的 socket 残留（stale）** —— `/tmp/pi-root-subagent-501/cc646255….sock` 仍存在（`srw-------  1 leshi.zhy  wheel  0 10月 14 19:52`）。父被 SIGKILL，无法执行 orderly unlink（对比 run4 父 orderly 退出后 socket 消失）。**仅本 root 的精确路径**，未枚举目录、未触碰其它 root。属 H2 预期残留，已列入待授权清理清单，**本轮未删除**。
4. **managed workspace 仍 `active` 未处置 → cleanup PENDING（blocked-environment）** —— 台账 `managed-workspace-ledger.v2`：`state:"active"`、`revision:3`、`disposition:null`、`actionChallenge:null`、`pendingAction:null`、`v2Action:null`、`cleanupDebt:null`、`terminalProof:null`、`recoveryChallenge:null`、`recoveryPlan:null`、`createdAt 11:52:44.587Z`/`updatedAt 11:52:45.689Z`、worktree 目录**仍存在**、分支 `refs/heads/pi-managed/0ce4ddea-9284-49e9-890c-260fda350595` 指向 `09dd5f9`（零提交增量）。合同「成功后按 public workspace status/`allowed_dispositions`/`action_token` 处置」**本轮客观不可执行**：`allowed_dispositions`/`action_token` 只能由**存活 Host** 内的 public `subagent_worktree status` 产出（`packages/pi-subagents-enhanced/src/workspace/tool.ts`），而本 fixture 的 root owner Host 已被本实验刻意 SIGKILL；台账 `actionChallenge:null` 亦无可用 token。harness 自身已记录 `cleanupDisposition:"fixture-root-retained; public-workspace-cleanup-requires-live-owner-decision"`。已按合同 `contact_supervisor` 上报，**主管裁决为独立 blocked-environment，不阻塞心跳结论、不得宣称 released、现场原样冻结、后续父层另派只读核查**（见「主管裁决」节）。**未 `rm`、未 raw `git worktree remove/prune`、未猜测 allowed disposition、未另起新 Host、未改台账。**
5. **fixture child 的 `output-0.log`（595B）内容为 fixture provider 生成的 `HEARTBEAT_FIXTURE_CHILD` dispatch 合同文本**（`agent:"executor"`、writePaths `probe.txt`、acceptance criteria 与 fixture `heartbeatContract()` 逐字一致）——fixture 自有数据，非真实用户 session/prompt；仅核对其为 fixture marker，未据此做任何断言。
6. **本轮无父 Host stderr 证据**：harness 仅在失败时把 `f.stderr` 写入 `failure.json`，本轮 `failure.json` 不存在，故**不得声称已核对 Host stderr**。
7. **`leaseId` 双值并列**（authority lease `lease-b443c53e…` vs workspace 台账 `leaseId b1aa12e7…`）：两个不同 authority 面的标识，如实并列，不合并、不推断因果。

## 主管裁决（2026-10-14，H2 轮收口边界）

已按合同 `contact_supervisor`（`reason:"need_decision"`）上报并收到裁决，逐条遵守：

1. **接受 H2 heartbeat 核心验收通过**：真实父 SIGKILL 后 **62449ms** child 自行退出、birth/`ps` 证据、无 supplementary kill、`remaining []`。
2. **cleanup 子项独立判定为 blocked-environment**（root owner 被刻意杀，无法产出 public `allowed_dispositions`/`action_token`）；**cleanup 不得阻塞或推翻已证心跳**，同时**不得宣称 workspace released**。
3. **现场原样冻结**：`hb-BXRJmy`、workspace `0ce4ddea-9284-49e9-890c-260fda350595`（`active`）、`pi-managed/0ce4ddea-…` 分支、台账全部保持不变；**不新起 Host、不读真实 authority、不 raw `git worktree`、不 `rm`、不改台账 JSON**。
4. **acceptance 必须明确区分 heartbeat verified 与 cleanup pending**，并列精确 fixture 路径 / known IDs / owner status / 零进程事实；`publicProcessProof` 为 `pending`、`terminationReason` 为 `null`，**不补造**。
5. **后续由父层单独安排**受支持 workspace 恢复/管理路径的**只读核查**，再按权威 `allowed` 操作；若确认无恢复面，则**只生成用户手动精确命令而不执行**。
6. **本 task 只 record 收口并释放 `visible-host`**；不等待、不重复 SIGKILL 实验。

据此本轮**未**执行任何清理动作，也**未**再启动任何 Host 或重复实验。

## 残留与待授权处置（未杀、未删、未 raw worktree；按主管裁决原样冻结）

**进程：零残留（known IDs 全部不存在）。** `ps -p 91308 -p 91331 -p 91468` 三次均 exit 1（无匹配）；`ps -ax | grep -F hb-BXRJmy` 无匹配；`ps -ax` 过滤 hb-/heartbeat fixture 模式无匹配。依据 = 已知 PID + birth + harness `identityEnded` 的 `ps` 缺失佐证 + 执笔独立三次复核；**未发任何信号**。

**owner status（权威台账值，未改动）：** workspace `0ce4ddea-9284-49e9-890c-260fda350595` → `schemaVersion:"managed-workspace-ledger.v2"`、`state:"active"`、`revision:3`、`disposition:null`、`actionChallenge:null`、`pendingAction:null`、`v2Action:null`、`cleanupDebt:null`、`terminalProof:null`、`recoveryChallenge:null`、`recoveryPlan:null`、`integrationIntent:null`、`integrationReceipt:null`、`integrationHistory:[]`、`publishedArtifact:null`、`request.owner.kind:"standalone-subagent"`、`owner.rootSessionId:heartbeat-92cf6810-…`、`owner.toolCallId:"heartbeat-1"`、`createdAt 2026-10-14T11:52:44.587Z`、`updatedAt 2026-10-14T11:52:45.689Z`。**root owner Host（PID 91331）已死且不可复活**，故 public dispose 面无存活调用方。

**文件系统：全部保留（精确路径清单）。** `hb-BXRJmy` = `/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/hb-BXRJmy`，整树未删：

- 根级：`launch.json`、`ready.json`、`before-sigkill.json`、`parent-death-result.json`、`parent-observations.jsonl`、`child-91468.jsonl`、`provider-observations.jsonl`（空）、`agent/`、`home/`、`sessions/`、`state/`、`tmp/`、`repository/`（含合法 commit `09dd5f9`，`probe.txt` 未改，`git status --short` 空）。
- leaf asyncDir：`<root>/tmp/pi-subagents-uid-501/async-subagent-runs/a4637e34-4093-4afb-bc6a-34319bbb961e`（`status.json` `state:"running"`、`process-terminal.json` `state:"pending"`、`process-terminal-candidate.json` `writers:{}`、`events.jsonl` 10 条末为 `message_start`、`recovery-descriptor.json`、`runner.stderr.log` 一行 `integration-gate-passed`、`runner.stdout.log` 0B、`output-0.log` 595B、`control/{steer-requests,stop-requests}` 均空）。
- workflow asyncDir：同级 `40b5a4c6-c7e7-434d-9d4b-9506f93bc29b`（`status.json` `state:"complete"`、`pid:91331`）。
- 台账：`<root>/state/repositories/60c323dc6a13991e2c4f490e7b59eca0734205459a08bfad429d05b512fe6055/records/0ce4ddea-9284-49e9-890c-260fda350595.json`。
- **未处置的 managed worktree（仍存在）**：`<root>/state/repositories/60c323dc…/worktrees/0ce4ddea-9284-49e9-890c-260fda350595`，分支 `refs/heads/pi-managed/0ce4ddea-9284-49e9-890c-260fda350595` 指向 `09dd5f9`（零提交增量）。
- **stale broker socket（仅本 root 精确 namespace）**：`/tmp/pi-root-subagent-501/cc6462554089fada726d9fe63af79d199e3dcb9a2706fb39a4860b870af64ea6.sock`（`srw-------  1 leshi.zhy  wheel  0 10月 14 19:52`）。父被 SIGKILL 无法 orderly unlink（对比 run4 父 orderly 退出后 socket 消失）。未枚举共享目录、未触碰其它 root。

旧四根 `hb-iKUNgy`/`hb-fTmWES`/`hb-vhjjea`/`hb-b9YtbN` 原样保留、本轮未读未动（仅 `test -d`，四者 EXISTS）。

**cleanup PENDING 的移交清单（父层后续只读核查受支持恢复/管理路径；本轮一律未执行、未自选）：**

1. managed workspace `0ce4ddea-9284-49e9-890c-260fda350595`（`active`）：需存活 owner 才能走 public `subagent_worktree status` → `allowed_dispositions`/`action_token` → `dispose`；台账 `actionChallenge:null` 无可用 token，`recoveryPlan/recoveryChallenge` 亦为 `null`（本轮只读投影事实）。若确认无恢复面，**仅生成用户手动精确命令，不执行**。
2. 上述 stale socket 精确路径（仅此一路径，非目录）。
3. 旧四根内 run4 记录的未处置 managed worktree（`0f80fe6d-…`、`fc07e1d9-…` 等）与各自状态：仍按 run3/run4 裁决逐个读 public workspace status 后处置，本轮**未授权、未执行、未读取**。

**禁止项（本轮全部遵守，后续亦不得违反）**：`rm -rf`、raw `git worktree remove/prune`、直接改台账 JSON、新起 Host 代为 dispose、读取真实 authority/grant。

## 本轮未达成 / 未验证（不得外推）

- **未验证**：child coding run 的结算通过路径（本轮从未释放 barrier，acceptance 从未评估；run4 的 acceptance 拒绝属 fixture 报告契约问题，见 experiment record 观察 1，本轮未复现也未修复）；lease 更长序列（`renewalSequence>=2`）；父死后 watchdog 在 `expiresAt` 已过期/未知两种守卫分支下的行为（本轮只覆盖「已知且未到期」分支）；`root.closing` → `explicit_stop` 路径；generic / binding-failed / detached / bash descendants 等其它拓扑；多 child 并发下的父死行为。
- **未取得**：child 退出的 public terminal proof（`state:"pending"`）、`exitSignal`、`terminationReason`、父 Host stderr。
- **未达成（cleanup PENDING，非 heartbeat 失败）**：fixture managed workspace `0ce4ddea-9284-49e9-890c-260fda350595` 的 public 处置（无存活 owner → 无 `allowed_dispositions`/`action_token`）；stale broker socket 清除；旧四根内未处置 worktree 的逐个处置。**未核查**受支持 orphan/workspace 恢复面是否存在（主管裁决为父层后续只读任务，本轮未执行）。
- **未执行**：tsc / fixture 类型检查 / package typecheck / 任何 unit 或全仓测试 / 任何其它 integration / 任何真实业务验证 / 任何清理动作 / 任何新 Host 启动 / 任何重复 SIGKILL 实验。
- **未做**：commit/push/stage/reset/stash（`git diff --cached --name-only` 空）；production、harness、fixture、统一计划、其它任务现场**零写入**。

## Source provenance 分类（H2 轮）

- **本轮新增改动**：仅本文（`docs/plans/records/2026-10-13-heartbeat-acceptance.md`，新建）。harness 三源、production（含 `extension.ts`、`process-birth-identity.ts`、`root-session-owner.ts`）、fixture、统一计划、其它任务现场**零改动**（mtime + `git status --porcelain` 开跑前后逐项一致）。
- **fixture 构造错误**：本轮未暴露（provider 未抛任何 fail-closed 错误，`child-91468.jsonl` 无 `observation-error`，`provider-observations.jsonl` 空）。run4 记录的 `childReport().commandsRun: []` 与 acceptance level 未声明属类别 2 遗留，**本轮不适用**（child 从未提交报告），未修、未削弱。
- **测试 harness 错误**：本轮未暴露新缺陷；前三轮定位并修复的三处（repo required-key / pre-title 取样 / 跨 locale 取样域）在全新 fixture 上第四次实证生效，且首次在 H2 kill 分支上通过。
- **production**：**无缺陷、无修改需求**。上述观察 1/2 均为「owner 被刻意杀死」的预期终态，按门禁**拒绝**增加任何终态补齐/兼容/fallback；`root-session-owner.ts` 的到期守卫语义（EOF 不立即终止、等待 `expiresAt`）被本轮真实数据证实按设计工作。
- **类别 3（来源尚未证实）**：本轮无新增。run3 记录的 `workspace/coordinator-registry.ts:73/154` 跨 LANG owner birth 可比性观察仍属独立只读 provenance 事项，本轮无任何该类事实，未处置。

## 结论与资源释放

**H2 实际父死验收：heartbeat 核心 = VERIFIED**（exit 0，3/3，真实 SIGKILL 一次、child 于已记录 lease 到期后 2619ms 自行消失、latencyMs 62449、remaining []、childSupplementaryKill:false、publicProcessProof `pending`、terminationReason `null`）。**fixture workspace cleanup = PENDING / blocked-environment**，现场按主管裁决原样冻结，未宣称 released。

心跳结论严格限定为「managed coding + worktree:true 拓扑下，父 Host 被 SIGKILL 后 child watchdog 依已记录 lease 到期自行终止，无 harness 补杀」；不含 child 结算、不含其它拓扑、不含 production 超时保证（90s 只是 harness fail 上限）。

`visible-host` + `heartbeat-fixture` 于本文交付后释放；本轮未占用 `unit-runner`。证据根 `hb-BXRJmy` 保留，`cleanupDisposition` 沿用 harness 权威值 `fixture-root-retained; public-workspace-cleanup-requires-live-owner-decision`；managed workspace、stale socket 与旧四根的精确处置移交父层后续**只读核查受支持恢复/管理路径**后按权威 `allowed` 决定，若确认无恢复面则只生成用户手动精确命令而不执行。本轮未执行任何清理、未新起 Host、未重复 SIGKILL 实验、不等待。
