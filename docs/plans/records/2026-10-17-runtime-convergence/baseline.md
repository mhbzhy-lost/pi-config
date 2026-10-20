# Inline 执行基线

用户已明确选择 Inline，并要求持续推进全部剩余任务。执行不另派 subagent、不自动追加 review、不提交或推送。测试编写/fixture 行为修改仍待具体授权；已有纯检查和类型检查可运行。

- HEAD：`92b0302`；执行前 index 为空。
- 保护现场：`.pi/handoff/context-handoff.md`、`pi/crashes.json`、`pi/models.json.bak-qoder-thinking-20261016161901`；后两者不读正文。
- 已有代码增量：`src/background-activity/layout.ts` 的 footer 空行；保留，不覆盖。
- 既有规划增量：本计划、code_mode 报告、runtime 文本审计、首轮计划 review 与响应记录、managed workspace 整体审查。
- 已完成范围：runtime-closeout；S0–S6；G1/G2/G2-wire。根 HANDOFF 是旧升级历史，不据此重开已完成阶段。
- 未完成：H1/H2/H3、M1、文本政策清理、fixture 迁移、来源分类、fresh 验收与统一收口。
- blocked/deferred：R01 idle notification 用户暂缓；R02 triggerTurn 上游接口；R03 resume(model) 独立立项；R07 clear/inspect exact absence 不可证；R09 旧 heartbeat 根无合法出口。
- code_mode：14 项 model-only 工具不可发现符合合同，复用归档，不扩大 exposure。
- R04→T12；R05/R06/R07→T13；R08/R09/R10→T14；R11→T15；R12→T7/T8/T9；R13→T11；R14→T10；R15→T6。专项 F 项继续以统一账本和原专项记录为依据。
- M1→T5；M2/M3/M9→T6；M4→T6/T13，保留 scope-unverified fail-closed；M5→T10；M6→T11；M7→T16；M8→T17。
- 三项 High：来源是审查报告中的合法生产调用链；不声称已执行真实删除/队列事故重现。H1 的复合 ID 来自 Responses 官方 adapter；H2 的 bound release shortcut 来自 public service；H3 来自 coordinator queue 与 local service 处置分离。
- 本次旧工作区 `a8f3cdf0-fbca-4c19-abb3-f5971dedc750` 最新 typed status 为 active、terminal observed、origin-dirty；无已成功回收证据。源码修复不热替换本 Host，真实处置后置。
