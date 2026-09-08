# 历史 generation replay 在 dispatch compile 丢失 executor profile

## 数据来源与首个偏离

`test/goal-engine-events.integration.mjs` 的十个失败逐项复现后分类如下：

1. `unsafe historical v2 create recovers atomically through a safe amendment`：历史 `goal-engine.event.v2` JSONL replay，随后合法 amendment。
2. `v2 create and amend replay identically across child-process cwd values`：历史 `goal-engine.event.v2` create/amend replay。
3. `historical v1 and v2 amendments update a task added by the same event`：历史 v1 JSONL 与 v2 replay candidate。
4. `v2 pending replacement succeeds while accepted and unreleased replacements reject atomically`：历史 v2 reducer candidate。
5. `amend allows never-dispatched and discarded released pending tasks`：历史 v2 reducer candidate。
6. `workflow amendments apply to never-dispatched and discarded released pending tasks`：历史 v2 reducer candidate。
7. `preserved work becomes amendable and redispatchable only after preservation release`：历史 v2 reducer candidate。
8. `completed goal records discovery and reopens into a new immutable epoch`：legacy v1 完成账本上的 v3 continuation。
9. `goal contract amendment requires a real approval identity and preserves old metadata`：历史 v2 replay 后的 v3 contract amendment。
10. `planned.v1 is an isolated persisted generation with strict criteria`：planned.v1 fixture 的过期 schema expectation。

前九项的共同链路是合法 `goal-engine.event.v1/v2/v3` 账本 create/replay
→ pending task → amendment/continuation → `assertPendingTaskContractsCompile`
→ `legacyExecutorProfile`。这些 legacy generations 的 task 定义从不持久化
`agentProfile`；要求 fixture 添加该字段既不能被 reducer保留，也把不可达的新
Goal-v2 字段伪造进历史账本。首个偏离是 `legacyExecutorProfile` 仅将
`planned.v1`/`goal-runtime.v1` 视为 legacy，错误拒绝 `goal-engine.event.v1/v2/v3`。

## 修复边界

按 generation capabilities，`goal-engine.event.v1/v2/v3` 同样使用 legacy
executor transport profile `executor`。仅 `planned.v2` 与 `goal-runtime.v2` 保持
显式 `agentProfile`，不会增加 production fallback，亦不会恢复 v2 writer。
RED 为 `node --test test/goal-engine-events.integration.mjs`（10 failures，首栈
`task requires agentProfile`）；最小 GREEN 仅扩展 compatibility adapter 的 legacy
generation 集合。
