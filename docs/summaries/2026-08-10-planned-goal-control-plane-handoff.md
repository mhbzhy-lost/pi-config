# Planned Goal 基础控制面接续 Handoff

日期：2026-08-10

仓库：`/Users/mhbzhy/pi-config`

Goal：`planned-goal`，epoch `1`

## 1. 接续结论

`planned-goal` 仍为 active，当前权威进度为 `14/17 accepted`、`3 pending`、`0 blocked`。剩余 DAG：

```text
dual-settle
    |
    v
migration-docs
    |
    v
final-verification
```

当前可运行任务是 `dual-settle`。原协调 session 已通过 typed `detach_session` 撤销 watching 和 mutation authority；它现在只能只读查看 projection，`machineAction=null`、`action_token=null`。接手者必须使用**新的可信 Pi session**，在本仓 canonical cwd 中先调用 `goal_status(goal_id="planned-goal")`，并且只服从该次返回的 machine action 与一次性 action token。

顶层 continuity checkpoint 的 `nextAction` 仍写着“discard Attempt 20”，这段文字已经过时且不具 mutation authority。`dual-settle` 的 workspace projection 已明确记录 Attempt 20 为：

```text
phase: disposed
disposition: discarded
released: true
executorHead: e386f53c817ff203b80d7929217014bb5902b6a0
```

因此不得再次猜测性清理 Attempt 20。实际下一步是 dispatch Attempt 21。

## 2. 权威来源与首轮操作

接手后按以下顺序操作：

1. 阅读本 handoff、`pi/AGENTS.md` 和 `skill-overrides/using-goal-engine/SKILL.md`。
2. 加载 `using-goal-engine` 与 `subagent-dispatch` Skill；涉及逻辑变更的 executor 必须加载 `test-driven-development` Skill。
3. 在 `/Users/mhbzhy/pi-config` 调用：

   ```text
   goal_status(goal_id="planned-goal")
   ```

4. 只有当返回 fresh：

   ```json
   {
     "machineAction": {
       "tool": "goal_dispatch",
       "params": {
         "goal_id": "planned-goal",
         "task_id": "dual-settle"
       }
     },
     "action_token": "fresh one-time token"
   }
   ```

   才能调用 `goal_dispatch`。不得复用本文、checkpoint、旧 session 或历史 transcript 中的 token。
5. 如果新 session 得到 `machineAction=null`，立即停止 mutation，重新判断 session owner/continuity；不得根据 checkpoint prose 自行派发。
6. Executor 结束后，主 Agent必须独立审查 Git、测试、artifact 和 Root Broker proof；wrapper prose、`Background task failed`、YAML 或退出码都不具单独权威。

所有 Goal mutation 前都必须重新 `goal_status`，使用最新 machine action 和 token。

## 3. 当前 Git 与工作树基线

记录本 handoff 时：

```text
HEAD 54f6e00ac18727951c9c0056fcbfe5057d4e58da
branch main...origin/main [ahead 91]
```

当前主工作树包含其他并发工作留下的修改，接手者不得回退、暂存或混入 Goal Engine提交：

```text
 M README.md
 M init-pi.sh
 M pi/settings.json
 M scripts/doctor.mjs
 M scripts/lib/subagent-dispatch/extension.ts
 M scripts/probes/pi-subagents-compat.mjs
 M test/custom-footer-input.integration.test.mjs
 M test/doctor.test.mjs
 M test/init-pi.test.mjs
 M test/pi-runtime.integration.mjs
 M test/pi-subagents-compat.test.mjs
 M test/subagent-runtime-production-shutdown.test.mjs
 M test/subagent-session-viewport.test.mjs
?? .state/worktree-lifecycle/
?? docs/bugs/bug-pi-0841-tui-and-reload-compatibility.md
?? docs/superpowers/plans/2026-08-10-pi-0841-upgrade.md
?? test/helpers/pi-tui.mjs
```

`skill-overrides/aliyun-beijing-server/` 完全本地，禁止读取、修改、暂存、提交或 push。

当前所有 Goal managed workspace 都已释放；不得把 clean、TTL、旧 mtime 或 `/tmp` 路径视为删除历史 worktree、branch、recovery ref 的授权。

## 4. 已完成能力

以下 14 个 Goal task 已 accepted：

```text
contract
wt-inventory
fixture-teardown
evidence-codec
subagent-criteria
goal-criteria
goal-criteria-writer
wt-managed
executor-binding
child-evidence
wt-goal-adapter
wt-bypass
wt-recovery
clean-validation
```

已落地的主要能力：

- 新 Planned task 与 Subagent dispatch 采用 criteria-only；legacy v1/v2/v3 `acceptance.commands` 只读 replay。
- `planned.v1` generation、strict criterion、legacy continuation 与跨 generation fail-closed。
- Goal task、Subagent `runId`、contract hash 与 Root Broker official terminal proof 绑定。
- child-only YAML acceptance evidence、canonical evidence codec 和内容寻址 identity。
- managed worktree durable owner、allocation intent、CAS、cleanup debt、preserve/release/recovery。
- process-aware clean validation、独立 validation workspace 和 fixture 零增长门禁。
- Agent raw mutating `git worktree` 绕过已禁止。
- bootstrap Goal 内 `goal_accept` 保持 task-level，Root Goal ABI 保持 exact-seven。

冻结设计：

```text
docs/superpowers/specs/2026-08-08-planned-control-plane-foundation-design.md
```

## 5. 当前任务：`dual-settle` Attempt 21

### 5.1 本 attempt 唯一目标

Attempt 21 **只完成 Phase B2 tests-only 最终精修**。禁止实现 B3，禁止修改 production。唯一允许的新提交路径：

```text
test/goal-engine-events.test.mjs
```

目标提交信息：

```text
test(goal): 修正 settlement CAS B2 精确操作捕获
```

完成后应返回 `NEEDS_CONTEXT` 与 full commit hash，让主 Agent先冻结并独立复核 tests-only predecessor，再决定下一阶段 amendment。不得把这个中间 RED 误报为整个 `dual-settle` succeeded。

### 5.2 固定 base 与 replay 链

Attempt 21 base：

```text
ab2e7d3aea2a3e8eddfc288910aeb61099656e7f
```

必须按顺序 exact replay 以下 25 个无 merge prerequisite：

```text
0576e688a34e344c1d4c148181298eb58d70255b
4587cd813fb7d7c4de6a4a42f23739af55cb07ed
40f7625aabbb71bb647bad1f02f4d26164fff26a
5c38eca3bd4781f7ed6da8435f9c35d558943b89
6f0dd1d1e34ac63d14c1e8bdc6eab46bc81ea505
4de652c327837b00fd6a7c993ec4f1dab5f033de
51c28e52e612d62a5f176105621ccfeee5515c32
cbb92737d9be0992aefaa21c63171fa19f04cdf2
f5a7462c9c189a129ad9e9b7a682209e50e5d9a7
ef916d6c469fb91745993e6ef2366e49ad8f0460
27e2aed78b680c8ac8e4e5aa2fcc2ce73134b5f3
10a0826933782142f9f40a43ffe9efdc54de913b
999fde6ed9dc85ee3dd12adf4bad471512311426
8201714df0f0fb3ca194a21e6d0b182d2bbe77ea
baec62b396502b584e833f6da6ff296495579f60
f6c2e563e03b53e5b27a54bd8c5a0022afb5ab4e
a22462c8753e49b763407d960dacddbf6d7bde4f
14a0c6fa927be082f6c80deea8365a4fdae5de50
a77ad8021752e705aacbc5275e4051530e635eb6
752dae327629b0d16a8bc555aca575269f4a86f3
e1797f99e1ebef6646b5f7259fb8a9a7ef0e5657
13a9343639a2f2bf998256bbd3dc0c724f267160
24f54b0830b8776100af98426e6072ffe8ad7bfc
57d2020e3672a801c37933c7377afb93bb0c081c
e386f53c817ff203b80d7929217014bb5902b6a0
```

以下提交不得出现在 ancestry：

```text
0ce58251461996da733d71b50481cb8248fb95f2
2375d2b5e358d870c3d494ecf2b3a50c1ce191a9
a812fff0b988c37b89cfd4e0c29f87be0615d5e2
a04810cbf488ef59adef773894f40bfbeb11f135
58c65648143cf4a3c8817c4bedec650fbaa74691
```

replay 后基线必须精确为：

```text
123 total
112 pass
11 fail
```

必须保留五个 B2 top-level tests及总数。

### 5.3 B2 只修四点

1. **按边界捕获 evidence temp**
   - `check`、`existing-read` 明确断言 temp 为 `null`。
   - 仅 `temp-write`、`target-link`、`directory-fsync` 要求唯一非 null `{path, fd}`。
   - 只捕获 append 窗口内 exact evidence temp 的 exclusive create；flags、mode、path 都必须匹配。
   - 使用 create-record 数组机械证明恰好一次。
   - 同 path 非创建 reopen 或无关 writer 文件不得造成 ambiguity，也不得覆盖已捕获 fd。

2. **精确捕获 target link**
   - 仅当 `destination === canonical target` 时记录 exact source/destination。
   - 必须恰好一次；无关 writer recovery guard link 不得覆盖。
   - `source === captured temp.path`，否则父断言失败。

3. **fault marker 必须先发生**
   - fault child 在 exact boundary、attacker rename 前抛出首个 `FIXTURE_HOOK_FAILURE:<boundary>`。
   - capture/guard 不得提前产生其他错误。
   - fault 必须：非零退出、`signal === null`、stdout 为空、stderr 含 exact marker。

4. **保持既有真实夹具边界**
   - fault/normal 使用独立 state root。
   - 保持真实 phase/`inAppend`，append `finally` 先 disarm。
   - normal 输出 exact-one JSON。
   - 保留 replacement identity、`0600`、`nlink`、bytes 和 target assertions。
   - 所有夹具断言后，先以 `result.error` receipt/identity/replacement/unsafe 匹配作为唯一 production RED；紧随其后的 authority 全零断言供 GREEN 后执行。
   - 禁止伪造 production error，也不得为了过测试清理 authority。

最终必须仍为：

```text
123 total
112 pass
11 fail
```

五个 B2 test 都必须到达 `result.error` oracle。日志路径：

```text
/tmp/planned-goal-dual-settle-21-b2.log
```

### 5.4 主 Agent对 Attempt 21 的最低复核

Executor 完成后，主 Agent至少独立验证：

- 新 authored commit 只改 `test/goal-engine-events.test.mjs`。
- production diff 为空。
- 25 个 prerequisite 顺序与 ancestry精确。
- 五个 forbidden commit 均不在 ancestry。
- `git diff --check` 通过。
- 测试精确 `123/112/11`，五个 B2 都到达真实 production RED。
- `check`/`existing-read` 没有伪造 temp；其余边界各唯一 exact temp。
- target-link 不会被无关 recovery link 覆盖。
- fault marker 先于 attacker rename和其他夹具错误。
- index、worktree、untracked 对当前 isolated workspace 均 clean。

不要因为 subagent 报告、YAML、commit 存在或 wrapper completion 就跳过这些检查。

## 6. `dual-settle` 后续阶段

Attempt 21 只冻结 B2。后续仍需通过同一 task 的 clean retries 完成：

### 6.1 Phase B3：publish-then-append orphan/retry RED

补齐 artifact 已成功发布但 event batch 尚未 append 时的 crash/orphan/retry 行为，证明：

- 孤立 artifact 不产生 settlement authority。
- retry 可以识别相同内容寻址 artifact。
- event append 失败不留下部分成功 projection。
- 正常与 fault state root 独立，测试不继承真实 production state。

### 6.2 Phase B GREEN：store-only publication

GREEN 阶段只允许修改：

```text
scripts/lib/goal-engine/store.mjs
```

冻结 API：

```text
appendEventBatchWithSettlementEvidence(
  stateRoot,
  events,
  expectedVersion,
  { sha256, content }
)
```

固定锁内顺序：

```text
replay/version/apply/registry preflight
-> no-replace CAS publication
-> append event batch
```

必须贯穿 canonical state root、parent、temp、target 的 `dev + ino + type + mode` receipt fence；canonical YAML 必须且只能以一个 LF 结束，大小上限：

```text
MAX_SETTLEMENT_EVIDENCE_BYTES = 1_048_576
```

### 6.3 双路径 settlement 接线

`goal_settle` 新增参数已冻结：

```text
subagent_evidence: {
  sha256: string,
  content: SettlementEvidence
}
main_verification: SettlementEvidence
```

`SettlementEvidence` 精确为：

```text
{
  identity,
  criteria,
  commandsRun,
  changedFiles
}
```

仅 `planned.v1` 且 `outcome="succeeded"` 强制双路径。必须校验 task/run/attempt/contract/HEAD/terminal proof、criteria coverage、scope 和 outcome 一致性。

child artifact：

```text
<executorWorkspace>/.pi-subagents/acceptance-evidence/<sha256>.yaml
```

combined artifact：

```text
<canonical stateRoot>/acceptance-evidence/sha256/<combinedHash>.yaml
```

完成后还要把 combined hash、两条 evidence identity 与 settlement event 接入 decoder、reducer、replay 和 extension。`goal_accept` task-level语义与 exact-seven ABI 在本 Goal 内不得改变。

### 6.4 Recovery 去重

`dual-settle` 仍包含 recovery 累积缺陷：checkpoint 继续 durable 持久化，但不得累计历史 `deliverAs: "nextTurn"`；`before_agent_start` 只注入最新一条。checkpoint 永远不具 mutation authority。

## 7. Attempt 历史与可用证据

关键冻结提交：

```text
Phase A     752dae327629b0d16a8bc555aca575269f4a86f3
B1          13a9343639a2f2bf998256bbd3dc0c724f267160
Attempt 17  24f54b0830b8776100af98426e6072ffe8ad7bfc
Attempt 19  57d2020e3672a801c37933c7377afb93bb0c081c
Attempt 20  e386f53c817ff203b80d7929217014bb5902b6a0
```

Attempt 20 主审结果：123 total / 112 pass / 11 fail，但发现 evidence temp capture、无-temp 边界、target-link capture 和 fault marker 顺序缺陷，因此已 blocked、discard、release。审查日志：

```text
/tmp/planned-goal-dual-settle-20-main-review.log
```

Attempt 18 的未提交补丁仅作为历史证据：

```text
/tmp/planned-goal-dual-settle-18-uncommitted.patch
sha256 5fd991db518a9e7baa572c0cdc28fbb909681993cac3b51ab465d5301bb77c3
```

不得把历史 commit/prose 当作新 attempt 的验收证据；新 attempt 仍需主 Agent在其 exact HEAD 上独立复核。

## 8. 后续任务：`migration-docs`

`dual-settle` accepted 后才能开始。该任务不仅是文档，而是严格 TDD 的 session owner 隔离和迁移闭环。

必须实现：

- 新 Planned Goal 在初始化时以首条原子 `goal.session_bound` 绑定 immutable `ownerSessionId`。
- owner 只能来自可信 `ctx.sessionManager`，不得由 tool caller 自报。
- 同一 canonical cwd 允许不同 owner session 各自拥有 active Goal；同一 session 仍最多一个 active Goal。
- 隐式 status、mutation、continuity、recovery、compaction 和 action offer 只选择当前 session 所属 Goal。
- 其他 session 即使知道 goalId/token，也不得读取恢复内容、取得 offer、修改状态或分配 workspace。
- 拒绝路径必须发生在追加事件、challenge 或 workspace 分配前，且事件/projection/registry/worktree逐字节不变。
- 同 session reload/compaction 保持归属。
- v1/v2/v3 与 pre-owner Planned 日志继续只读 replay；不得静默迁移或错误归属。
- 更新 Skill、Doctor、迁移测试和中文设计/总结文档。
- 用两个 mock/真实 Pi session 在同 cwd 证明双 active Goal 互不可见、各自可恢复。

当前 detach 修复只是临时 authority revocation，不等于完整 immutable owner 隔离。

## 9. 后续任务：`final-verification`

`migration-docs` accepted 后执行：

- 运行完整 `npm test`。
- 验证 Goal Engine、Subagent、Root Broker、worktree lifecycle、Doctor 和 migration。
- 在独立临时 repo/state/Pi 进程验证 criteria-only、terminal proof、managed release 和双路径 settle，不写 bootstrap Goal state。
- 同一 cwd 启动两个 Pi session，验证 owner 隔离、reload、compaction 和 recovery。
- 最多两轮外部只读复审；只修有证据的 Critical/Important。
- 输出候选 Pi canary 入口和最终中文验证总结。

外部 reviewer 缺少 provider credential 时必须 fail closed，不得伪造通过结论。

## 10. 当前 session detach 修复

为安全解除损坏 session 与 `planned-goal` 的关联，主分支已包含两轮严格 TDD：

```text
e65a634414cc1e4f776abbac1479f8ab8e18adfb docs(goal): 记录 detach 无法抢占动作凭据
cfb9edadb3c328c5d5fa174130c2babc48065357 test(goal): 复现 detach 无法抢占动作凭据
5f0ecac87568476d424230387abc1b7e7fbc26d5 fix(goal): 允许当前会话安全抢占并解除绑定
959611b5de86b45f5c540ecc72d250877641100b docs(goal): 记录 detached 会话重获动作凭据
3ebdf84e8031a5666668c620cfac3bf4a23849e4 test(goal): 复现 detached 会话重获动作凭据
54f6e00ac18727951c9c0056fcbfe5057d4e58da fix(goal): 阻止 detached 会话重获动作凭据
```

当前行为：

- 仅当前可信、仍 watching 的 session 可用 fresh offer 抢占执行 `detach_session`。
- detach 不得指定其他 `session_id`。
- detached session 的显式/隐式 `goal_status` 只读返回 projection，且 `machineAction=null`、`action_token=null`。
- detached session 不创建新 metadata/orphan challenge 或 offer。
- 当前 session 不再收到该 Goal 的 recovery、compaction 或未 settle reminder。
- 另一未 detached 的可信 session 仍可接管 active Goal。

主 Agent独立验证过 detach 相关 targeted tests 131/131 GREEN；更早组合回归 138/138 GREEN。

## 11. 硬性安全约束

### 11.1 Goal authority

- 每次 mutation 前先调用 `goal_status`。
- 只使用 fresh machine action 与一次性 token。
- recovery note/checkpoint 不具 authority。
- 不直接编辑或删除 `.state/goal-engine/**`。
- 当前没有安全 typed Goal 物理删除接口；detach 只撤销当前 session authority并保留审计数据。

### 11.2 TDD 与提交

- 逻辑变更必须先加载 `test-driven-development` Skill。
- bug-first顺序固定为：中文六要素 bug 文档提交 → tests-only RED提交 → 最小 GREEN提交。
- `workflow.mode="tdd"` 不得携带 `workflow.reason`。
- commit message 使用 `type(scope): 中文祈使句`，不得含 AI 签名。
- 只允许 exact staging；不得 broad staging。

### 11.3 Git 与 worktree

禁止：

```text
git reset
git restore
git clean
git stash
git rebase
git commit --amend
force push
git -C
GIT_DIR/GIT_WORK_TREE
git worktree add/remove/prune/move/repair/lock/unlock
```

只读探针使用：

```text
GIT_OPTIONAL_LOCKS=0
```

worktree mutation 只能走 typed Goal disposition 或 managed lifecycle CLI，禁止 `--force` removal和 raw branch cleanup。

### 11.4 Evidence 与 broker

- Root Broker 只拥有 process ownership 与 official terminal proof，不得拥有 Git worktree/branch 删除能力。
- Subagent prose、YAML、commit、退出码或 wrapper 状态不能替代主 Agent独立复核。
- `evidence_source="external"` 只接受 `external_review`；普通测试输出使用 `self_produced`。
- `lsof` inventory unavailable 必须 fail closed，不得绕过 process fence。

## 12. 已知阻塞与环境风险

- Runtime orphan/release测试可能因 `lsof` inventory unavailable fail closed：`managed worktree process inventory is unavailable`。
- `test/subagent-dispatch-extension.test.ts` 已知主分支基线曾为 1 pass / 8 fail；首错是 `Expected values to be strictly equal: true !== false`。不得把无关基线失败归因于当前 task，也不得伪造绿色。
- legacy bootstrap amendment ABI 仍可能要求 `acceptance.commands`，直接新增 criteria-only task会被拒绝。
- bootstrap `goal_dispatch` 返回的 legacy contract 可能携带 `acceptance.commands`；不得手工把它改造成 strict subagent contract。应使用 typed Goal dispatch路径。
- isolated worktree 可能缺 installed `pi-subagents`、`typebox` 或有效 `PI_REAL_BIN`；缺失时记录真实环境阻塞，不得改 production绕过。
- 外部 reviewer provider credential 可能不可用，必须 fail closed。
- 当前分支尚未 push；历史 worktree/branch/recovery ref 未获删除授权。

## 13. 基础控制面完成后的独立路线图

本 Goal 明确不实现以下能力；应作为后续独立 Goal：

1. `goal_finalize`：新增第八个 typed tool；`goal_accept` 继续只接受 task。
2. idle continuation：安全空闲续派，不制造重复 recovery 或越权动作。
3. Convergent Goal：开放式发现、再规划、收敛和终止策略。
4. 多仓 Goal：多仓 registry、`repoForTask()` 和跨仓 workspace/验收。
5. Goal archive/delete：目前无安全 typed 物理删除接口，若需要必须单独设计审计与资源门禁。

当前工作树中已存在的相关计划：

```text
docs/superpowers/plans/2026-08-05-goal-finalization-gate.md
docs/superpowers/plans/2026-08-05-goal-idle-continuation-guard.md
docs/superpowers/plans/2026-08-07-convergent-goal-execution.md
```

多仓 Goal 需求已有历史讨论，但当前工作树没有对应的独立计划文件；接续时不得假设 `2026-08-08-goal-engine-multi-repository.md` 已持久化，应在基础控制面完成后重新确认并正式建档。

## 14. 建议给新 session 的启动提示

可将以下内容直接交给新的 Pi session：

```text
接手 /Users/mhbzhy/pi-config 的 planned-goal epoch 1。
先完整阅读 docs/summaries/2026-08-10-planned-goal-control-plane-handoff.md、
pi/AGENTS.md、using-goal-engine 与 subagent-dispatch Skill。
第一项工具调用必须是 goal_status(goal_id="planned-goal")；只服从 fresh
machineAction/action_token，不使用 checkpoint prose 或旧 token。当前原 session 已 detached，
Attempt 20 已 discarded+released，实际下一步应为 dual-settle Attempt 21。
严格执行 Attempt 21 的 tests-only B2 合同，禁止 B3/production，保护主工作树全部既有 dirty 文件，
不得 raw worktree mutation或直接编辑 .state/goal-engine。Executor 完成后由主 Agent独立复核
ancestry、单文件 authored diff、123/112/11、exact temp/link capture 与 fault marker顺序。
```

## 15. 当前 Definition of Done

只有全部满足以下条件，才能完成本 bootstrap Goal：

- `dual-settle` 双路径 evidence、combined artifact、atomic settlement 与 recovery去重全部通过。
- `migration-docs` 完成 immutable session owner和同 cwd多 active Goal隔离。
- Skill、Doctor、legacy migration与 exact-seven ABI回归通过。
- `final-verification` 的完整测试、真实 Pi Host、双 session canary通过。
- 所有 accepted workspace 已按 owner CAS正确 disposition并释放；preserved/debt有明确审计。
- 无伪造 evidence、无 checkpoint authority、无 raw state/worktree mutation。
- bootstrap Goal仍按旧控制面完成；`goal_finalize`、idle、Convergent与多仓留给后续独立 Goal。
