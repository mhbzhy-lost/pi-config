# D-PROVENANCE：历史 proof debt 身份链核验

## 范围与方法

本报告只解释 `var/snapshots/2026-09-23-pre-remediation/` 的冻结时点，不估计当前 live 数量；`D-AUDIT.md` 的 **529** 是该快照四分区 debt 总数。只读消费四份 `P*/terminal-proof-outbox/terminal-proofs.json`、P1 的五份 `records/*.json`、P1 的八份 `integration-queue/*.json`、快照 `manifest.json`，以及本仓 `var/sessions/**/*.jsonl` 中匹配到的持久根 session 事件。未读取或修改 live `var/workspaces/`、worktree 内容，也未读取凭据；原始身份仅在内存中做精确相等比较，输出只保留聚合。会话扫描为一次批量内存 Python 分析（6,691 份 JSONL、820,239 行；解析失败 0）；后续只以批量脚本复核结构、入口签名及时间关系，没有按债务逐条调用 shell。会话中非结构化文本、提示词与自述不作为权威身份。

## 生产调用链及所需权威事实

- **public/typed 入口与 root owner：** `src/subagent-dispatch/extension.ts` 的 spawn 路径先取得授权注册，再对分配的 workspace 调用 `workspaceService.bindRun`；`src/workspace/service.ts` 的 `bindRun` 持久化 run 绑定，`listOwned` 经 owner scope 与 ledger 筛选。`src/subagent-dispatch/root-broker-server.ts` 的 `registerAuthorizedRun` 从 Host `RunAuthorization` 登记 owned run；有 AuthorityStore 时才持久创建 owner receipt/lease。facade started event、普通 session 叙述均非 owner receipt，不能据此证明授权或工作区绑定。
- **终态与 debt：** Root Broker 的 `acceptTerminalProof` 校验官方终态 run/可选 process 字段并解析 observed terminal；`rootBrokerTerminalProofId` 对 canonical accepted proof 求哈希。Host 入口 `extensions/subagent-runtime.ts` 的 `broker.recordTerminalProof` 调用 `classifyTerminalProofBinding`；该分类器首先 `client.listOwned({runId})`，失败才退到 owner-scoped ledger；可信空集合返回 not-applicable，单绑定先 enqueue 再经 coordinator 投递，多绑定/无效数据/双源不可用才 `recordDebt`。`coordinator-proof-outbox.ts` 的 `recordDebt` 仅保存 proof 哈希、run、reason、observedAt，移走对应 pending；receipt/supersession 会优先拦截。debt 本身**不包含**官方 terminal 原文、root owner receipt、workspace 身份或选中绑定的证据。
- **资源/receipt 顺序：** `src/workspace/coordinator-server.ts` 的 `record_terminal_proof` 先 enqueue、replay，投递需已有完成的 queue item，核对 child run、owner scope，再通过 `workspaceService.recordTerminalProof`、status/action/discard 得到 receipt；未完成时可请求 resume 并保持 pending。`src/workspace/service.ts` 的 `resolveProof` 还核对 run、asyncDir、root scope 与 ledger record。故不能由“同 reason”、相邻时间、absence of records 或 session 工具结果替代官方 terminal→owner→workspace→queue→receipt 顺序。

上述源码路径均以 `packages/pi-subagents-enhanced/` 为前缀；源码是合法路径定义，不是历史 529 条逐条走过该路径的证明。

## 证据矩阵：匹配与第一断点

| 类别及快照数 | public/typed 入口、root 身份 | terminal proof 与 debt | workspace / queue / receipt、事件时间 | 第一处无法跨越的断点及分类 |
|---|---|---|---|---|
| P1：188 | 根 session 中 187 条的成功 `subagent` toolResult 有精确 run 身份与时间，另 1 条无对应成功 spawn toolResult；根 session header 只是 session 记录，非 Host 授权/owner receipt | 188 条具 outbox debt 结构；没有与该集合相同的快照 receipt、pending 或 supersession proof 身份；不能从 debt 反求官方终态 | P1 五个 records 的 `run` 均不与 188 个 debt run 身份相等。八个 queue 文件有一处嵌套 resume run 身份交集，但 queue item 的 childRunId、record run 和 debt 并无完整共同绑定；交集不是对应 proof 的 queue/receipt 链。187 条可核成功 spawn 的时间早于各自 observedAt | 对 187 条，成功 spawn 之后**首次**无法验证 Host owner receipt、官方 terminal 及 owner-scoped `listOwned` 在 debt 时的结果；余 1 条甚至缺少可核成功 spawn。全部 unknown |
| P2：110 | 110 条均有根 session 成功 `subagent` toolResult，且发生在 debt observedAt 之前；未取得 Host owner receipt | outbox 仅留 debt 摘要；无匹配 proof 的 receipt/pending/supersession，也无官方终态原文 | 快照 records 为 absent，queue 文件 0；absent **不是**无 workspace 证明 | 成功 spawn 后无 owner receipt、terminal 原文及 debt 时刻的可信 workspace 查询；unknown |
| P3：130 | 130 条均有上述成功 spawn 与先于 debt 的顺序，未取得 Host owner receipt | 同上 | records absent，queue 文件 0；不能从缺失推断无绑定 | 同上；unknown |
| P4：101 | 101 条均有上述成功 spawn 与先于 debt 的顺序，未取得 Host owner receipt | 同上 | records absent，queue 文件 0；不能从缺失推断无绑定 | 同上；unknown |

聚合交叉核验：529 条 debt 的 run 身份与 proof 哈希分别各有 529 个不重复值；结构化成功 spawn `subagent` toolResult 精确匹配 **528/529** 条，每条一次，来自 12 份持久 session 文件，时间均先于对应 observedAt。其请求中显式声明 `worktree:false` 的为 **339**，未显式声明 worktree 的为 **189**，缺成功 spawn 的为 **1**；声明值只说明请求形状，不能单凭它排除其他 owner-scoped 持久绑定或证明对应债务错误。529 条的 proof 哈希无任何可核的官方终态原文匹配；快照 receipt 为 0，P1 pending 5、supersession 3 均未与债务 proof 身份重合。P1 五个 records 的 `terminalProof` 均非已观察终态，且五条 run 均不匹配这些 debt。上述“无匹配”仅限冻结快照及扫描到的持久 session 结构化字段，不断言现场从未存在这些资源。

## 严格三分法及 D-INTERFACE-DESIGN 输入

| 来源分类 | 数量 | 可做的结论 |
|---|---:|---|
| production 可达，身份链完整的历史 debt | 0 | 源码表明 `recordDebt` 合法可达，但未证明任一历史实例的 Host owner、official terminal、绑定查询及先后顺序完整有效；不能把 schema 的合法性算为逐项归因。 |
| 仅 fixture/测试制造 | 0 | 未取得能证明历史实例来自绕过 public 入口的 fixture/手工 append 的权威生成链；不能据缺 record 或请求标志反推 fixture。 |
| 来源未证实 / fail closed | **529** | P1：188；P2：110；P3：130；P4：101。未证实集合不得进入自动清理。 |

**可证明的最小清理候选集合：0。** 对 D-INTERFACE-DESIGN 的具体缺口如下：

1. **成功 spawn + 显式 `worktree:false`（339）：** 有根 session 的 public 请求/成功结果和先后时间；欠 Host `RunAuthorization`/owner receipt、官方 terminal 原文及哈希验证、debt 生成时 owner-scoped `listOwned`/fallback 的真实结果。后续只读取得相应 Host 权威 receipt、官方 artifact、持久 coordinator/ledger 的同期版本和事件序列，并核对 run、root scope、process、时间；若原始资料不存在，保持 unknown。
2. **成功 spawn + worktree 未声明（189）：** 除上述事实外，还欠 public 入口对缺省 worktree 选择后的实际资源分配与绑定 receipt。须以 typed 分配/`bindRun` 的持久记录和时间序列对照根 session 结果，而不能把字段缺省解释为 `false`。
3. **无成功 spawn toolResult（1，P1）：** 首先缺根 session 中可核成功 public 派发与 Host 注册证据；还欠第 1 组的所有下游事实。可按持久 parent/child session 事件及 Host authorization/terminal artifact 复核；若仅找到提示词、event facade 或一次相近时间事件仍 unknown。
4. **P1 的 queue resume 身份交集（属于上述 P1 集合，并非额外 1 条）：** 欠同一 workspace/lease、root owner、官方 proof 和 queue item 的精确关联，以及 enqueue、resume/rebind、完成、receipt 的单调顺序。通过同一时点的 coordinator queue item/recovery intent、workspace ledger、authority receipt 和官方 artifact 的持久原文核验；仅 run 字段相同不能升级归因。P2–P4 的 records 缺失、queue 文件为空同样须查权威历史持久数据，不能据缺失直接归类。

**阻塞/风险：** 当前准许的冻结快照与 session JSONL 未提供上述完整权威链；A-ENV 为 degraded，本节点不调用 supervisor，不越界读取凭据或 live workspace，不启动 mutation，不推断归因。D-AUDIT 的 529 是历史时点，绝非当前 live 数。D-CLEANUP.md 已记录 `blocked-no-safe-public-exit`；本报告不改变该安全门，也不设计或调用历史 debt 删除接口。

**TDD 豁免：** 本任务仅有只读探索和中文报告，无 production、配置或测试行为变更，不存在可先写 RED 再改代码的实现目标；通过批量交叉核验、仅写本报告、`git diff --check` 与 staged 检查验证文档边界。
