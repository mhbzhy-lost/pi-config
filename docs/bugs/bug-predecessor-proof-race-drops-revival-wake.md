# Predecessor proof 竞态丢失 non-resumable revival wake

## 1. 现象

active Plan Runner的non-resumable proof先触发revival，但当时历史predecessor尚无可比较canonical identity，selector正确fail closed。紧接着predecessor的补全official proof到达，却复用了即将reject的revive single-flight；single-flight清理后没有新触发，普通follow-up或queued push永久停留。

## 2. 影响

同一组durable wake和official proofs因微任务到达顺序不同，可能恢复成功或永久挂起。live lifecycle有timer retry，但Attention follow-up与queued push没有，因此行为不满足proof-order independence。

## 3. 时间线

- predecessor以resumable proof创建active下一代，但早期proof未携带canonical session identity。
- active代official stop，non-resumable proof携带canonical identity并触发revival。
- selector找不到同canonical predecessor，operation进入rejected状态但single-flight尚未清理。
- predecessor补全proof立即到达，其`reviveCallerAfterProof`取得旧operation。
- 旧operation清理后没有重评，wake仍在但没有后续触发点。

## 4. 根因

`acceptTerminalProof`无条件调用single-flight入口，却没有区分“本次proof新建operation”和“predecessor proof撞上既有operation”。后者可能改变resume-source可用性，必须在既有operation settle并完成cleanup后重评一次。

## 5. 触发条件

同logical caller的非active predecessor official proof在active revival operation in-flight期间到达，且该proof补充或更新了合法resume source；wake类型不是自动timer重试可覆盖的live lifecycle debt。

## 6. 修复与验证

新增RED精确构造active proof先到、predecessor canonical proof在同一微任务窗口补全。仅当非active predecessor proof到达时已存在同logical revival single-flight，注册一次settle后重评；active proof自身、普通resume失败和无新proof场景不得形成即时循环。重评仍通过active proof、wake、same-logical、same-canonical、generation和observedAt全部fence。
