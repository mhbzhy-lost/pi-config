# Session 取证：managed worktree 与 merge queue 实践的完整摩擦时间线

> **取证快照**：本报告冻结于根会话 JSONL 的 **L852 / 2026-09-21T12:22:36.135Z**。读取时文件共 **852 行**；该会话是 live 会话，取证期间从任务背景所称 843 行继续追加到 852 行，因此本文不把 843 当作固定终点。
>
> **权威来源**：`/Users/leshi.zhy/pi-config/var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl`。`L<n>` 均指该文件事件行，不是文本换行号。
>
> **child 证据更正**：任务背景指定的 `~/new-api-account-pool/.pi-subagents/artifacts/` 实测仅 670 个历史文件、mtime 最晚 2026-08-25，不含本会话 child；已放弃该死路，改用根会话 status 回执所指的 64 个 nested child session：`.../01a0bcca-.../<childDirUuid>/run-0/session.jsonl`。脚本用“child 首条 user 注入合同与根调用 title/objective 的文本匹配 + child session 起始时间落在 Started 后”的双条件建立映射，**64/64 映射成功，0 个未映射**；目录 UUID 与 runId 并非同一 ID 空间。映射产物见 `/tmp/wt-analysis/reports/child-map.json`。

## 1. 摘要

1. 根日志的 139 次 `subagent` 调用中，只有 **5 次**明确设置 `execution.worktree:true`；64 个实际 child cwd 也恰好只有 **5 个**位于 managed state root，另有 51 个在仓库根、8 个在 `sub2api`。这不是 runtime 静默降级：参数与 cwd 一一对应；绝大多数任务是 agent 主动使用 `worktree:false`。首个 managed 派发见 **L568 / 2026-09-21T03:37:30.718Z**：`"execution":{"cwd":"/Users/leshi.zhy/new-api-account-pool","worktree":true}`。
2. managed isolation 的“分配/隔离/保留现场”确实工作：首个 workspace `5c1844c9-...` 超时后，reminder 明确要求 status→处置（**L571 / 04:07:34.086Z**），status 返回 `origin-dirty`,`workspace-dirty`,`terminal-unobserved`（**L574 / 04:07:51.884Z**），agent 成功 preserve（**L578 / 04:08:08.933Z**）。
3. 但整场没有一次成功的 typed `disposition:"integrate"`：29 次 `subagent_worktree` 只有 status×15、dispose×5（全部 preserve）、release×6、list×3。agent 最终三次绕过 typed integration，以本地 path fetch + `git merge --ff-only` 把 commit 合回 canonical；最典型一次先失败两次（**L819 / 11:54:35.686Z**、**L821 / 11:56:06.374Z**），第三次才成功（**L824 / 11:56:55.940Z**）。
4. lifecycle 形成可复现死结：workspace 完成但 worktree service 仍报 `terminal-unobserved`，无法 integrate（**L809 / 11:52:51.964Z** 的 subagent 是 `complete / Process terminal: observed`，而 **L811 / 11:53:00.578Z** 的 worktree 仍是 `process_terminal:"pending"`）；手工 ff 后必须 preserve 才能 release，release 又因底层 `git worktree remove ... failed` 进入 cleanup-debt（**L826–L832 / 11:57:05–11:57:35Z**）。
5. `MANAGED_WORKSPACE_GIT` 共 **5 个独立 tool 失败事件**，涉及 `c161...` 两次、`5c...` 一次、`668...` 一次、`3b8...` 一次，全部到快照时未解。持久 ledger 最终是 **4 个 cleanup-debt + 1 个 active**，5 个目录均仍存在。
6. merge queue **被 admission/enqueue 了，但从未完成 rebase 或 publish**。唯一 queue item `0ed45c9b-...json` 仍为 `state:"queued", attempt:1`；4 个 resume intent 中 3 failed、1 starting/debt，`conflictDigest:null`；queue 没有 published receipt。child 连续 4 轮只报告“无 rebase 冲突”（**L839 / 12:00:07.031Z**、**L842 / 12:00:21.029Z**），agent称之为“lifecycle 空转”。
7. agent 的主要 workaround 是：保留 workspace 后跨 workspace fetch；委派普通 child 从残留路径做 canonical 化；typed 状态不同步时主 agent 直接 raw `git fetch`/`git merge --ff-only`/`git checkout --detach`。根 `bash` 26 次中，严格按“直接 workspace 补救”计 **4 次**（L816/L818/L820/L823），若把处置前 dirty/canonical 审计 L687/L704 计入则是 **6/26**。
8. contract/schema 负担显著：唯一调用事件口径为 `INVALID_CONTRACT` 9 次、`INVALID_PATH` 3 次，共 **12 次作废派发**；失败参数体 34,277 字符（约 8.6k token），其成功重发体 19,291 字符（约 4.8k token），总传输浪费约 **13.4k token**（按 4 字符/token 粗估，不含 thinking/回执）。30 个成功 typed coding 派发平均 1.37 次调用才启动；9 个曾失败的任务平均 2.22 次。
9. 错误文本在字段校验类通常可行动；在 lifecycle 类通常不足：`git worktree remove ... failed` 没有 stderr/占用进程/dirty 原因，导致五次同类失败；`status is unavailable in preserved` 不给恢复 action token 的路径，直接迫使 agent采用手工 canonical 化。
10. 快照终点仍未收口：新 workspace `01a2da1b-...` 为 active，且现场 `lsof` 有 2 个 cwd 引用；agent于 **L851 / 12:22:12.144Z** 仍报告 T8D4-3 执行中。四个旧 workspace 则是 cleanup-debt，queue 和 terminal proof outbox 仍有未消费状态。

## 2. 完整时间线

### 2.1 派发合同与模型摩擦（进入 managed 阶段前的前置成本）

| 时间 | L | 事件 | 证据原文与结果 |
|---|---:|---|---|
| 2026-09-20 08:31:00Z | L276 | reviewer 模型不可用 | `MODEL_NOT_AVAILABLE: Requested model is not available: astra; agent=reviewer`；后续改为可用模型。 |
| 08:48:25Z | L304–306 | T1 多余字段 | 参数含 `"outputMode":"inline"`，返回 `unknown field outputMode`；L306 明说“删除该字段后…重新派发”，随后启动成功。 |
| 08:59:02Z | L318–320 | full model ID 不可用 | `qoder-pool/gpt-6-astra` 对 executor 不可用；L320 改为 `qoder-pool/Qwen3.8-Max-0.2x` 后成功。 |
| 13:04:51–13:05:58Z | L395–399 | T7 连续两次合同失败 | 先 `missing required field boundaries`，补齐后又因 `workflow.reason is forbidden when mode is tdd`；第三次删除 reason 才成功。 |
| 14:29:31Z | L446–448 | docs-only 缺 reason | 返回 `workflow.reason is required when mode is docs-only`；加 `"reason":"只更新计划/决策文档..."` 后成功。 |
| 14:53–19:07Z | L456/L497/L520/L534/L548/L550 | 5 个 coding task 缺 boundaries，收尾任务又用绝对 writePath | 每个首次完整长合同被拒；T7 finalize 先缺 boundaries，再因 `writePaths[4] must be a repo-relative POSIX path` 被拒，L552 第三次才启动。 |

### 2.2 managed worktree 与集成关键时间线

| 时间 | L | 事件 | 证据引用 |
|---|---:|---|---|
| 2026-09-21 03:37:30Z | L568–569 | **第一次 `worktree:true`**，分配 `5c1844c9-...` | 派发 T8A，参数 `execution.worktree:true`；结果 `Started executor ... (2a379ed0-...)`，runtime details（原始 JSONL tool result details）给出 workspace_id。nested child cwd 确认为 `.../worktrees/5c1844c9-...`。 |
| 04:07:34Z | L571–572 | timeout + workspace reminder | `Subagent workspace awaiting disposition: 5c1844c9... Call ... status ... then integrate, discard, or preserve`；紧接着 task 30 分钟超时。 |
| 04:07:46Z | L573–574 | 首次 status | agent：“先按生命周期规则检查”；结果 allowed 仅 preserve/release，blocked 为 `terminal-unobserved`,`origin-dirty`,`workspace-dirty`。 |
| 04:08:08Z | L577–578 | preserve | `dispose(... disposition:"preserve")` 成功；workspace 转 preserved。 |
| 04:08:22–04:27:08Z | L579–582 | resume 同一 child，产出两个 commit | agent：“不新建第二个 worktree”；child 返回 `636b53125`、`0b444965d`，worktree clean。 |
| 04:27:33Z | L583–584 | preserved 后 status 失败 | `MANAGED_WORKSPACE_STATE: workspace status is unavailable in preserved`；agent此后拿不到新的 token/typed integrate。 |
| 07:46:10Z | L629 | agent 误判工具成功 | 原话：“`worktree: true` **按预期运行了**”“当前主要问题不是 worktree，而是主工作树 dirty”；但它同时计划“先保留完成 workspace”，为后续残留链埋下条件。 |
| 09:55:33–10:07:28Z | L667–675 | preserved workspace 被当长期主线反复 resume；旧 child 上下文耗尽 | L667：“commit 只存在于 preserved workspace”；L675：“新的 Qoder pool subagent 上下文直接指向同一受管 workspace”。 |
| 10:07:28–10:08:09Z | L675–680 | 想派新 child 回旧 workspace，三连失败 | 先两个 `INVALID_PATH`，再把 cwd 指到 managed state root，得到 `SUBAGENT_RPC_FAILED ... cwd cannot be inside the managed state root`。 |
| 10:09:13Z | L681–682 | **第二个 `worktree:true`**，分配 `c161c5e9-...` | agent决定“创建一个新的 managed worktree…fetch 前一 workspace”；child cwd 对应 c161。 |
| 10:15:52Z | L685 | agent确认尚未合回/回收 | 原话：“没有做过‘合回主工作树’的操作，也没有真正回收受管 worktree。” |
| 10:16:33–10:18:11Z | L687–692 | 用户指出 dirty 未处理与隔离机制失效；agent承认编排错误 | L689：“主 worktree dirty 还没有真正收敛”；L692：“当前做法把 preserved workspace 当成长期开发主线…这是我的编排错误。” |
| 10:18:29Z | L700 | c161 reminder | 第二个 `subagent-workspace-reminder`。 |
| 10:23:00Z | L708 | stop paused run 失败 | `invalid_state: ... paused; stop only supports running async runs`；agent改走 workspace处置。 |
| 10:27:22–10:28:11Z | L716–727 | c161 status×3、stale token、刷新后 preserve | L722 dispose 返回 `action token is stale...`；L724 重取 status/token；L726 再 dispose 成功。 |
| 10:28:19Z | L728–730 | c161 release 第一次失败 | `git worktree remove ... c161... failed`；agent称“保留该异常…不用 raw git 清理”。 |
| 10:31:06Z | L734–736 | 旧 canonical 被普通 child 手工 canonical 化后，5c/c161 release 又失败 | L734 宣布 root `0f6ff39`/gitlink `87bb590fb` 已合回；同一行并行两次 release，二者都 `MANAGED_WORKSPACE_GIT`。 |
| 10:31:16Z | L737–738 | list 显示二者 cleanup-debt | agent：“两个 preserved workspace 的 release 都被…失败阻断”。 |
| 10:31:39Z | L739–740 | **第三个 `worktree:true`**，分配 `6686ea46-...` | 从 clean canonical root 派 T8D4-1。 |
| 11:01:42Z | L753 | 668 reminder | 第三个、也是快照前最后一个 workspace reminder。 |
| 11:02:02–11:13:03Z | L755/L759/L769/L772/L774 | status×4 后过早 preserve | 四次 status 均无法给 integrate（主要 `terminal-unobserved`）；L774 agent：“runtime 仍未观测 terminal，因此暂不能 integrate。我会 preserve”。 |
| 11:16:16–11:17:19Z | L783–786 | child 已完成，preserved status 仍不可用 | child回执 clean commits；L784 status 返回 `status is unavailable in preserved`；L786 agent承认“生命周期操作上的又一次错误”，转普通 child 手工 ff。 |
| 11:26:40–11:27:00Z | L789–791 | 668 手工 ff 成功，release 失败 | L789 回执 `git merge --ff-only`；L790 宣布 canonical `e76f441/bdd0e6f6`；L791 底层 remove 失败。 |
| 11:27:20Z | L792–793 | **第四个 `worktree:true`**，分配 `3b8d0a57-...` | 从 canonical e76f441 派 T8D4-2。 |
| 11:52:16Z | L801 | child完成 clean commits | root `a7526c4`、sub2api `2cbca8565`。 |
| 11:52:25Z | L802–805 | 用错 workspace_id，NOT_FOUND；靠 list 找到真实 ID | status `3d9e19a2-...` 返回 NOT_FOUND；L804 thinking：“completion didn't mention workspace id? ... list”；list 得到 `3b8d...`。 |
| 11:52:41–11:53:00Z | L806–811 | subagent 与 worktree terminal 状态矛盾 | worktree 两次仍 `terminal-unobserved`；夹在中间的 subagent status 明确 `State: complete / Process terminal: observed`。 |
| 11:53:29–11:53:59Z | L812–815 | 普通兜底 child 被错误路由回原 managed cwd | agent委派 ff；child只检查 workspace，未改 canonical；L816 承认“误进入了原 managed workspace”。此时 queue 自动开始对 3b8 resume/冲突检查。 |
| 11:54:34–11:56:55Z | L818–824 | 主 agent raw Git 三次补救 | 第一次短 SHA fetch 失败；第二次猜错 root full SHA，merge 前失败；第三次读取明确 root ref，`git merge --ff-only` 成功。 |
| 11:57:05–11:57:35Z | L825–832 | release 状态不合法→status→preserve→release remove 失败 | 第一次 release 报“only a preserved or cleanup-debt”；status 仍 active/pending；preserve成功；release 再报底层 remove 失败。 |
| 11:57:58Z | L833–834 | **第五个 `worktree:true`**，分配 `01a2da1b-...` | 派 T8D4-3；快照时仍 active。 |
| 11:58:00–12:00:21Z | L835–842 | queue/lifecycle 对旧 3b8 连续重复冲突检查 | child第3、4轮均称“无 rebase 冲突…未调用任何 integration 变更工具”；L839 progress update 明说“连续 4 轮…疑似 lifecycle 空转”。 |
| 12:00:37Z | L843 | agent放弃旧 queue task | “不会再恢复或派发该 task；workspace cleanup-debt 仅作为基础设施残留”。 |
| 12:22:12–12:22:36Z | L851–852 | 会话快照终点 | L851 当前唯一开发任务仍为 `f96773e7...`；L852 是该 child progress update。持久 ledger 中 `01a2... state:"active"`，现场有进程 cwd 引用。 |

## 3. 错误因果链逐条分析

> 计数口径为“根 JSONL 中唯一 tool result 事件”，不把同一事件的 ARGS/DETAILS/RESULT 文本行重复计数。由此，现场是 MODEL_NOT_AVAILABLE 2 次而非预扫描的 4 次，INVALID_PATH 3 次而非 6 次，SUBAGENT_RPC_FAILED 1 次而非 2 次。

**26 个唯一错误事件索引（时间均为 UTC）**：

| 错误码 | L / 时间戳 |
|---|---|
| MODEL_NOT_AVAILABLE ×2 | L276 `2026-09-20T08:31:00.133Z`；L318 `2026-09-20T08:59:02.363Z` |
| INVALID_CONTRACT ×9 | L304 `08:48:25.230Z`；L395 `13:04:51.661Z`；L397 `13:05:30.509Z`；L446 `14:29:31.010Z`；L456 `14:53:44.071Z`；L497 `16:40:36.849Z`；L520 `17:32:35.258Z`；L534 `18:20:12.206Z`；L548 `19:06:14.019Z`（均为 `2026-09-20`） |
| INVALID_PATH ×3 | L550 `2026-09-20T19:06:40.186Z`；L675 `2026-09-21T10:07:28.428Z`；L677 `2026-09-21T10:07:48.336Z` |
| SUBAGENT_RPC_FAILED ×1 | L679 `2026-09-21T10:08:09.767Z` |
| invalid_state ×1 | L708 `2026-09-21T10:23:00.424Z` |
| MANAGED_WORKSPACE_ACTION ×1 | L722 `2026-09-21T10:27:50.588Z` |
| MANAGED_WORKSPACE_GIT ×5 | L728 `2026-09-21T10:28:19.182Z`；L734 两个独立调用 `2026-09-21T10:31:06.453Z`；L790 `2026-09-21T11:26:58.727Z`；L831 `2026-09-21T11:57:33.596Z` |
| MANAGED_WORKSPACE_STATE ×3 | L583 `2026-09-21T04:27:33.903Z`；L784 `2026-09-21T11:16:29.278Z`；L825 `2026-09-21T11:57:05.470Z` |
| MANAGED_WORKSPACE_NOT_FOUND ×1 | L802 `2026-09-21T11:52:25.984Z` |

### 3.1 `INVALID_CONTRACT`（9 次）与 `INVALID_PATH`（3 次）

| 错误/次数 | 想做什么与参数 | 错误 | 下一步/结局 |
|---|---|---|---|
| unknown `outputMode` ×1 | T1 docs-only；L304 参数尾部有 `"outputMode":"inline"` | L305 `unknown field outputMode` | L306 明确删除，第二次成功；**1 次重试**。 |
| missing `boundaries` ×6 | T7/T7A/T7B/T7C 切片：L395、456、497、520、534、548；均发送约 2.7–3.7k 字符的完整要求，但结构漏掉/未被解析到 boundaries | `missing required field boundaries` | 每个补完整合同；其中五个下一次成功，T7 design 又撞 tdd reason，finalize 又撞 path；分别 1–2 次重试。 |
| tdd forbidden reason ×1 | L397 `"workflow":{"mode":"tdd","reason":"..."}` | `workflow.reason is forbidden when mode is tdd` | L399 删除 reason 后成功；和前一 missing boundaries 合计 **2 次失败、第三次启动**。 |
| docs-only required reason ×1 | L446 `"workflow":{"mode":"docs-only"}` | `reason is required` | L448 加 reason 成功；**1 次重试**。 |
| repo-relative path ×1 | L550 `writePaths[4]` 是 `/Users/.../docs/reports/...` 绝对路径 | `must be a repo-relative POSIX path` | L552 改为从根 cwd 使用 repo-relative 范围后成功；该 task总计第三次启动。 |
| unsupported glob/path ×2 | L675 用 `sub2api/backend/internal/service/**/*test.go` 等内部 glob；L677 改成 `sub2api/backend/internal/service/` 等目录仍被拒 | `contains an unsupported path pattern` | 第一次按错误提示去掉 glob，但目录语义仍不自明；第二次又失败。L679 改 cwd 到 managed submodule，转成 RPC 失败。 |

**是否改对**：前 8 个受 contract/path 拒绝的任务最终成功启动；`t8d4-1-contributor-settings` 这个原 taskId 的 3 次尝试始终未启动，agent在 **L681 / 10:09:13.666Z** 改成新的 taskId `...-fresh` + 新 worktree 才启动。语义上是第 4 次派发才开始执行。

### 3.2 `MODEL_NOT_AVAILABLE`（2 次）

- **L276 / 08:31:00.133Z**：agent想按用户要求用 reviewer Astra，参数 `agent:"reviewer", model:"astra"`；错误只说模型不可用。它后续改用可解析模型并完成审阅。
- **L318 / 08:59:02.363Z**：agent先 grep 本机模型目录，看到 `gpt-6-astra`（L317），于是发 `model:"qoder-pool/gpt-6-astra"`，却收到 `Requested model is not available ... agent=executor`。L320 明说改用 `qoder-pool/Qwen3.8-Max-0.2x`，第二次成功。
- **因果要点**：本机 catalog“存在 ID”不等于该 profile 当前可用；错误没有列出 executor 可用候选，agent只能自行 grep/猜 provider-profile 组合。

### 3.3 `SUBAGENT_RPC_FAILED`（1 次）

- **意图**：旧 child 上下文 95.5% 耗尽，但 `5c...` workspace/checkpoint `87bb590fb` 还在；agent想用新 child 接管同一 workspace（L675：“不新建 worktree、不复制分支”）。
- **参数**：前两次 writePaths 校验失败后，L679 把 `execution.cwd` 设为 `.../worktrees/5c.../sub2api`、`worktree:false`。
- **错误**：L680 `Dispatch execution contract is invalid: dispatch request cwd cannot be inside the managed state root`。
- **下一步**：L681 新建第二个 managed worktree c161，并要求它从旧 preserved path fetch checkpoint。
- **是否改对**：派发成功，但破坏了“canonical→child→integrate→下一基线”的隔离模型；用户在 L691 指出“让新的subagent直接去读残存worktree，那这隔离机制形同虚设”，agent在 L692 承认编排错误。

### 3.4 `MANAGED_WORKSPACE_STATE`（3 次）

1. **preserved status unavailable ×2**：L583 对 5c、L784 对 668。agent想在 child 完成后重取 status/action token 再 integrate，但 preserved 是终态，status直接不可用。两次都转为从 workspace 本地仓库 fetch commit、手工 fast-forward canonical。**typed integrate 始终没成功**。
2. **release active workspace ×1**：L825 对 3b8 直接 release，错误说 only preserved/cleanup-debt 可 release；agent按字面执行 status→dispose preserve→release（L827–831），流程方向正确，但最后又撞 `git worktree remove failed`，仍未回收。

### 3.5 `MANAGED_WORKSPACE_ACTION` stale token（1 次）

- **意图**：c161 child无有效产物，agent想 preserve/release。
- **参数**：L720 最新 status 给 token；L722 立即 `dispose(... preserve, token=331b...)`。
- **错误**：`action token is stale, replayed, or does not match the workspace snapshot`，但错误未说明 snapshot 哪一字段变化。
- **下一步**：L724 再 status，拿新 token `e526...`；L726 重试成功。**1 次重试解决 token 问题**；紧接 release 仍失败。

### 3.6 `MANAGED_WORKSPACE_GIT`（5 次，全部未解）

| L/时间 | workspace | 前置动作 | 后续 |
|---|---|---|---|
| L728 / 10:28:19Z | c161 | fresh token preserve成功 | 第一次 remove 失败；L734 再 release仍失败。 |
| L734/L735 / 10:31:06Z | 5c | canonical 已手工合回，workspace preserved | remove 失败。 |
| L734/L736 / 10:31:06Z | c161 | 同上 | 第二次 remove 失败。 |
| L790/L791 / 11:26:58Z | 668 | commit 已手工 ff 到 canonical | remove 失败。 |
| L831/L832 / 11:57:33Z | 3b8 | active→status→preserve | remove 失败。 |

错误文本只有 path，没有 git stderr、exit code、dirty/lock/cwd/process 诊断。agent只好“保留给 lifecycle service 重试”（L730），但 5 次均无成功重试。最终 records 四者均 `state:"cleanup-debt"`、`cleanupDebt.phase:"release"`。

### 3.7 `MANAGED_WORKSPACE_NOT_FOUND`（1 次）

- L802 child完成后 agent想 status/integrate，却使用了不存在的 `3d9e19a2-...`；错误仅说 record not found。
- L804 thinking：“completion didn't mention workspace id? We can list.”；L805 list 找到真实 `3b8d0a57-...`。**1 次 list 后修正**。
- 这同时证明 Started/Completion 回执没有在 agent可直接引用的位置稳定携带 workspace_id；它只能记忆 reminder 或 list。

### 3.8 `invalid_state`（1 次）

- L696 agent要停止 c161 新 workspace；L708 调 `subagent stop`，得到 `paused; stop only supports running`。
- 后续不再 stop，而是 status workspace、刷新 token、preserve/release。错误对“为何不能 stop”清楚，但没有直接给 paused run 的正确动作（resume/interrupt/terminate 哪个）。

## 4. 死结清单与遗留现场状态

### 4.1 未解决死结

1. **四个 cleanup-debt 无法删除**：5c、c161、668、3b8。持久 ledger 路径：`.../records/{5c1844c9...,c161c5e9...,6686ea46...,3b8d0a57...}.json`，均为 `cleanupDebt.code:"MANAGED_WORKSPACE_GIT"`。与 L728/L734/L790/L831 五次失败相互印证。
2. **terminal proof / worktree state 不一致**：L809 的 async run 已 terminal observed，L811 的 workspace仍 pending；这阻止 integrate。`terminal-proof-outbox/terminal-proofs.json` 有 4 条 `pending[].state:"observed"`，但 `receipts:{}`，说明 proof 被观察却未形成可消费 receipt。
3. **preserve 后无法回到 integrate**：L784 明确 status unavailable；agent只能绕开 typed工具手工 ff。records 的 `integrationIntent:null`、`integrationReceipt:null`、`integrationHistory:[]` 也证明 ledger 没记录三次手工合回。
4. **merge queue 空转**：唯一 queue item仍 queued，4个 resume intent反复唤醒同一 child做“冲突检查”，没有 publish；L839 child称连续4轮零变化，L843 agent放弃继续派发。
5. **第五个 workspace仍 active**：`records/01a2da1b-....json` 为 active，run `f967...`；L851仍称其执行中。现场目录存在且 lsof 见2个 cwd引用，不能回收。

### 4.2 五个 workspace 最终现场

| workspace | root派发/用途 | ledger 原文（文件 `updatedAt`） | 集成事实 | 目录/进程 |
|---|---|---|---|---|
| `5c1844c9-...` | L568 / 03:37:30.718Z T8A canonical迁移线 | `records/5c1844c9-....json`：`"state":"cleanup-debt"`、`"code":"MANAGED_WORKSPACE_GIT"`（`2026-09-21T10:31:07.835Z`） | 未 typed integrate；L734 / 10:31:06.453Z 报告普通 child 已把 `87bb590fb` canonical 化到 root `0f6ff39` | 目录仍存在；0 cwd引用 |
| `c161c5e9-...` | L681 / 10:09:13.666Z 从旧 checkpoint 继续 settings | `records/c161c5e9-....json`：`"state":"cleanup-debt"`、`"code":"MANAGED_WORKSPACE_GIT"`（`2026-09-21T10:31:09.197Z`） | 无有效commit，不集成；L728/L734 release两次失败 | 目录仍存在；0 cwd引用 |
| `6686ea46-...` | L739 / 10:31:39.572Z canonical settings | `records/6686ea46-....json`：`"state":"cleanup-debt"`、`"code":"MANAGED_WORKSPACE_GIT"`（`2026-09-21T11:27:00.159Z`） | 未 typed integrate；L789 / 11:26:40.771Z 普通child ff到 `e76f441/bdd0e6f6` | 目录仍存在；0 cwd引用 |
| `3b8d0a57-...` | L792 / 11:27:20.760Z cache invalidation | `records/3b8d0a57-....json`：`"state":"cleanup-debt"`、`"code":"MANAGED_WORKSPACE_GIT"`（`2026-09-21T11:57:35.079Z`） | queue曾 admission但未publish；L824 / 11:56:55.940Z 主 agent raw ff到 `a7526c4/2cbca8565` | 目录仍存在；0 cwd引用 |
| `01a2da1b-...` | L833 / 11:57:58.682Z contributor policy | `records/01a2da1b-....json`：`"state":"active"`、`"cleanupDebt":null`（`2026-09-21T11:58:00.294Z`） | L851 / 12:22:12.144Z 尚在执行，未集成 | 目录仍存在；2 cwd引用 |

五个目录事实路径：`.../worktrees/{01a2da1b,3b8d0a57,5c1844c9,6686ea46,c161c5e9}-.../`。未执行任何删除或修复。

## 5. workaround 清单与 raw Git 使用统计

### 5.1 agent 自创 workaround

1. **长期 preserve + resume 同一 child/session**：L579 明说“不新建第二个 worktree”；优点是保住中间产物，缺点是旧 child最终上下文耗尽，且 workspace不能status/integrate。
2. **新 worktree 跨读旧残留 path**：L681 要 c161 从 5c 的本地 `sub2api` fetch checkpoint；用户L691指出隔离失效，agent L692承认。
3. **普通 child 做等价 canonical 化**：5c 和 668 都不是 typed integrate，而是委派 `worktree:false` child从 managed path fetch + ff。L712 明说“由于 preserved workspace 已不能走 runtime integrate…采用等价且可审计的 canonical 化流程”。
4. **主 agent inline raw Git**：3b8 因 terminal状态不同步且兜底 child误路由，L818–824 直接使用本地 file fetch、`git merge --ff-only`、`git checkout --detach`；两次参数猜测失败后第三次成功。
5. **换 disposition/重复 lifecycle**：status→preserve→release；token stale 后再 status；active release失败后再 status→preserve→release；对 c161 release两次。
6. **child自行初始化 submodule**：5个 managed root中的 `sub2api` 并非始终是可直接工作的 submodule。nested sessions显示：3b8 child使用 `git checkout -b` 初始化本地分支；01a2 child甚至 `git clone -q --no-checkout ... sub2api && git checkout --detach ...`。这不是 raw `git worktree add/remove`，但说明 managed root只隔离根仓，不保证嵌套 submodule开发环境就绪。
7. **raw branch/checkout**：对5个 managed child transcript做命令词法统计，共命中 `git branch` 40次、`git checkout` 7次、`git fetch` 2次、`git worktree` 21次；其中 `git worktree` 命中均为 `list`/状态核验，没有 add/remove/prune，branch/checkout主要用于嵌套 submodule迁移线。这是业务Git操作，不是外层 workspace lifecycle，但反映 typed工具只管理外层 root，不管理 submodule分支/clone。例：T8A child `.../4ec90751-.../run-0/session.jsonl` child-L41 / `2026-09-21T03:42:08.814Z` 执行 `git checkout -b migration/v0.2.7-dual-pool v0.2.7`；01a2 child `.../0206824c-.../run-0/session.jsonl` child-L44 / `2026-09-21T12:01:27.318Z` 执行本地 clone 后 detach checkout。

### 5.2 `bash`×26 统计

- **严格 workspace 补救：4/26**：L816 诊断 canonical、L818/L820/L823 三次手工集成尝试（其中2失败、1成功）。
- **宽口径 workspace 补救：6/26**：再加 L687 主 worktree dirty审计、L704 canonical化前状态审计。
- 其余20次主要是普通状态/diff/测试产物核验，不把每个 `git status` 都夸大为 lifecycle workaround。
- **没有** root assistant `git worktree add/remove/prune`、`rm`、`git reset`；child里有多次只读 `git worktree list`，以及 branch/checkout/clone。release 的破坏性 remove 始终由 typed service 发起并失败。

## 6. 认知负担量化

### 6.1 派发合同浪费

- unique contract/path validation rejects：**12**（INVALID_CONTRACT 9 + INVALID_PATH 3）。
- 失败参数体：**34,277 字符 ≈ 8.6k token**。
- 为修正这些失败而完整重发的成功参数体：**19,291 字符 ≈ 4.8k token**。
- 合计可归因传输：**53,568 字符 ≈ 13.4k token**。估算公式是 4字符/token；中文/JSON tokenizer实际可能更高，因此只是数量级，不是假装精确账单。
- 最重个案：T7 design L395/L397/L399，**3 次调用**；T7 finalize L548/L550/L552，**3 次调用**；T8D4-1语义任务 L675/L677/L679/L681，**4 次才启动**且被迫换taskId/worktree。

### 6.2 “想派 coding child → 真正启动”的往返

根日志 44 次 typed coding调用中，30次成功启动、14次被拒（其中1次 typed model、12次 contract/path、1次 RPC；另一个 reviewer `astra` 模型失败是 generic 调用，不在这44次内）。对30个最终成功的 typed task：

- 平均调用次数：**1.37次/成功task**；即平均多 **0.37个失败往返**。
- 曾失败后成功的9个task：平均 **2.22次**，即通常需要“失败一次再重发”，两个task失败两次。
- `t8d4-1-contributor-settings` 原taskId三次都失败，改名 `...-fresh` 才启动；按业务意图算4次。

### 6.3 `subagent_worktree` 29 次的试错量

动作分布：status 15、dispose 5、release 6、list 3。

按保守规则，把“同一workspace已知状态后重复status、错误状态release、stale-token重试、重复失败release、错误ID status”记为试错/恢复，得到 **18/29**；其余11次是首次发现/必要处置。逐workspace调用密度：

- c161：8次（status4/dispose2/release2）；
- 668：7次（status5/dispose1/release1）；
- 3b8：6次（status3/dispose1/release2）；
- 5c：4次；
- 错误ID：1次；list：3次。

这不是说18次“毫无价值”，而是它们没有推进业务集成，只在探测或修复 lifecycle 状态。

### 6.4 child cwd 与 worktree选择

64个 nested child cwd：仓库根51、`sub2api` 8、managed worktree 5。根调用中也恰有5次 `execution.worktree:true`，故无静默降级。

8个 `sub2api` cwd child都是早期T7任务，派发明确 `worktree:false`，writePaths相对 submodule（如 L399 的 `backend/internal/service/**`），runtime可运行；但当 agent把 cwd/WritePaths跨越根仓与submodule混用时，就在 L548/L550 或 L675/L677 被拒。这说明规则是可一致执行的，却要求 agent时刻判断“当前 repo root究竟是根仓还是submodule”。

## 7. merge queue 是否真正生效

### 判定：**队列 admission/resume 被触发，但自动 rebase/publish 从未完成；不能称 merge queue 成功跑通。**

证据：

1. `integration-queue/queue-index.json` 只有一项 `0ed45c9b-...json`；item为 workspace `3b8d0a57-...`、strategy `rebase-ff`、`state:"queued"`、`attempt:1`、authorized head `a7526c4...`。
2. 4个 `resume-*.json`：attempt 1–3 均 `state:"failed"`；attempt4为 `state:"starting"` 但 delivery `state:"debt", reason:"run can bind only to an active workspace"`。没有 `published`/`integrated` 状态。
3. 所有 resume intent 的 `conflictDigest:null`；child在 L815/L822/L835/L842反复报告“无 rebase 冲突”“未调用任何 integration 变更工具”，所以**没有真实冲突被发现或解决**。
4. `records/3b8....json` 最终 `integrationIntent:null`,`integrationReceipt:null`,`integrationHistory:[]`；queue item虽存在，ledger未记成功集成。
5. `terminal-proof-outbox/terminal-proofs.json` 的 `receipts:{}`；4条 pending observed proof未转成receipt。
6. 实际 publish/canonical动作是主 agent L824 的 raw `git merge --ff-only`，不是 queue。agent L812也明确称这是“worktree service状态同步异常下的兜底”。

因此：queue确实“被跑起来”到 enqueue和自动resume层，但核心承诺（串行rebase→publish→receipt→cleanup）没有一项完成；反而产生4轮重复冲突检查和一个最终delivery debt。

## 8. agent 原话痛点摘录

以下收集从首次worktree使用到快照终点所有**不同语义**的困惑、猜测、试错、自我纠错句；重复状态播报合并，但保留每种痛点的首次/关键原文。

- **L573 / 04:07:46.834Z**：“先按生命周期规则检查 workspace 状态和改动，决定保留/集成/丢弃；不会直接用原工作树猜测副作用。”
- **L575 / 04:08:00.710Z**：“T8A workspace 仍处于 active/dirty，且 origin 本身有既有 dirty，因此当前不能 integrate 或 discard。”
- **L579 / 04:08:22.674Z thinking**：“Need inspect preserved workspace via bash allowed path? ... Better resume failed run?”
- **L629 / 07:46:10.671Z**：“`worktree: true` **按预期运行了**……当前主要问题不是 worktree，而是主工作树 dirty 和迁移分支尚在隔离 workspace 中。”
- **L641 / 08:15:41.283Z**：“当前 clean checkpoint 位于 preserved workspace 的本地迁移分支中，尚未进入主仓对象/根 gitlink；为避免多个 worktree 对不可见本地 commit 各自复制出分叉……”
- **L667 / 09:55:33.865Z**：“该 commit 只存在于 preserved workspace 的 local submodule repo，standalone root worktree allocator未必可见。”
- **L669 / 09:55:52.250Z**：“直接新建 standalone worktree 不一定能解析该 commit。”
- **L675 / 10:07:28.428Z**：“已有 managed workspace 和 clean checkpoint 均保留。我会用新的 Qoder pool subagent 上下文直接指向同一受管 workspace。”
- **L677 / 10:07:48.336Z**：“新上下文首次派发因写路径 glob 不合法被拒，未运行。改为目录级写边界后重新派发。”
- **L679 / 10:08:09.767Z**：“写路径校验拒绝了跨根仓/submodule 的目录范围……改为以 managed workspace 的 `sub2api` 为 cwd。”
- **L681 / 10:09:13.666Z**：“当前受管 workspace 本身可用，但新的 subagent 不能把 `cwd` 直接设到 managed state root；旧 session 又已达上下文上限。”
- **L685 / 10:15:52.734Z**：“没有做过‘合回主工作树’的操作，也没有真正回收受管 worktree。”
- **L689 / 10:17:47.393Z**：“**主 worktree dirty 还没有真正收敛**，之前只做了‘保护并记录’，没有做清理/提交。”
- **L692 / 10:18:11.801Z**：“当前做法把 preserved workspace 当成长期开发主线，再让新 subagent 跨 workspace 读取它，确实绕开了 managed worktree 的‘完成→验收→合回→从新基线再分出’机制……这是我的编排错误。”
- **L702 / 10:18:42.930Z**：“`worktree A 长期 preserve → worktree B 从 A 的残存路径 fetch → worktree C 再依赖 B`”被列为错误模式。
- **L710 / 10:23:13.338Z thinking**：“Need preserve active workspace after status... Could dispose preserve. Then release eventually... Need inspect.”
- **L712 / 10:24:09.924Z thinking**：“Existing old workspace is preserved and cannot status... Auto integration impossible while preserved.”
- **L712 / 10:24:09.924Z**：“由于 preserved workspace 已不能走 runtime `integrate`，我会采用等价且可审计的 canonical 化流程。”
- **L716 / 10:27:22.077Z**：“新 contributor workspace 已确认没有 commit、没有代码、没有 TDD 产物……先按 managed workspace 状态执行生命周期处置。”
- **L728 / 10:28:19.182Z thinking**：“Can release now since no changes; preserve used then release.”
- **L730 / 10:28:29.610Z**：“release 时底层 worktree remove 失败；我会保留该异常供 lifecycle service 后续重试，不用 raw git 清理。”
- **L737 / 10:31:16.911Z**：“两个 preserved workspace 的 release 都被 lifecycle service 的 `git worktree remove` 失败阻断。”
- **L755 / 11:02:02.049Z**：“若有完整 commit/clean 就 integrate，若没有就 preserve/收敛，不再跨 workspace 读取。”
- **L761 / 11:02:47.654Z**：“workspace 当前没有 dirty/blocked write，仅 terminal observation 尚未同步。”
- **L769 / 11:12:20.993Z thinking**：“Could use supervisor status? no. Check after interrupt once.”
- **L774 / 11:13:03.020Z**：“只读收尾命令异常卡住，已中断……runtime 仍未观测 terminal，因此暂不能 integrate。我会 preserve 现场。”
- **L780 / 11:13:40.814Z**：“任务实际上已经完整提交并验证，只是最终回执命令卡住后被我过早 preserve。”
- **L786 / 11:17:19.086Z**：“该 workspace 已经被我在 terminal 同步前误设为 preserve，因此 runtime 不再允许直接 `status/integrate`。这是生命周期操作上的又一次错误。”
- **L792 / 11:27:20.760Z thinking**：“Cleanup debt again. Need maybe lifecycle bug persists.”
- **L802 / 11:52:25.984Z thinking**：“Integrating workspace correctly.”（随即因猜错 workspace_id 得 NOT_FOUND。）
- **L804 / 11:52:33.293Z thinking**：“completion didn't mention workspace id? We can list.”
- **L808 / 11:52:51.956Z thinking**：“Native status might lag. Do not preserve.”
- **L812 / 11:53:29.321Z**：“subagent runtime：`complete`，`process terminal: observed`；worktree service：仍显示 `terminal-unobserved`。”
- **L812 / 11:53:29.321Z**：“只能采用与前次相同的受控 fast-forward……这是 worktree service 状态同步异常下的兜底。”
- **L816 / 11:54:11.519Z**：“兜底任务误进入了原 managed workspace，而不是 canonical 主 worktree。”
- **L818 / 11:54:34.032Z**：“由主 agent inline 执行精确 `ff-only` 集成……不再委派，以免 cwd 再次被 managed workspace 重定向。”
- **L820 / 11:56:05.167Z**：“直接 fetch 短 SHA 被 Git 拒绝……改为从 workspace 的明确本地分支 ref 获取。”
- **L823 / 11:56:54.398Z**：“第二次精确集成在 `git merge` 前失败：我使用了错误的 root 完整 SHA推测。”
- **L827 / 11:57:14.874Z thinking**：“Official integrate still blocked. But code canonical. Could status and preserve release.”
- **L833 / 11:57:58.682Z**：“workspace 清理仍被底层 remove 失败，进入 cleanup-debt。”
- **L836 / 11:58:12.329Z**：“刚收到的是旧 cache workspace 的重复收尾回执，不是新 T8D4-3。”
- **L839 / 12:00:07.031Z child progress**：“已连续 4 轮收到完全相同的‘检查 rebase 冲突’派发……疑似 lifecycle 空转。”
- **L840 / 12:00:21.013Z**：“这是旧 T8D4-2 workspace 的 lifecycle 空转。”
- **L843 / 12:00:37.573Z**：“workspace cleanup-debt 仅作为基础设施残留，不参与后续开发。”
- **L845 / 12:06:54.883Z**：“旧 workspace lifecycle 的 `terminal-unobserved/cleanup-debt` 仍是工具层清理问题。”

这些原话显示认知负担并非只来自一次失败：agent持续在“run terminal”“workspace terminal”“preserved是否可恢复”“submodule对象是否可见”“queue是否正在集成”“哪个workspace_id对应任务”之间手动建立心智模型。

## 9. 错误信息可行动性评估

| 错误码 | 文本是否告诉下一步 | 评价与实例 |
|---|---|---|
| `INVALID_CONTRACT unknown outputMode` | 是 | 精确 keypath，L306直接删字段后成功。 |
| `missing boundaries` | 部分 | 告诉缺字段，但没指出为何调用看似有完整长合同仍缺；agent需重组整个参数体。六次重复说明schema不易内化。 |
| tdd reason forbidden / docs-only reason required | 是 | 互补规则明确，L399/L448一次修好；但同字段随mode反转增加记忆负担。 |
| `INVALID_PATH must be repo-relative` | 是 | L550绝对路径一次修好。 |
| `unsupported path pattern` | 否/不足 | 只给 offending index，不列允许语法。L675去掉 `**/*test.go` 改目录后 L677仍失败，说明错误不足以指导正确边界。 |
| `MODEL_NOT_AVAILABLE` | 否/不足 | 不列该agent可用模型。L317从models.json看到gpt-6-astra仍在L318失败，最后靠换Qwen猜中。 |
| `cwd cannot be inside managed state root` | 部分 | 禁止事项明确，却不提供“如何让新child接管现有workspace”。agent被迫建新worktree并跨path fetch，最终被用户指出隔离失效。 |
| `status unavailable in preserved` | 否 | 没有给“恢复到可integrate状态”的typed动作，也不返回最后snapshot/token。L786只能手工ff。 |
| `only preserved or cleanup-debt can be released` | 是 | L827按提示先status/preserve；但后续remove仍失败。 |
| stale action token | 部分 | 告知重取token的隐含方向，但未说明snapshot变化原因；L724重status后成功。 |
| `MANAGED_WORKSPACE_GIT ... remove failed` | 否 | 没有stderr/exit code/占用PID/dirty/lock/建议动作。五次全部死结，是最不可行动的错误。 |
| `MANAGED_WORKSPACE_NOT_FOUND` | 部分 | 只说ID错；没有列出候选。agent自行list找到真实ID。 |
| `invalid_state paused; stop only supports running` | 部分 | 说明为什么错，但不说明paused应调用resume、interrupt还是dispose。 |
| queue resume `run can bind only to an active workspace` | 否/矛盾 | queue在workspace被手工canonical并preserve后仍尝试resume，delivery转debt；没有自动停止/撤队列。 |

## 10. runtime 缺口候选清单（需源码确认）

1. **run terminal proof 与 workspace ledger消费不同步**：同一时刻 subagent status observed、workspace仍 pending（L809/L811）。需源码确认事件投递/receipt丢失点。
2. **preserve 是单向门**：完成产物被过早 preserve 后无法再status/integrate，且错误不给恢复动作。需确认是否设计如此，或缺少 unpreserve/resume-integration API。
3. **release 诊断严重不足**：5次只返回“git worktree remove failed”。需确认stderr是否被吞、是否未检查cwd持有者/submodule/dirty/lock。
4. **queue与人工处置无互斥/撤销**：3b8已手工ff并preserve/release，queue仍4轮resume冲突检查；最后delivery debt。需确认queue item取消与workspace state transition绑定。
5. **workspace_id可发现性不足**：completion未稳定暴露ID，agent猜错后靠list；reminder也可能迟到/缺失（5个workspace只有3个reminder）。需确认通知条件。
6. **无法把新child安全绑定到既有managed workspace**：cwd直接指入state root被RPC拒绝，只能resume旧上下文；旧上下文满后无typed handoff。需确认是否缺少 `workspace_id` 续派入口。
7. **managed root对submodule初始化/对象可见性不保证**：child需自行clone/checkout/branch；导致writePaths和repo root语义复杂。需确认allocator是否应递归初始化submodule或显式声明不支持。
8. **typed integrate在真实路径中未可达**：5次worktree、29次生命周期调用，零 integrate；工具面把agent推向普通child或raw Git canonical化。需源码确认allowed dispositions生成条件是否过严/状态滞后。
9. **contract自解释不足**：writePaths允许语法、tdd/docs-only reason规则、目录与glob边界依赖外部skill记忆；12次无副作用但昂贵拒绝。可考虑schema introspection/机器可读allowed patterns（需源码确认）。
10. **模型catalog与profile availability不一致的可见性**：models.json存在ID但executor不可用，错误不列候选。需确认模型路由诊断能否返回profile-scoped可用集合。
11. **terminal-proof outbox observed但receipts空**：持久文件表明proof到达outbox却未消费；可能与terminal-unobserved核心死结同根（需源码确认）。
12. **queue item与workspace record状态脱节**：queue item queued但record `integrationIntent:null`/history空，可能让恢复逻辑无法知道已admit过（需源码确认）。

---

## 附：复核索引与方法

- 批量解析脚本：`/tmp/wt-analysis/reports/analyze_session.py`、`map_children.py`、`summarize_evidence.py`、`extract_contexts.py`。
- 中间事实：`facts.json`、`child-map.json`、`evidence-summary.json`。
- workspace ledger：`/Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/records/*.json`。
- queue：同目录 `integration-queue/*.json`。
- terminal proof：同目录 `terminal-proof-outbox/terminal-proofs.json`。
- 本报告只写 `/tmp/wt-analysis/reports/`，未修改两个仓库、session、workspace ledger或worktree。
