# recovered terminal publish 失败污染 binding ledger

## 1. 现象

外部 Round 2 review 发现，`recoverBinding()`从Root恢复official observed terminal proof时，先把`entry.completionPublished`设为true，再调用注入的`emitFact`。若`emitFact`抛错，operation拒绝，但`pending`/`byRunId`已保留entry，且entry被标记为已发布。

后续exact `recoverBinding()`命中existing binding后直接返回，不再查询Root或发布completion；matching lifecycle completion也因`completionPublished=true`被抑制。Plan可能永久停在active。

当前真实Plan Runner installer的`emitFact`是同步`executionFacts.push`，正常情况下不会抛错，因此task63bs目标路径不触发该问题；但execution backend公开允许注入callback，必须对失败保持可重试。

## 2. 真实证据与反证

Round 2建议仅把`completionPublished=true`移到`publish()`之后。该交换能避免后续lifecycle event被错误抑制，但不能恢复durable lookup重试：publish抛错时权威ledger仍已提交，第二次`recoverBinding()`仍会从`existingRecoveredBinding()`提前返回，既不lookup也不补发fact。

现有非法lookup重试测试只能证明lookup validation发生在ledger mutation前；它没有覆盖“validation已成功、ledger已提交、fact sink失败”的partial commit窗口。并发single-flight测试的`emitFact`均不会抛错，也无法暴露该状态。

## 3. 根因

恢复operation把三步动作当作独立写入：

1. 写`pending`与`byRunId`；
2. 标记`completionPublished`；
3. 调用外部`emitFact`。

catch只reject deferred并清理非权威`recoveringBindings`，不会回滚本operation刚写入的权威ledger。`existingRecoveredBinding()`无法区分“完整恢复成功”和“fact发布失败后的半提交entry”。

## 4. 正确修复

恢复operation应记录自己创建并提交的entry。official proof存在时先调用`publish()`，成功后再设置`completionPublished=true`并resolve；若publish或其前后步骤抛错，在reject前仅当`pending`仍指向本entry且`byRunId`仍指向本entry.binding时，精确删除这两个ledger键。

不得删除或覆盖await期间由其他入口提交的entry；条件identity fence必须防止旧operation清理并发后来者。非proof的active binding恢复不调用publish，仍正常提交。lookup/typed proof校验前零ledger mutation、single-flight finally cleanup和错误code传播保持不变。

不采用“先publish再写ledger”：fact消费者可能同步查询backend，必须先看到完整binding。也不吞掉`emitFact`异常；调用方必须知道恢复尚未提交，并可重试Root durable proof。

## 5. TDD 验证

先提交tests-only RED：

1. Root lookup返回exact spawned binding和observed proof；`emitFact`首次调用在记录fact前抛出固定错误。
2. 首次`recoverBinding()`必须原样reject该错误，且不得调用spawn/status/artifact polling。
3. 关闭注入故障后以同一binding重试；期望Root lookup总计两次、返回exact binding且只记录一个exact `execution.completed` fact。
4. 重试后再调用一次exact recovery与matching lifecycle completion，lookup和fact均不得继续增加，证明成功提交后的幂等性。

当前实现会在第二次调用直接返回existing binding，lookup仍为一次且facts为空，形成明确RED。测试不得通过读取private map或sleep判断内部状态。

GREEN仅修改`pi-subagents-execution-backend.mjs`，使用entry identity条件回滚；focused backend、固定socket Root、FIFO/revival和dependencies/Capsule门禁必须全绿。

## 6. 影响边界

影响仅限`recoverBinding`已完成Root lookup校验后、official completion fact发布失败的异常分支。正常proof恢复、无proof active恢复、普通lifecycle、spawn、supersede、Root broker与public协议均保持不变。

若不修，未来fact sink改为可能抛错的持久化或事件适配器时，单次瞬时失败会变成不可重试的永久active状态；在sink异常时暴露，修复代价中。若无identity fence地回滚，则可能删除并发入口的合法binding，修复代价高。
