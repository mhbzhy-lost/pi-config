# Root revival 反复 resume 已停止的 active generation

## 1. 现象

真实amendment Harness取得唯一crash proof后，Root连续95次尝试`resume` active Plan Runner `f8676c88`。该run已被official `drainRun()`停止，terminal proof明确为`observed`且`resumeDisposition: non-resumable`；pinned Pi每次均拒绝“was stopped and cannot be resumed”。

## 2. 影响

revision 2的`plan.amended`已持久化但current pointer仍为revision 1，old Attempt未执行supersede cleanup，Plan停在running。Root产生无意义重试，amendment crash recovery无法完成。

## 3. 时间线

- generation 0和1正常完成，official proof均为`resumable`，共享同一canonical Plan session。
- generation 2消费Attention reply并在event-to-pointer barrier后成为active actual。
- tests-only Root fault control依次official drain old Executor和generation 2 Runner，两者proof均observed；Runner disposition为`non-resumable`。
- Executor completion形成live lifecycle debt，Root按active actual调用`resume(f8676c88)`。
- pinned Pi拒绝stopped run，Root在90秒Harness deadline内持续重试，未创建generation 3。

## 4. 根因

Root把“active actual identity”和“可用于恢复同一canonical session的resume source”视为同一字段。official stop后active identity仍是generation CAS、debt和stale fence的权威，但已不再是合法resume source；Root没有从同logical caller历史中选择可信的resumable predecessor。

## 5. 触发条件

active Plan Runner通过official stop取得`resumeDisposition: non-resumable` proof，同时存在待处理的follow-up、queued push或live lifecycle debt，并且较早generation保存了同一canonical session的resumable proof。

## 6. 修复与验证

新增RED要求：仅当active proof精确为non-resumable时，Root才能选择同logical alias、同official `canonicalSessionId`、最近observed且`resumeDisposition: resumable`的Plan Runner predecessor；private recovery preparation和upstream resume使用该source。handoff `sourceActualRunId`、live debt消费、grant CAS和active alias仍指向原active actual。找不到同canonical source时fail closed，不调用resume。focused revival、fixed socket、累计门禁和下一冻结HEAD唯一真实Harness验证。
