# dispatch IR 的 task 字段被 4 KiB 硬限制，无法承载完整任务说明

- 日期：2026-09-30
- 级别：P2（可用性缺陷；阻碍「派发时必须提供完整信息」的全局约束落地）
- 状态：已修复

## 现象

派发 reviewer 执行后审核时，`subagent` 工具返回：

```
INVALID_CONTRACT: task exceeds 4096 bytes; keypath=task
```

被迫把完整审核说明落盘到 `var/upgrade/post-execution-review-brief.md`，再用精简 task
指向该文件，多绕一跳。

## 根因（首个偏离点）

`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`：

- 第 5 行 `const MAX_STRING_BYTES = 4 * 1024;`
- 第 36 行 `function string(value, key, maxBytes = MAX_STRING_BYTES)`
- 第 88 行 `const agent = string(source.agent, "agent"), task = string(source.task, "task"), ...`

`task` 走的是 `string()` 的**默认**上界，与 `agent`、`title` 共用同一个 4 KiB 常量。
`agent`/`title` 是短标识符，4 KiB 绰绰有余；但 `task` 是任务正文，语义上属于
「文档级」载荷，被错误地和标识符共享了同一个上界。

工具 JSON schema（`subagent-dispatch/extension.ts:84`）对 `task` 只声明
`{ type: "string", minLength: 1 }`、**没有 maxLength**——这是既存有意设计（schema 的
`maxLength` 量字符、contract 量 UTF-8 字节，多字节文本下不等价），但也导致调用方
从 schema 完全看不出存在任何上界，只能撞墙后才知道。

## 数据来源分类

**类别 1（预期 production 数据未被正确处理）**：完整、详尽的 task 正文是合法 public
typed 入口的正常输入，`pi/AGENTS.md` 明确要求「subagent 启动时必须提供完整的信息，
不得仅出现粗略指令」。4 KiB 上界与该要求直接冲突，属生产可用性缺陷，非测试制造数据。

## 影响面核查（确认唯一强制点）

- `MAX_STRING_BYTES` 仅被 `dispatch-ir.ts` 使用（`agent`/`task`/`title` 默认上界）。
- `contracts/contract-limits.ts` 的 `MAX_CONTRACT_STRING_BYTES = 4096` 只被
  `settlement-evidence.ts` 使用，与 task 无关，不改。
- `subagent-dispatch/root-broker-protocol.ts` 的 4096 是 coordinator 参数
  （requestId / queueItemId / git ref）上界，与 task 无关，不改。
- `title-registry.prepare` 不限 task 长度，仅存储。
- 既有测试无任何用例断言 task 的 4096 上界。
- 真正的下游硬约束是 `renderDispatchPrompt` 的 `MAX_PROMPT_BYTES = 64 KiB`。

## 修复设计

1. 为 `task` 引入**独立**上界 `MAX_TASK_BYTES = 32 * 1024`（32 KiB，原 8 倍），
   `agent`/`title` 维持 4 KiB、`model` 维持 512 B 不变——不连带放宽标识符字段。
2. 同步把 `MAX_PROMPT_BYTES` 提升到 `128 * 1024`：`task` 经 `JSON.stringify` 渲染进
   prompt 时会因转义（换行/引号/控制字符）膨胀，32 KiB 正文在正常散文中约 1.05–1.2 倍，
   128 KiB 为最大合法 task 留足余量，避免出现「task 通过校验却被 PROMPT_TOO_LARGE
   拒绝」的不一致失败。
3. **保留 fail-closed**：超过 32 KiB 的 task 仍以 `INVALID_CONTRACT; keypath=task`
   明确拒绝，不做无界放开；病态输入（大量控制字符致转义膨胀超 128 KiB）仍由
   `PROMPT_TOO_LARGE` 兜住。
4. **工具 schema 保持不声明 `task.maxLength`**（沿用既存有意设计）：`extension.ts:81-84`
   原有注释已说明 JSON Schema 的 `maxLength` 量的是**字符数**、而 contract 量的是
   **UTF-8 字节数**，中文等多字节文本下二者不等价，声明字符上界会产生误导性语义。
   因此 contract 层保持权威、schema 不加 `maxLength`；但原注释里的「64 KiB」已因本次
   改动陈旧，同步更正为 32 KiB task / 128 KiB prompt，并补注 `MAX_TASK_BYTES` 出处。

## 跳边界一致性核查（防止括大上界后撞上下游更小的限制）

括大 `task` / prompt 上界前，逐一核实两个已存在的 64 KiB 类下游限制是否会被撞到：

1. **broker frame（`BROKER_FRAME_LIMIT_BYTES = 64 KiB`）——不会**：
   `root-broker-protocol.ts` 全文 **零次**出现 `task` / `prompt`；method 全集为
   `ping, subscribe, acceptance.submit, coordinator.register, owner.read, owner.rebind,
   owner.revoke`；`acceptanceParams` 只承载 criterion **id**（上限 160 字符）与
   evidence 的**不可变引用**，不传正文；`coordinatorParams` 只传 requestId /
   queueItemId / git ref。派发正文不走 broker frame。
2. **durable envelope（payload `DURABLE_PAYLOAD_TOO_LARGE = 32 KiB`、frame 64 KiB）
   ——不会**：全仓搜索确认**无生产代码构造 durable envelope**，也无生产调用方调
   `DurableEventOutbox.append`（仅 `test/durable-lifecycle.test.mjs`、
   `test/supervisor-replay.test.mjs`、`test/subagent-delivery-recovery.test.mjs` 等测试
   构造）。task 不会进入 envelope payload，因此与 32 KiB payload 限制无交集。
3. **prompt 上界同步括大**：`MAX_PROMPT_BYTES` 64 KiB → 128 KiB，使最大合法 task
   （32 KiB）经 `JSON.stringify` 转义膨胀后仍能渲染，不产生「contract 通过、
   prompt 拒绝」的不一致失败。无既有测试依赖旧 64 KiB prompt 上界（已 grep 确认）。

## 验收

- RED→GREEN：20 KiB task 可编译且能渲染 prompt；32 KiB 边界内通过；超限仍被拒并带
  `keypath=task`；`agent` 超 4 KiB 仍被拒（确认未连带放宽）。
  RED 原始输出：`Error [CodingDispatchContractError]: task exceeds 4096 bytes; keypath=task`。
- dispatch 相关测试集 **109/109 绿**（ir / ir-coercion / contract-hash-compat /
  schema-security / schema-coercion / extension / durable-lifecycle / root-subagent-broker）。
- `npm test` 全量 **938 tests / 937 pass / 0 fail / 1 todo**（较修前 935 基线 +3
  为本次新增用例）；`typecheck:root` 与 `typecheck:subagents-enhanced` 均通过；
  `verify:subagents-enhanced` 通过（controlled 1207 文件对齐 registry）。
- **真实派发端到端验证**：以 ≈ 7 KB 中文 task（远超旧 4096 字节上界）实際调用
  `subagent` 工具派发 executor，**未再出现 `INVALID_CONTRACT`**，子 run `c4276a90`
  正常启动并按指令返回 `LARGE_TASK_OK`，证明新上界在真实 Host 链路上生效。
