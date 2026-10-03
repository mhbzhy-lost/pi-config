# UNVERIFIED 假设：liveRunEpoch=0 被 strictly-positive 校验拒绝

此假设未经 production 证据证实，不能归为生产缺陷。原 fixture 手工制造 epoch=0 的 RED/GREEN 不足以证明可达性，speculative parser 修改与对应测试已一致撤回。

R7 实跑 `var/upgrade/trace/t11b1-steer/run-r7b/launcher.log` 得到 owner-read/runtime-read `unknown_run`，identity={}; intent 缺 rootSessionId/ownerGeneration。没有观测到 epoch=0。

权威修正诊断与后续修复见 `docs/bugs/2026-09-28-generic-run-owner-receipt.md`。不得从本文件推断 runtime epoch 的合法域或升级验收 PASS。
