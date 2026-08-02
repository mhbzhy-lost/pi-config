# Bug: shutdown debt 隔离、dispose 重试与安装回滚不完整

## 症状
同一 cleanup store 中一个 Pi 的失败 shutdown debt 会影响另一个 Pi 的 runtime replacement，使后者旧 RPC 永不 dispose。dispose 链首项抛错时，后续资源不清理，重试却因全局 disposed 标记直接跳过并把 debt 判定完成。连续 replacement 时，独立 dispose promise 还可能提前结算失败 debt，或永久跳过中间 generation。另在旧 debt 存在时，新 generation bootstrap 后若 notifier/typed extension 安装失败，被隐藏的旧 upstream global ownership 不会恢复，cleanup callback 写入的更新 ownership 也可能被旧值覆盖。

## 影响
独立 Pi 实例之间会互相阻塞并泄漏旧 runtime；部分清理失败会永久遗失 RPC、listener 或 notifier ownership；安装失败会留下半成品 generation 并丢失旧 cleanup 入口。后续 reload 可能出现重复 bridge、不可偿还 debt 或静默资源残留。

## 复现
Pi A 留下 failed debt 后，在共享 store 中替换 Pi B runtime，B 旧 RPC 的 dispose 次数仍为 0 且队列残留。构造两个 disposable 与 RPC，让第一个 disposable 首次抛错，第二项和 RPC 均未执行；重试后 queue 却被清空。存在旧 global key 时让 bootstrap 写入新 key，再因缺少 resolver 抛错，旧 key 未恢复。

## 根因
shutdown debt manager 只按 cleanup store 建一个全局数组，没有按稳定 runtime lineage（跨 reload 保持、跨 Pi 隔离）分 lane；registry 也未关联对应 debt。replacement 另起的 dispose promise 可绕过 ordered cleanup 直接把 debt 标成完成，而偿还循环只处理 attempted debt，导致中间 generation 永久留在队列。dispose 在任何子资源执行前就设置单一 `disposed=true`，没有逐项完成状态。安装事务的 try/catch 只包住 bootstrap；回滚又以永久布尔标记代替最终 ownership 比较，因此既会漏清理，也会覆盖 callback 建立的新 owner。

## 修复
以稳定的 `pi.events` 身份划分 debt lane，使同一 Pi reload 共享、不同 Pi 隔离；registry 保存旧 runtime 对应 debt，所有 replacement 复用 debt 自身的 single-flight ordered cleanup，并按队列顺序偿还全部未完成 generation。dispose 为每个资源维护独立完成状态，执行全部项并聚合错误，重试只处理失败项，全部成功才完成 debt。把 bootstrap、notifier 和 typed extension 创建放入同一安装事务；失败时清理本代资源，并逐 key 保存 cleanup 后的精确 presence/value，恢复前再次比较 ownership，避免覆盖并发建立的新 owner。

## 验证
先新增 RED：跨 Pi 隔离、dispose 部分失败重试、安装失败 ownership 回滚；终审后再补 replacement promise 与 ordered cleanup 竞态、三代连续 replacement、跨 callback ownership 改写三项时序回归。确认旧实现均按预期失败，再做最小修复；运行 production shutdown、runtime membrane、真实 Loader reload、Root Broker、完整 npm test、Doctor、Pi integration、Python tests 和 diff 检查。
