# Subagent Runtime 缺口修复：总纲与执行顺序

> **给执行 agent：** 本文档是三份实施计划的总纲，不单独执行。逐任务执行请打开对应的计划文档；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 把 2026-09-22 调查得出的 21 项 runtime 缺口与 7 项残留问题（R1–R7）中**当前可确认可信**的部分，拆成三份可独立交付、可独立验收的计划，并规定它们的执行顺序与前置环境条件。

**架构：** 按**写入热点聚类**拆分为三份计划，使每个共享文件的竞争任务都落在同一份计划内，从而消除跨计划资源锁。计划 A 处理派发合同面（`contracts/dispatch-ir.ts` + `subagent-dispatch/extension.ts` + 两处 `SKILL.md`），计划 B 处理 workspace 与 proof 面（`workspace/{ledger,service,tool,git-worktree}.ts` + `test/managed-workspace-contract.test.mjs`），计划 C 处理宿主工具面与测试卫生（`src/bash-cwd/` + 三个测试文件）。原 T14 统一验收终点降级为计划 C 末尾的跨计划集成回归，并按「确定性本地套件 / 环境依赖套件 / 只读现场观察」三组分别出结论。

**技术栈：** Node.js `>=22.19.0`（原生 TypeScript type-stripping）、TypeScript、`node:test`、`pi-subagents@0.62.0`（固定；深层 import 只能经 `src/compat/pi-subagents-0.62.ts`）、package exports `./dispatch-ir` / `./generic-prompt` / `./workspace` / `./workspace/admin`。

## 本文档的由来

本总纲取代 `docs/plans/2026-09-22-subagent-runtime-confirmed-gaps.md`（下称 **v2 单一计划**）的组织方式。v2 经过两轮独立执行前审阅，**两轮均判定 No-Go**：

| 审阅 | 范围 | 结论 | 产出 |
|---|---|---|---|
| 一审 | 全计划首轮 | No-Go | 8 Blocker + 7 High + 5 Medium；同时确认 30+ 处源码行号引用全部相符、5 个孤儿模块真实存在 |
| 二审（窄范围） | v2 修订是否真正消除一审 20 项 + T7/T8 新代码 | No-Go | 3 Blocker + 7 High；11 项正面确认（B1/B3/B4/B5/B6/B7/H3/H5/H6/H7/M1–M4 方向正确） |
| 二审（全范围） | 15 个任务逐个深审 + 跨任务一致性 + 独立重做 `writing-plans` 四项自检 | No-Go | 5 Blocker + 8 High + 5 Medium；建议拆分为多份计划 |

**v2 的「计划自检」章节两次声称通过而两次被外部审阅推翻**，这与本次调查的核心发现同构（声明与产物之间缺少可执行的门）。因此 v3 **删除自评章节**，改为每份计划末尾附**可机械执行的自检命令块**（见 §6）。

v2 文档保留，作为计划 B 与计划 C 的任务细节来源；其头部已标注被本总纲部分取代。

---

## 1. 四项用户裁决（不得在执行中重新论证）

### 裁决 ①：拆分为 3 份计划，按写入热点聚类

| 计划 | 文档 | 任务 | 独立验收目标 |
|---|---|---|---|
| **A 派发合同与门禁** | `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md` | T-ENV、T0、T1、T2、T3、T4、T5、T13、A-ACC | 派发拒绝率下降；`workflow` 完全移除；孤儿模块机械门禁上线；path 文法可行动 |
| **B workspace 与 proof 诊断** | `docs/plans/2026-09-23-plan-b-workspace-and-proof-diagnostics.md`（待编写） | T6、T7、T8、B-ACC | Git 失败原因分类透传；无 workspace 的 run 不再产生 debt；状态词表单一权威 |
| **C 宿主工具面与测试卫生** | `docs/plans/2026-09-23-plan-c-host-toolsurface-and-test-hygiene.md`（待编写） | T9、T10、T11、T12、C-ACC | `bash cwd` 限制放开；三项 HEAD 既有测试缺陷处置；跨计划集成回归 |

**拆分依据（写入热点必须同计划）：**

| 热点 | 竞争任务 | 落在 |
|---|---|---|
| `src/contracts/dispatch-ir.ts` | T1、T2、T3 | A |
| `src/subagent-dispatch/extension.ts` | T2、T5 | A |
| `skill-overrides/subagent-dispatch/SKILL.md` | T2、T3 | A |
| `test/managed-workspace-contract.test.mjs` | T6、T8 | B |
| 全量 `npm test` 独占 | T12、C-ACC | C |

由此**不存在任何跨计划资源锁**。三份计划之间的唯一顺序约束来自 §2 的执行顺序，不来自文件竞争。

不采纳的两种替代拆分：
- **窄范围 reviewer 的 3 份方案**（A `T0-T5+T13` / B `T6-T9` / C `T10-T12+T14`）：把 T9（`src/bash-cwd/`，仓库根，与 workspace 无关）塞进 workspace 计划，聚类不纯。
- **全范围 reviewer 的 5 份方案**：把 T7 与 T6/T8 拆开，而 T7 的 `ManagedWorkspaceError.detail` 透传约定与 T8 的 `detail` 字段是同一套设计，分属两份计划反而要新增跨计划契约。

### 裁决 ②：`workflow` 删除后的 contractHash 策略——不做兼容层，加两道钉

用户已裁决「我们的场景里面不存在多版本兼容的需求」，因此**不写迁移机制**。经主 agent 独立验证，精确风险比审阅报告描述的窄：

```
hashCanonical(canonical) → ir.hash → contractHash
  进入 managed-workspace.v2 请求   workspace/contract.ts:4（REQUEST_V2_KEYS 含 contractHash）、:154 校验 SHA-256
  持久化                          现场 5 个 records/*.json + queue item 均含 contractHash/requestHash
  参与幂等                        ledger.ts:356/452  hashValue(request) !== value.requestHash 即拒
                                  integration-queue.ts:222  requestHash 不同 → "requestId idempotency conflict"
  参与绑定                        extension.ts:757  workspaceRequest.contractHash !== selectedIr.hash → 拒
  参与结算身份                     settlement-evidence.ts:8  IDENTITY_KEYS 含 contractHash
  印进 child prompt               prompt 渲染 "Contract SHA-256: <ir.hash>"
```

**既有 record 的 `requestHash` 是对已存储的 request 对象重算的，而该对象里存的 `contractHash` 字符串不变 → 自洽、仍可加载。** 真正会断的只有「跨变更点的比较」：

| 受影响路径 | 实际风险 | 判定 |
|---|---|---|
| `extension.ts:757` goal-task 绑定 | Goal Engine 已由 commit `9b9cbb8` 从主线移除 | 大概率空影响，但必须有测试证明不抛错 |
| settlement evidence 复核 | 结算发生在单次派发生命周期内，不跨代码变更 | 低风险 |
| queue `requestId` 幂等 | `requestId` 每次派发随机生成，跨代码变更复用概率近乎零 | 可忽略 |

**两道钉（计划 A 的 T2 必须实现）：**
1. 一条测试：构造 `contractHash` 按旧（含 `workflow`）schema 算出的 fixture record，断言变更后仍能加载、`requestHash` 仍校验通过、不抛错。
2. 变更前对 live 现场做只读快照（§2 步骤 2 已完成即满足），确保任何加载路径意外抛错时案发现场不丢。

**登记的残余风险：** 不支持跨变更点的 `contractHash` 比较；任何横跨该变更的在途工作流必须重新派发。

### 裁决 ③：**不**新增 TDD 机械门禁（主 agent 反对审阅建议，用户已采纳）

全范围 reviewer 建议「非空 `writePaths` ⇒ `requirements` 必须包含 TDD skill 路径」，理由是删除 `workflow` 会让约束力从结构化字段降为自然语言。

**该前提不成立。** 已验证 `workflow.mode` 在整个 runtime 中**零行为语义**：按 mode 分支的代码全仓只有 `extension.ts` schema 的 enum 声明一处，`child-extensions/*.ts` 与 `src/workspace/*.ts` 完全不读 workflow；它唯一的去处是往 child prompt 渲染一行 `- Mode: \`x\``。它从来不是 enforcement，只是一个声明。真正的 enforcement 一直是 `requirements` 里的 TDD skill 路径（child 不继承 skills，只能靠 read 该文件）。因此删除 `workflow` **没有削弱任何强制力**。

不采纳该门禁的两条理由：
1. **方向错误**：本次调查的头号问题就是「不可见的校验规则造成拒绝」——跨 312 会话 `INVALID_PATH` 327 次、`INVALID_CONTRACT` 312 次、其中 `workflow.reason is forbidden when mode is tdd` 单项 182 次。在拒绝率已达 19% 的合同上新增字符串匹配规则是在加重病灶。
2. **无效**：字符串匹配可被无意义地满足（写上路径但不读），与当初 `mode:"tdd"` 可被声明但不执行是同一种假保证。

**替代处置：** 把「TDD 是否应被机械强制、以及应在哪一层强制」纳入 T13 的探索范围（T13 本就是合同可发现性探索）。有效的检查点不在派发合同，而在 child 的**产出侧**——Required Report 已要求 `RED/GREEN or exemption evidence`，或事后核查 child 是否真的 read 了该 skill 文件。

**登记的残余风险：** 删除 `workflow` 后，TDD 纪律完全依赖 profile system prompt 与 `requirements` 自然语言指令，无结构化信号可供门禁消费。

### 裁决 ④：先落证据、再快照、再重启宿主，然后按 A → B → C 执行

**必须先重启的理由不只是修好 `contact_supervisor`。** 已实测：本 host 上 `steer` 的两种形式（带 `index: 0` 与不带）均返回 `SUPERVISOR_INTENT_INVALID`。根因推断——`extension.ts` 构造 steer intent 时填 `ownerGeneration: owner?.ownerGeneration`，而 `owner` 来自 `broker.readOwnerReceipt`，其背后的 `AuthorityStore` 是 lifecycle 批次新加到 `subagent-runtime.ts` 的；本会话 09-21 19:58 加载 runtime，该文件 09-21 20:55 才被改，故本 host 内没有 AuthorityStore，intent 缺必填字段 → `parseSupervisorControlIntentV1` 抛错。

**计划 A/B/C 中 T5、T7、T8、T10、T11 的停止条件全部依赖 `contact_supervisor`。** 在旧 host 上执行等于所有升级路径都是死的，subagent 遇到阻塞只能硬撑——这正是本次调查中 C 组、E 组在错误前提下「尽力完成」的成因。

**重启的内容风险为零：** 5 个遗留 worktree 的**独有提交均为 0**（内容已全部通过用户后续手工提交落入 main，main 已从 `e07cd25` 前进到 `839bf75`）；queue item 的 `authorizedWorkspaceHead=a7526c4` 已落后 main 24 个提交，永久不可 integrate。唯一有价值的是 ledger/queue 的**状态证据**，由快照保住。

**附带收益：** 重启会首次真实验证 lifecycle 批次声称已交付但从未在真实环境跑过的部分——`recovery-resume-orchestrator.ts`（`recoverOrphanRun` 至今零生产调用方）、`AuthorityStore`、coordinator 交接。已确证 coordinator 进程存活并持有 socket（`coordinator.json` 声明 `pid: 85087`，`lsof` 显示其 fd 20/22 指向 `/tmp/pi-workspace-coordinator-501/57e63c….sock`），但 queue item 自 09-21 19:55 起 `state=queued`、`admissionGeneration=0`、`revision=3`，从未被 claim。重启后三种结果都是高价值信号：新 coordinator 认领该 item（B3 是旧代码缺陷，已修）／仍不认领（B3 在新基线复现，确认为真缺陷）／交接本身失败（直接暴露 P2-T3/P4-T7 的接线缺口）。

---

## 2. 执行顺序（强制，不得跳步）

### 步骤 1：把调查证据从 `/tmp` 落到 tracked 位置

```bash
mkdir -p docs/investigations/2026-09-22-managed-worktree-merge-queue-practice
cp /tmp/wt-analysis/reports/00-INTEGRATED-runtime-gap-report.md \
   /tmp/wt-analysis/reports/A-session-forensics.md \
   /tmp/wt-analysis/reports/B-dispatch-contract-rootcause.md \
   /tmp/wt-analysis/reports/C-workspace-mergequeue-rootcause.md \
   /tmp/wt-analysis/reports/D-error-prevalence.md \
   /tmp/wt-analysis/reports/D-error-prevalence.csv \
   /tmp/wt-analysis/reports/E-coverage-mapping.md \
   /tmp/wt-analysis/reports/F-rebaseline-delta.md \
   /tmp/wt-analysis/reports/G-residuals-confirmation.md \
   docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/
ls -la docs/investigations/2026-09-22-managed-worktree-merge-queue-practice/
```

理由：`/tmp` 会被系统清理，而本次调查已经发现过「验收证据引用不存在的 commit」（`.pi/handoff/context-handoff.md:223,244` 引用 `d98c4c41`、`5a6f8f8f`，`git cat-file -t` 均报 `Not a valid object name`，且 `.pi/handoff/` 本身 untracked）。证据必须 tracked 才可复核。

**此步骤需要用户授权提交**（按 `git-commit-convention`），否则证据仍处于未提交状态。若用户不授权提交，至少完成复制，并在任务报告中记录「已落盘但未提交」。

### 步骤 2：只读快照 live 现场

```bash
SNAP=var/snapshots/2026-09-23-pre-remediation
mkdir -p "$SNAP"
R=var/workspaces/repositories
for p in 85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0 \
         8c8998242b29f89a730a38ec62996cbf9daa4dbd877bb1da1c04da24ec902d84 \
         6e90f759cfef8bdbb3d8616a6960f0b618ac81350f0f430e5e7a446b73ab0696 \
         8ea781e38d5b870cca67891123ac9b1ce255d2a1610c216a4a19194e24388bc6; do
  mkdir -p "$SNAP/$p"
  cp -R "$R/$p/records" "$R/$p/integration-queue" "$R/$p/terminal-proof-outbox" "$SNAP/$p/" 2>/dev/null
done
cp ~/new-api-account-pool/.git/.pi-coordinator/coordinator.json "$SNAP/" 2>/dev/null
git -C ~/new-api-account-pool worktree list --porcelain > "$SNAP/worktree-list.txt"
find "$SNAP" -type f | wc -l
```

快照是**只读复制**，不修改现场。`var/` 已被 `.gitignore` 的 `/var/` 覆盖，故快照不进入版本控制，但持久于本机。

### 步骤 3：重启宿主

由**用户手动执行**（主 agent 不得终止用户的会话进程）：
- `pid 85087`：`~/new-api-account-pool` 的 root session，启动于 2026-09-20 16:32:58，是 `coordinator.json` 声明的 coordinator owner
- 当前 pi-config 会话：启动于 2026-09-21 19:58:07

### 步骤 4：记录重启结果

重启后立即记录（这是 lifecycle 批次的首次真实环境验收）：
- queue item `0ed45c9b` 的 `state` / `admissionGeneration` 是否变化
- `terminal-proofs.json` 的 `pending` / `receipts` / `debts` 计数是否变化
- 5 个 worktree 目录数与 5 条 record 的 `state` 是否变化
- 是否出现新的错误、debt 或 coordinator 交接失败

三种结果的解读见 §1 裁决 ④。

### 步骤 5：按 A → B → C 执行

- **计划 A** 先执行：它是关键路径（`T-ENV → T0 → T1 → T2 → {T3, T13}`），且消除的拒绝量最大（`INVALID_CONTRACT` 312 + `INVALID_PATH` 327 + `workflow.reason` 182 次/41 会话/10 项目）。
- **计划 B** 次之：依赖 A 完成后的稳定基线（B 的 T7 会新增 `src/subagent-dispatch/terminal-proof-binding.ts`，与 A 的 T1 孤儿删除同属 `src/subagent-dispatch/` 目录，A 的 T0 守卫必须先上线，否则 B 新增文件可能被误判）。
- **计划 C** 最后：C-ACC 承担跨计划集成回归，必须在 A、B 完成后执行。C 的 T9–T12 本身与 A、B 无文件竞争，若资源允许可与 A 并行开工，但 C-ACC 必须等 A、B。

---

## 3. 缺陷登记与归属（32 条）

两轮审阅共提出 8 Blocker + 17 High + 7 Medium（去重后）。每条标注修复归属；**无归属即视为未处置**。

### Blocker

| # | 缺陷 | 来源 | 修复位置 |
|---|---|---|---|
| BL-1 | T1 删除 `test/subagent-dispatch-validation-errors.test.mjs:89-93` 既有测试理由不足；迁移 import 即可保留回归保护 | 全范围 | 计划 A · T1 步骤 7 |
| BL-2 | T2 删除 `workflow` 改变 `hashCanonical` 输入 → `contractHash` 变化，计划未建立持久化影响策略 | 全范围 | 总纲 §1 裁决 ② + 计划 A · T2 步骤 8/9 |
| BL-3 | T5 的 `grant` fixture 只有 `{allowedProfiles, cwdRoot, isolation}`，而真实 `HostExecutionGrant` 需六组字段（`rootSessionId`/`allowedProfiles`/`originRoot`/`cwdRoot`/`isolation`/`authorization`），且 `normalizeGrant()` 要求路径真实存在、`authorization.binding.sessionId === rootSessionId`；测试会先在 grant 校验失败，**到不了 state-root 分支** | 全范围 | 计划 A · T5 步骤 2 |
| BL-4 | T7 hunk 门禁要求「批次既有 hunk 行号区间不变」，但 T7 自身在 `:159-164` 插入代码必然平移其后所有 hunk → 合法改动被误判 | 两轮独立确认 | 计划 B · T7 步骤 1（改为 patch 内容指纹比对） |
| BL-5 | T14 要求全量 `npm test` 两次 `exit=0`，同时承认 compat 用例必 FAIL → 验收条件自相矛盾 | 两轮独立确认 | 计划 C · C-ACC（拆三组分别出结论） |
| BL-6 | T6/T8 任务级 `Resources: none`，而全局表声称 `managed-workspace-contract-test` 锁覆盖二者 → 执行器无法消费该锁 | 窄范围 | 计划 B · T6/T8 的 Resources 字段 |
| BL-7 | T8 `truncateUtf8` 预算用 `"…[truncated]".length`（UTF-16 = 12），实际 marker 为 14 字节 → 输出 514 > 512，**T8 自己的验收断言必然失败** | 窄范围 | 计划 B · T8 步骤 5 |
| BL-8 | T7/T8 的 RED 是 `TypeError: X is not a function`；T8 步骤 3 甚至明文把 TypeError 写成预期 RED，直接违反计划自身铁律 | 窄范围 | 计划 A · T0（确立例外规则）+ 计划 B · T7/T8 步骤 3 |

### High

| # | 缺陷 | 来源 | 修复位置 |
|---|---|---|---|
| HI-1 | T2/T3 测试代码仍无条件 `readFileSync("/Users/leshi.zhy/.agents/skills/...")`，违反 v2 自己新增的「仓库外文件条件化」规则 | 两轮独立确认 | 计划 A · T2 步骤 2 / T3 步骤 1 |
| HI-2 | T2 步骤 7 的 `delegate.md` 替换文本会删除 `contact_supervisor` 升级路径、`reason:"need_decision"`、「不得委派其他 subagent」、「证据优先于推断」、「未验证的行为不得声明完成」；该文件是 `systemPromptMode: replace`，正文即完整 system prompt | 全范围 | 计划 A · T2 步骤 7（改为只插入 TDD 段，逐段保留原文） |
| HI-3 | T2 步骤 6 把 version heuristic 的 `workflow` 换成 `boundaries`，但未证明 `boundaries` 是 coding-exclusive | 全范围 | 计划 A · T2 步骤 6（先实测 generic 路由，不成立则改用组合特征） |
| HI-4 | T3 的 `"/**"` 分支不可达：`"/**"` 以 `/` 开头会先命中绝对路径分支，而测试断言 `must not be "/**"` 文案 → 实现与测试矛盾 | 全范围 | 计划 A · T3 步骤 3（调整分支顺序并补边界用例） |
| HI-5 | T6 自相矛盾：接口契约说 `allowedActionsFor` 从 `service.ts` 导出，实现步骤写在 `ledger.ts`，测试又从 `ledger.ts` import | 全范围 | 计划 B · T6（统一归属 `ledger.ts`，契约与测试同步） |
| HI-6 | T6 假设 `service.ts` 的 `failure(code, message, detail?)` 支持第三参 detail；实读确认第三参是 `cause` | 全范围 | 计划 B · T6 步骤 5（按实际签名设计） |
| HI-7 | T7 ledger 测试 stub 的记录形状与生产契约不一致（生产 `readLedger()` 已按 `runId` 过滤，stub 返回不带 `run` 的原始记录）→ 可能假绿 | 窄范围 | 计划 B · T7（把 runId 过滤移入被测函数，使过滤本身可测） |
| HI-8 | T7 `buildTerminalProof(workspaceId)` 必填却故意忽略参数，契约表达错误 | 窄范围 | 计划 B · T7 步骤 6（改为无参签名） |
| HI-9 | T7 把可复用逻辑 `classifyTerminalProofBinding` 放在 `extensions/subagent-runtime.ts`，违反 `packages/pi-subagents-enhanced/AGENTS.md`「extensions 只放主 Host 入口，实际实现放 src/」 | 窄范围 | 计划 B · T7（移至 `src/subagent-dispatch/terminal-proof-binding.ts`） |
| HI-10 | T8 `classifyPorcelain` 用 `line.slice(3)` 解析路径，对 rename（`R  old -> new`）、quoted path（八进制转义）、含空格路径不可靠 | 两轮独立确认 | 计划 B · T8 步骤 5/7（改用 `--porcelain -z`） |
| HI-11 | T8 `collectWorktreeDiagnostics` 未定义 `.gitmodules` 从哪个 cwd 读取，且把「读取失败」与「确实无 submodule」混为一谈 | 窄范围 | 计划 B · T8 步骤 7 |
| HI-12 | T8 `category = categories[0]` 的语义未定义（直接阻断原因 / 全部并存状态 / 修复第一步） | 窄范围 | 计划 B · T8 接口契约 + 测试 |
| HI-13 | T9 声称保留 symlink 与相对路径行为，但新测试代码未包含 symlink 用例 → 一审 M3 未真正关闭 | 全范围 | 计划 C · T9 步骤 1 |
| HI-14 | T13 要求「每类附当前实际路由结果」，但只读探索无法靠静态阅读取得 → 需无副作用的离线 probe | 全范围 | 计划 A · T13 步骤 2 |
| HI-15 | T14 把代码验收与环境验收混在一个终点（`npm test` + 真实 Pi lane + live 现场计数 + 外部 SKILL 一致性） | 全范围 | 计划 C · C-ACC（拆三组） |
| HI-16 | 「受保护路径机械门禁」只写在全局约束，**15 个任务步骤中 0 处包含该命令** → 空文 | 两轮独立确认 | 三份计划：每个任务新增「步骤 0：开工前门禁」 |
| HI-17 | TDD 信号从结构化字段降为自然语言，约束力下降 | 全范围 | 总纲 §1 裁决 ③（不加门禁，登记残余风险 + 纳入 T13 探索） |

### Medium

| # | 缺陷 | 来源 | 修复位置 |
|---|---|---|---|
| MD-1 | T0 负向自检要求临时修改 allowlist 再恢复，执行中断会污染工作区 | 全范围 | 计划 A · T0 步骤 5（改用临时副本 + trap） |
| MD-2 | T1 删除 `FIELD_SHAPE_HINTS["$.workflow"]` 后需最终 grep 确认零残留 | 全范围 | 计划 A · T2 步骤 10 |
| MD-3 | T10 的反向断言用了 `existsSync` / `configHome`，这两个标识符在目标测试文件中不存在 | 全范围 | 计划 C · T10 步骤 3（先读实际变量名再给完整替换代码） |
| MD-4 | T12 只点名 `timeoutMs` 的 2 处，实际有 9 处（163/284/336/383/429/1084/1085/1141/1185） | 全范围 | 计划 C · T12 步骤 1（逐点判定） |
| MD-5 | T2/T3 改 SKILL 同一区域，资源锁只防并发不防语义覆盖 | 全范围 | 计划 A · T3 步骤 4（改用完整句子锚点 + 最终全文断言） |
| MD-6 | 「Wave 1 九项可全并行」表述错误：T6/T8 必须串行 | 全范围 | 三份计划的 Waves 章节 |
| MD-7 | T2/T7/T8/T14 步骤过粗，含多个独立动作 | 全范围 | 三份计划：按「2–5 分钟单一动作」重切 |

---

## 4. 不纳入本轮修复的项（含理由）

| 编号 | 理由 |
|---|---|
| B2 schema 根级分支重构 | T13 只探索不实现；根级 union 受 provider 兼容约束（`extension.ts:44-48` 注释：某些严格 OpenAI-compatible provider 遇根级 union 会生成空 arguments），方案需先裁决 |
| B3 queue 从未 claim | 代码事实可信，但验证被阻塞：现场由运行 28 小时前代码的 pid 85087 维护。§2 步骤 3/4 的重启是它的首次真实验证机会；重启结果决定它是「旧代码缺陷已修」还是「新基线真缺陷」 |
| B4 cleanup-debt 无 agent 出口 | 需先裁决 D4（`recover` action 的授权模型与审计形状）；且 `subagent_worktree` action union 变更会与既有文档声称的 `recover/retry/discard/release` 权限矩阵冲突 |
| H2 runtime 自产 artifacts 绊倒回收 | 真因未证实（`3b8d0a57` 的 `!! .pi/subagents/artifacts/*` 是高置信候选）；需先由计划 B 的 T8 取得真实 stderr/porcelain |
| H5 reminder 覆盖不全 | 修复形状依赖 B3/B4 的语义裁决 |
| H6 无 queue inspect agent 面 | 依赖 B3；且需与 `docs/bugs/2026-09-13-auto-integration-inspect-information-leak.md` 的字段裁剪决策对齐 |
| H7 paused run 无 cancel | 抛点在 pinned upstream（`pi-subagents@0.62.0/src/extension/rpc.ts:668-680`）；修复需经 compat 入口或新增 control-plane 能力，而 control-plane 从未在运行时验证过 |
| M1 submodule 全链路无适配 | 需先裁决 D5（递归支持 vs 显式拒绝）；greenfield 工作，涉及 worktree add / admission / rebase / publish 全链路 |
| M3 version heuristic 完整化 | T2 步骤 6 只做等量替换保持检测强度不降；完整化留待 B2 方案裁决 |
| M5 RPC 无操作级 retry | 与 lifecycle 批次新增的 control-plane receipt 幂等机制部分同域（receipt 覆盖 reply/steer，不覆盖 spawn），需先确认 control-plane 运行时行为 |
| M6 隔离覆盖率 5/64 | 属产品决策：是否强制 coding child 使用 worktree、`worktree=false` 是否纳入 queue 与 completion gate |
| M7 长时诊断任务无增量落盘 | 证据全部来自旧基线的 spawn/resume 路径（3 次上游流中断）；`recovery-resume-orchestrator.ts` 是否改善中断恢复需 §2 步骤 3 重启后才能验证。**已在本次调查中临时缓解**（要求 subagent 先落盘骨架、逐节 edit：C 组第一次零落盘全丢、E 组第一次零落盘全丢、E 组第二次因已落骨架只损失当节） |
| R1 control-plane 并发双投递 | 代码级事实已确认，但并发场景未复现（理论窗口）；且 `supervisor-control-plane.ts` 是 lifecycle 批次的 untracked 新文件，编辑会混淆案发现场 |
| R2 steer 幂等检查先于 pending 检查 | 同 R1（同文件同测试面）。**待用户裁决**二选一：① pending 检查前移（P3-T6 合同原文 `lifecycle-overall.md:274` 本就写 pending-first，既有断言改动≈0）② 保持现状但在幂等 receipt 附加 `pendingNotice` |
| R3 `PI_REAL_BIN` 未设置 | 环境决策项。已探明 `/opt/homebrew/bin/pi` 为 0.85.1、`colima` 0.10.3 daemon 运行中。**这是 B3 与整个「真实环境验收长期缺位」的直接前置** |
| R6 `reviewer.md` 用户预存编辑致测试失败 | 用户决策项，不得替用户回滚。已确证 `git diff` 显示新增 `codex-pool/gpt-6-astra` 为首选 model + 指令文案修改；HEAD 干净导出上该测试 2/2 通过 |

---

## 5. 体制性缺口（超出三份计划范围，需单独立项）

三项独立证据指向同一根因——**验收只检查文档层自洽，从不检查与真实产物的一致性**：

1. `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md` 的 **Task 9 步骤 8（真实五 Subagent 验收：2 roots / 5 children / 冲突 / CAS fast-forward / queue+worktree+process 结算）从未勾选**，而 Task 10/11 的合同级验收已勾选为通过；live 现场 queue 完成率 0/1、proof settle 0/5。合同级测试跑在「独立 temporary repo、session、state 和 socket roots」上（package README 明载），天然不含 submodule、真实 dirty origin、64 个并发 child 与上游断流。
2. `.pi/handoff/context-handoff.md:223,244` 引用的验收 commit `d98c4c41`、`5a6f8f8f` **在仓库中不存在**，且 `.pi/handoff/` 本身 untracked；`docs/plans/2026-09-20-subagent-lifecycle-overall.md` 的实现步骤复选框 **0/51**（9 个已勾项全部是执行前计划自检），而残留文档声称「P0–P6 已全部完成并验收」。
3. lifecycle 批次 9 个新模块中 **3 个零生产 importer**（`lifecycle-policy.ts`、`lifecycle-identity.ts`、`supervisor-replay.ts`），`recoverOrphanRun` 导出无生产调用方；而 `supervisor-replay.ts` 正是 P3-T5「completion replay 与 user-visible exactly-once」的交付物。
4. **本计划自身两次复现同一模式**：v1 的「计划自检」声称结构无缺陷 → 一审找出 8 Blocker；v2 的「修订记录」声称 20 项全部处置 → 二审判定 3 Blocker + 7 High，其中 7 项只是「部分消除」、1 项「处置方式有误」。
5. 同类模式的第五次独立实例：`skill-overrides/subagent-dispatch/SKILL.md:122` 教「目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）」，而 `contracts/dispatch-ir.ts:134-136` 的 `base.endsWith("/")` 明确拒绝尾随 `/`。

计划 A 的 T0 孤儿守卫只覆盖第 3 类的**文件级**形态。完整门禁还需：验收证据必须 tracked、引用的 commit 必须存在、计划复选框必须回写、声称的能力必须有穿过 production 入口的测试、**计划修订记录必须给出正文的任务号+步骤号定位**。这五条需要独立计划，且依赖 R3（真实环境 lane 可用）才能真正生效。

---

## 6. 机械自检（取代 v2 的自评章节）

v2 的「计划自检」是主 agent 自评，两次被外部审阅推翻。v3 改为**可执行命令**：每份计划的验收任务必须运行下列检查并粘贴实际输出，不得以「已自检」代替。

```bash
# 用法：PLAN=docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md
PLAN="${1:?用法: check-plan.sh <计划路径>}"

echo "── 1. 任务数与步骤数 ──"
grep -c '^### Task' "$PLAN"; grep -c '^- \[ \] \*\*步骤' "$PLAN"

echo "── 2. 每个任务都有 Deps/WritePaths/Resources/Files/接口契约/验收标准 ──"
python3 - "$PLAN" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
req=['**Deps：**','**WritePaths：**','**Resources：**','**Files：**','**接口契约：**','**验收标准：**']
bad=[]
for tk in [x for x in re.split(r'\n(?=### Task )',t) if x.startswith('### Task')]:
    name=tk.split('\n')[0][4:40]
    miss=[r for r in req if r not in tk]
    steps=len(re.findall(r'^- \[ \] \*\*步骤',tk,re.M))
    if miss or steps==0: bad.append((name,miss,steps))
print("结构缺陷:", bad if bad else "无")
PY

echo "── 3. 任务级 Resources 与全局 Resources 表一致 ──"
python3 - "$PLAN" <<'PY'
import re,sys,collections
t=open(sys.argv[1]).read()
# 全局表中每个锁 → 声明的任务集合
table=dict(re.findall(r'^\| `([a-z0-9-]+)`（[^|]*\|\s*([^|]+)\|',t,re.M))
declared=collections.defaultdict(set)
for lock,tasks in table.items():
    for tk in re.findall(r'T[-\w]+',tasks): declared[lock].add(tk)
# 每个任务自己声明的 Resources
actual=collections.defaultdict(set)
for tk in [x for x in re.split(r'\n(?=### Task )',t) if x.startswith('### Task')]:
    tid=re.match(r'### Task ([\w-]+)',tk).group(1)
    tid='T'+tid if not tid.startswith('T') else tid
    r=re.search(r'\*\*Resources：\*\*(.*)',tk)
    if r and 'none' not in r.group(1):
        for lock in re.findall(r'`([a-z0-9-]+)`',r.group(1)): actual[lock].add(tid)
for lock in sorted(set(declared)|set(actual)):
    d,a=declared.get(lock,set()),actual.get(lock,set())
    print(f"  {lock}: 全局表={sorted(d)} 任务声明={sorted(a)} {'OK' if d==a else '<<< 不一致'}")
PY

echo "── 4. 占位词扫描 ──"
grep -nE 'TBD|TODO|以后实现|类似 Task|待补充|填充细节' "$PLAN" || echo "  无占位词"

echo "── 5. 条件式表述清单（需逐条人工判定是合法运行时分支还是变相占位）──"
grep -nE '以.*实际.*为准|若存在则|附近若有|按需|视情况' "$PLAN" || echo "  无条件式表述"

echo "── 6. WritePaths 重叠是否都有对应资源锁 ──"
python3 - "$PLAN" <<'PY'
import re,sys,collections
t=open(sys.argv[1]).read()
owners=collections.defaultdict(list)
for tk in [x for x in re.split(r'\n(?=### Task )',t) if x.startswith('### Task')]:
    tid=re.match(r'### Task ([\w-]+)',tk).group(1)
    seg=tk[:tk.find('**Resources')] if '**Resources' in tk else tk[:1500]
    wp=re.search(r'\*\*WritePaths：\*\*(.*?)(\n\n|\*\*Resources)',seg,re.S)
    if wp:
        for p in re.findall(r'^- `([^`]+)`',wp.group(1),re.M): owners[p].append('T'+tid if not tid.startswith('T') else tid)
for p,o in sorted(owners.items()):
    if len(o)>1: print(f"  共享: {p} ← {o}")
PY
```

判定规则：第 3 项出现 `<<< 不一致` 或第 6 项列出的共享文件没有对应资源锁，即为 **No-Go**，不得开工。第 5 项的每条命中必须人工判定并在验收记录中写明结论。

---

## 7. 全局约束（三份计划共同遵守）

- **工作区是案发现场，不得清理。** 当前工作树含 lifecycle 批次未提交产物（26 tracked / 947 insertions + 34 untracked），用户明确要求保留。禁止 `git stash`、`git reset`、`git clean`、`git checkout -- <path>`。提交仅在用户明确授权时按 `git-commit-convention` 执行。
- **触碰 lifecycle 批次已改文件时，diff 的内容指纹必须保持**（不得用绝对行号判定，见 BL-4）。受影响文件与其实测 hunk：
  ```
  extensions/subagent-runtime.ts                   : 21, 28, 327-345, 376-381, 451
  src/subagent-dispatch/root-broker-server.ts      : 11-12, 114-117, 198-199, 224-228, 257-260, 280-284,
                                                     304-306, 414-428, 443-509, 657, 687-699, 708,
                                                     1201, 1233-1245, 1364-1365, 1380-1381
  src/subagent-dispatch/extension.ts               : 16, 129-131, 1017-1025, 1033-1054, 1058-1086,
                                                     1237, 1274, 1369, 1403-1404, 1413, 1417-1419, 1501
  ```
- **验收一律使用临时 fixture，禁止依赖 live 现场。** `var/workspaces/repositories/85369acc…/` 的证据价值由 §2 步骤 2 的快照承担；任何任务不得读写该目录。
- **严格 TDD。** 先观察精确 RED 再最小 GREEN。**新增导出的例外规则**（针对 BL-8）：当 RED 的唯一缺口是「被测函数尚不存在」时，必须在测试首行加 `assert.equal(typeof X, "function", "X 必须已导出")` 前置断言，使 RED 表现为**该断言失败**而非 `TypeError`；且同一测试文件内不得有任何其他 import 级失败。除此之外不接受 `TypeError` / `module not found` / typecheck 失败作为 RED。
- **按仓库「缺陷数据来源分类门禁」归因。** unknown 一律 fail closed，禁止预防性兼容。
- **不得为 production/CLI 新增 `.mjs`**；仅 `test/**/*.mjs` 保留。
- **文档、注释、说明性文字用中文**；错误 `code`、标识符、命令、路径保持原样。错误 message 面向模型消费，采用英文主体 + 精确 keypath + 可复制的修复模板。
- **`pi/settings.json` 的 `enabledModels` 与 `pi/models.json` 不得提交**；三份计划均不修改这两个文件。
- **不读取、不输出任何凭据。**
- **每个任务只能修改自身 `WritePaths`**，不得借用、扩展或合并其他任务的 WritePaths。
- **深层 import 边界**：`pi-subagents/src/*` 的深层 import 必须集中在 `src/compat/pi-subagents-0.62.ts`。
- **workspace 所有权边界**：禁止在 `src/workspace/` 之外执行 subagent/Goal 的 `git worktree` mutation。
- **行号与符号定位规则**：计划引用的 `文件:行号` 只是 2026-09-23 工作树快照的定位辅助。**一律按符号或代码片段定位**；行号仅供首次跳转；内容与描述不符时以符号搜索结果为准并记录实际行号；禁止因行号对不上而跳过改动点。
- **受保护路径机械门禁**：`pi/agents/reviewer.md`、`pi/settings.json`、`pi/models.json`、`var/workspaces/` 任何任务都不得修改。**每个任务的「步骤 0」必须实际运行**：
  ```bash
  git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/
  ```
  前两者的 ` M` 状态须与开工前完全一致（用户预存编辑，不得回滚也不得追加），后两者须无输出。命中即停止并报告。
- **仓库外文件的处理规则**：`/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md` 是已安装副本，位于仓库外、不受 git 管理、在其他环境不存在。**仓库内副本 `skill-overrides/subagent-dispatch/SKILL.md` 是唯一生产交付物，也是唯一计入 WritePaths 的文件。** 已安装副本的同步是条件化环境步骤：先 `[ -f <路径> ]` 判定，存在才同步，不存在则记录 `skip: 已安装副本不存在于本环境` 并继续，不阻塞仓库代码任务。**所有读取该路径的测试断言必须写成条件式**：
  ```js
  const installedPath = "/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md";
  if (!existsSync(installedPath)) { t.skip("已安装副本不存在于本环境"); return; }
  ```

---

## 8. 三份计划的状态

| 计划 | 文档 | 状态 |
|---|---|---|
| A 派发合同与门禁 | `docs/plans/2026-09-23-plan-a-dispatch-contract-and-gates.md` | **已编写** |
| B workspace 与 proof 诊断 | `docs/plans/2026-09-23-plan-b-workspace-and-proof-diagnostics.md` | 待编写；任务细节来源为 v2 单一计划的 T6/T7/T8，须落实 BL-4、BL-6、BL-7、BL-8、HI-5、HI-6、HI-7、HI-8、HI-9、HI-10、HI-11、HI-12、HI-16、MD-6、MD-7 |
| C 宿主工具面与测试卫生 | `docs/plans/2026-09-23-plan-c-host-toolsurface-and-test-hygiene.md` | 待编写；任务细节来源为 v2 单一计划的 T9/T10/T11/T12/T14，须落实 BL-5、HI-13、HI-15、HI-16、MD-3、MD-4、MD-6 |
