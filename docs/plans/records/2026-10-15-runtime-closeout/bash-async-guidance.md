# D-guidance 验收记录：bash_async 模型引导最小修（description / promptGuidelines / launch 回执）

**taskId:** dispatch-065a29b2（contract sha256 `065a29b2efdd264b89ce9d4358a318e547c49812c0590bd620ce4c6d6768d5dd`，agent=executor）
**date:** 2026-10-15
**plan:** `docs/plans/2026-10-15-runtime-closeout.md`（本项按用户最新明确「引导强化直接顺手改」插入，不另开大计划）
**diagnosis:** `docs/research/2026-10-15-bash-async-agent-guidance.md` §4 改点 A/B/C
**status:** 完成；三条验证命令均已获得 unit-runner 槽（主管 2026-10-15 批复）后真实运行并通过，输出见 §5

## 1. 范围与实际改动文件

| 路径 | 动作 | 说明 |
| --- | --- | --- |
| `src/bash-async/index.ts` | Modify | 仅三处模型可见引导文案：tool `description`、`promptGuidelines` 第 2/3 条、`execute` 返回的 launch content 追加第二条 text 引导 |
| `test/bash-async.test.mjs` | Modify（仅追加） | 追加 3 个指导契约用例 + 一个 fake host 辅助函数；既有断言零修改 |
| `docs/plans/records/2026-10-15-runtime-closeout/bash-async-guidance.md` | Create | 本记录 |

未触碰（合同禁止项，全部保持原样）：`src/bash-async/controller.ts`（sender/生命周期/completion header/raw content）、`src/bash-async/renderer.ts`（TUI 投影继续消费原 `details`）、`src/bash-cwd/*`、`pi/AGENTS_SHARED.md`、`pi/AGENTS_GLOBAL.md`、`test/bash-async-runtime.integration.mjs`（真实 Host 集成，另槽审计）。未新增 sleep 拦截/正则门禁/daemon/轮询机制；未 stage/commit/stash/reset；未起 Host/网络/provider。

## 2. 三处文案的最终形态与合同对应

### 2.1 description（改点 A，措辞已按用户更正）

关键增量（诊断报告原稿写「不接受 sleep/wait 等纯等待命令」，会让人误以为执行器有硬拒绝；本任务不改 controller/command execution，故按用户措辞更正为引导性表述）：

- 准入限定：`仅用于测试套件、类型检查、产物构建、含网络请求等真实长耗时工作`；
- 反模式一（为等回执干等）：`不要为等待回执执行 sleep/wait`、`不要用 bash sleep 或轮询等结果`；
- 反模式二（当延时器）：`也不要把它用作延时器或常驻 daemon`、`不要用 bash_async 跑 sleep 来替代等待`；
- 正向动作：`收到接受回执后立即继续其他无冲突工作；没有独立工作时结束当前回合，命令完成会自动投 followUp 唤醒本会话`；
- 保留原有：短查询/立即依赖输出走 `bash`、仅 TUI/RPC、不提供隔离/持久化/崩溃重放。

无「拒绝/不接受/会被拦」类硬拒措辞（新增断言里对 `description` 显式禁词做了反向断言）。

### 2.2 promptGuidelines（改点 B，四条结构不变）

- 第 1 条**原句保留**（结果判定仍只在第 1 条承载，第 2 条不整段重复；断言用 `deepEqual`/`equal` 钉死原句 + 反向断言第 2 条不含 `outcome/exitCode 判断执行结果`）。
- 第 2 条（新）：正向动作（继续无冲突工作 / 结束当前回合 / 完成自动投 followUp）+ 明确正例（起 e2e 测试后转做无关文件或直接结束回合）+ 明确反例（`bash "sleep 60"` 干等、反复轮询状态、另起阻塞命令纯粹等结果）+ 同 cwd 并发写入并未隔离。
- 第 3 条（新）：保留门禁/凭据/网络/提交授权与自建 daemon 约束，追加 `sleep/wait 循环变相等待或当延时器` 反例；同时写清**不机械全禁**的边界——真实命令内部的 retry/backoff、测试自身的模拟延迟、用户任务里明确要求的 delay 属任务内容照常执行；未来某时刻或重复执行的用户任务用 `scheduler_create`，**不得自行提交定时器**（与 `src/task-scheduler/adapter.ts:111,124` 的「用户请求未来/重复任务」语义一致，且遵守「工单/定时器未经用户确认不自动提交」）。
- 第 4 条**原句保留**（`clear_queue` 属 Host/RPC 控制面事实，不是 tool 参数，本任务不顺手修改）。

`promptGuidelines.length` 仍为 4；`promptSnippet` 未改。

### 2.3 launch 回执（改点 C）

```ts
content: [
  { type: 'text', text: JSON.stringify(receipt) },            // 与改动前逐字节一致，字段集合不变
  { type: 'text', text: '以上为启动回执：accepted 仅代表任务已接受…' }, // 新增：模型可见行为引导
],
details: receipt,                                              // 原样，renderer 继续消费
```

第二条 text 承载：accepted ≠ 成功、立即继续独立工作或结束当前回合、完成自动投 followUp 唤醒、不 bash sleep / 不轮询本任务状态 / 不另起阻塞命令干等。这是**显式模型引导变更**（tool result 文本），不是为 TUI 改 raw：`details` 与第一条 JSON 块保持原样，TUI renderer 未改。

## 3. 新增测试契约（`test/bash-async.test.mjs` 追加，不改原断言）

`guidanceHost()` 复用既有 fake host 形态（`createBashAsyncExtension` + `registerTool/on/registerCommand/sendMessage` + `createBashToolDefinition` + 注入 `operations` 假执行器），**不启动真实 Host、不运行任何真实命令、不执行 sleep**。

1. `引导合同：description 限定真实长耗时工作，含两类等待反例与无独立工作则结束回合`
2. `引导合同：guidelines 保留第1条结果判定，第2/3条含正反例、同cwd不隔离、retry/backoff 与用户 delay 例外和 scheduler_create 语义`
3. `引导合同：launch 首 text 块与 details 保持 raw 回执不变，仅追加第二 text 引导，含 sleep 字样的合理命令不被拦`
   - 用命令 `sleep 60 && echo fixture`（合理 retry/backoff 形态字面）走 `tool.execute`，断言假执行器确实收到该命令（指引不构成拦截、命令输入不被改写）；
   - `content.length === 2`、首块 `JSON.parse` 后字段集合等于
     `['acceptedAt','branchEpoch','command','cwd','generation','jobId','kind','sessionId','toolCallId']`、`parsed` 与 `details` `deepEqual`；
   - 第二块包含全部引导短语，且不含硬拒措辞；
   - 生命周期不变：终态仍一条、`outcome=succeeded`、`completionDelivery=accepted`、`sendMessage` 只发生一次且 options 为 `{ deliverAs: 'followUp', triggerTurn: true }`。

既有断言（controller 语义、renderer 折叠/raw、Host 入口绑定等）零修改；`test/bash-async.test.mjs` 顶部 import 与既有 fixture 未动。

## 4. counts

- 生产改动：`src/bash-async/index.ts` 1 文件，3 处文案（description / guidelines[1] / guidelines[2]）+ `execute` 返回值 1 处结构调整（追加第二 text 块，首块与 details 不变）；相对任务开始前基线 +12 行 / -4 行（该文件任务前已携带上一批 +244 行的 activity 代码，属既有 dirty，未触碰）。
- 测试改动：`test/bash-async.test.mjs` +91 行 / -0 行：追加 1 个辅助函数（`guidanceHost`）+ 1 个常量 + 3 个用例；删除 0 个既有用例，修改 0 条既有断言（任务前该文件为 clean）。
- 文档：新增本记录 1 文件。
- 未改动文件：controller / renderer / contracts / bash-cwd / AGENTS_* / runtime 集成测试 / package。

## 5. 验证命令与结果（真实运行）

槽位：`unit-runner` 独占，经 `contact_supervisor(reason: need_decision)` 申请并获主管批复后串行执行；未与其他 unit 任务并行，未起真实 Host/网络/provider。

| # | 命令 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `node --test test/bash-async.test.mjs test/bash-async-activity.test.mjs` | **exit 0** | `tests 39 / pass 39 / fail 0 / cancelled 0 / skipped 0 / todo 0`（含 3 个新增引导契约用例全部 `✔`） |
| 2 | `npm run typecheck:root`（`tsc --noEmit -p tsconfig.json`） | **exit 0** | 无诊断输出 |
| 3 | `git diff --check` | **exit 0** | 首次运行 exit 2：`test/bash-async.test.mjs:368: new blank line at EOF.`（本任务追加块留下的 EOF 空行），删除该行后重跑 exit 0；重跑命令 1 仍 39/39 pass |

环境：Node v26.8.1。本任务未运行 `test/bash-async-runtime.integration.mjs`（含真实 Host），留给另槽 runtime 回归审计。

### 5.1 工作区与 counts

- 本任务写路径实际行数变化（`git diff --numstat` 叠加任务前基线差值）：`src/bash-async/index.ts` 相对任务开始前 +12/-4（纯文案与 launch 返回结构），`test/bash-async.test.mjs` 91 insertions / **0 deletions**（既有断言零改动，仅追加）。
- staged：`git diff --cached --name-only` 为空（0 条），未执行任何 stage/commit/stash/reset/worktree 操作。
- 工作区 dirty 总数 95（`git status --porcelain=v1`：39 modified + 56 untracked）：除本任务 3 个写路径外，其余均为上一批未提交的既有 dirty，未被本任务触碰或清理。
- provider/network/Host：本窗口零调用（纯本地文件编辑 + fake host 单测 + tsc + git 只读命令）。
- 越界文件未动的现场证据（`ls -lT` mtime，本窗口时间 2026-10-15 20:29–20:40 CST）：`src/bash-async/index.ts` 10-15 20:29、`test/bash-async.test.mjs` 10-15 20:38 为本任务写入；`controller.ts` 10-14 16:15、`contracts.ts` 10-14 16:14、`renderer.ts` 10-13 16:29、`test/bash-async-activity.test.mjs` 10-14 16:25、`test/bash-async-runtime.integration.mjs` 10-13 14:45、`pi/AGENTS_SHARED.md` 10-09、`pi/AGENTS_GLOBAL.md` 10-10 均早于本任务窗口。

## 6. 残余风险

1. **模型遵从率尚未实测**：本记录只证明文案与 tool result 引导已按合同落到模型真实消费的通道（description/guidelines/tool result text），不证明两种误用（bash sleep 等回执 / bash_async 跑 sleep）消失。真实 provider 的遵从率需后续在真实 session 观察 toolcall 原文；本任务合同禁止真实 provider/Host，故无现场证据。
2. 改点 C 使 launch tool result 从 1 个 text 块变为 2 个；源码内未见按「恰好一个 text 块」解析 launch 的消费者，`test/bash-async-runtime.integration.mjs` 断言走 `details`，但外部脚本未逐一审计。
3. guidelines 注入依赖 `bash_async` 在活跃工具集（main 默认活跃）；child 白名单不含 `bash_async`，本引导对 child 不注入（诊断报告 §2.3），属预期而非缺陷。
4. `test/bash-async-runtime.integration.mjs`（真实 Host）与 runtime 回归未在本次纯 unit 窗口内运行，需另槽审计。


## Inline提交范围补记

commit `b583052` 实际包含上一批F3只读observer的contracts/controller/index增量与本引导测试，非仅本记录原始三处文案。当前39/39同时覆盖二者；后续 `634deb4` 提交其package公开协议与Host接线依赖，因此仅以当前最终树声明整体可用，不声称早期中间commit可独立checkout安装。原任务阶段“未碰controller”仍是历史事实，但不能拿它描述该commit的最终范围。
