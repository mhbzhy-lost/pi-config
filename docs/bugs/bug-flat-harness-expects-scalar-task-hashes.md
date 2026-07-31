# flat Harness 把 v3 taskHashes 当作标量

## 1. 现象

对task63cg失败点之后的flat Harness断言做静态审计时发现，`assertFutureGreen()`验证`plan.created` revision identity时构造：

```js
taskHashes: Object.fromEntries(ir.nodes.map((node) => [node.id, node.hashes.effective]))
```

这要求每个task hash是单个effective字符串。但完整`plan-ir.v3` revision identity已将每个task固定为`{ full, effective, scheduling }`三哈希对象。若只修复当前asyncDir取证后立即运行新Harness，该更靠后的断言会确定性假RED。

## 2. 真实证据与反证

`plan-revision-store.mjs`的`revisionTaskHashes(ir)`对v3明确返回：

```js
{ full: node.hashes.full, effective: node.hashes.effective, scheduling: node.hashes.scheduling }
```

`validateBinding()`把immutable revision manifest的`taskHashes`原样放入`revisionIdentity`，Capsule再把它原样写入`plan.created`。`plan-events.mjs`的revision validator和amendment diff依赖三种hash区分全文变化、有效执行变化与调度变化，不能降级为标量。

此前task63ce owned event inspection已观察到两个task的完整三哈希对象；task63cg又在到达该断言前因public status不含asyncDir提前失败。因此这是尚未被执行到的Harness oracle问题，不是production contract漂移。

## 3. 根因

flat Harness最初按旧版“每task一个hash”形态编写，后来dispatch断言已迁移为分别验证`taskHash`和`schedulingHash`，但`plan.created.revision.taskHashes`的expected仍保留旧标量形态。

测试把“Executor effective identity”误当成“immutable revision task identity”。前者只需要effective hash，后者必须同时持有full/effective/scheduling以支持amendment与replay。

## 4. 正确修复

只修改flat Harness expected：

```js
Object.fromEntries(ir.nodes.map((node) => [node.id, {
  full: node.hashes.full,
  effective: node.hashes.effective,
  scheduling: node.hashes.scheduling,
}]))
```

保留`assert.deepEqual`，因此missing、extra、错配或标量都会失败。不得修改revision store、event schema、IR compiler或把断言降为只检查effective。

该修复可与status↔bound取证修正之后一并进入下一冻结HEAD，但必须保持独立bug文档和独立tests-only提交，便于审计每个oracle变更。

## 5. TDD 验证

这是tests-only latent oracle纠错，无production逻辑变更。RED由三层证据构成：

1. v3 revision store源码固定输出三哈希对象；
2. Plan event validator依赖三哈希语义；
3. task63ce真实owned `plan.created`事件实际包含三哈希对象，而Harness expected为标量。

无需再运行一个已知必然失败的真实Harness来重复证明。修改后运行Plan revision/IR/events focused tests，随后才冻结包含asyncDir与taskHashes两项oracle修正的新S0，并只运行一次真实persisted Harness。

## 6. 影响边界

变更只影响flat Harness的expected literal，不改变任何production或public status。它提高而非放宽验证强度：从单一effective hash提升为三哈希exact equality。

若不修，正确的v3 revision event会在下一个Harness更晚位置假RED，浪费单次真实基线；在前序断言通过后暴露，修复代价低。若错误降级production为标量，则amendment/replay identity失真，修复代价高。
