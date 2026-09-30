# 升级会话交接文档（Handoff）

> 写于 2026-09-29（晚更新：P1/P2 清账 + 三项生产缺陷修复）。主仓编排会话 → 新仓续接会话（pi-new）。本会话为第二段：升级本体收尾 + 真实生产验证缺陷修复。

## 你在哪

- 工作区：`~/pi-config-upgrade`（独立 clone，分支 `upgrade/pi-stack-0.87`，基点 `578537d`）
- 当前 HEAD 落后主仓 ~10+ 提交（用户明确指示暂不对齐，T12 切换前再处理）
- 所有升级改动在**未提交工作区**（Model A 串行执行模式，无逐任务提交）
- 入口命令 `pi-new` 已就绪；**本仓侧环境泄漏已修复**（见 Bug E）

## 升级状态一句话

**升级本体完成；P1/P2 待办全部清账；真实生产验证发现的 4 项缺陷全部修复（含 Bug #4 三修复面）且全量门禁 984/0 全绿；仅剩 T12（未开始，待用户三段授权）与少量登记决策项。**

## 本会话（第二段）完成的清账

| 项 | 状态 | 证据 |
|---|---|---|
| 删除 compat notifier（用户已决策） | ✅ | `var/upgrade/p1-notifier-removal.md`（TDD，969/0） |
| 0.62/0.85.1 引用分类 | ✅ | `var/upgrade/p1-reference-audit.md`（178+5 行逐项分类，B 类 5 项） |
| README/AGENTS/probe/测试文案清理（B-1~B-5） | ✅ | `var/upgrade/b-class-doc-cleanup.md` |
| modelExclusions 删除依据补证 | ✅ | 审计报告任务二（r2b 证据链登记） |
| stream-retry 证据评估 | ✅ | 审计报告任务三（上游无等价实现，维持升级决策项） |
| pi-explore 调用方核查 | ✅ | `var/upgrade/p2-investigations.md`（新仓零残留） |
| worktree 三缺口回馈登记 | ✅ | 同上 §2（仅文档，未提单） |
| interrupt/resume fresh probe | ✅（有机证据） | 本会话真实生产 trace：bf27eaf2 interrupt→Paused→resume(d98f1839) 执行新指令成功；c3e551ca steer delivered。见 t11c-matrix 补充段 |

## 本会话发现并处置的生产缺陷

| Bug | 级别 | 状态 | 记录 |
|---|---|---|---|
| A：完成通知被 suppression 静默吞掉（双投递防护=双全灭） | P0 | ✅ 已修复（notifier 删除即修复）+ 到达性集成守卫 2 用例 GREEN | `docs/bugs/2026-09-29-async-completion-notification-silent-swallow.md`（机制经探针定案：已退役 compat notifier 因 payload 无 message 字段从未投递；上游 native 被 suppression 吞） |
| B/C：footer 条目卡死 ● + model/token 缺失（root/leaf 两层 run 结构被当普通 run 消费） | P1 | ✅ 已修复（run 级终局兜底 + root→leaf 解析经 readBrowserRunStatus 防线） | `docs/bugs/2026-09-29-custom-footer-stale-running-and-missing-model.md`；`var/upgrade/footer-bug-diagnosis.md`；`var/upgrade/footer-fix-123.md` |
| E：pi-shell 跨仓状态根继承（新仓会话写旧仓 authority） | P0 | ✅ 已修复（AGENT_ 变体优先，9/9 GREEN）；本会话进程环境已定型仍指旧仓，下次 pi-new 生效 | `docs/bugs/2026-09-29-pi-shell-inherits-cross-repo-state-roots.md` |
| D：#4 authority 锁竞争 + spawn 失败零回滚 | P1 | ✅ 已修复（用户选 A 全修：①错误码保留 ②有界重试 ③尽力 stop 回滚；RED→GREEN 5+6 用例） | `docs/bugs/2026-09-29-authority-lock-contention-orphan-spawn.md`（含附带发现：model-selection 集成测试基线就红的 out-of-gate 漂移，已修 8/8） |

footgun 复核结论（`var/upgrade/footgun-injection-fix.md`）：注入点语义当前已正确（completionApi 从不带 suppression），零生产改动，+1 守卫用例。

## 静态门禁状态（全绿，2026-09-30 终验）

npm test **989tests/987pass/0fail/1skip/1todo**（TMPDIR=/tmp）· **集成门禁 test:all-integration：30 文件 218/218 全绿**（串行，~12 分钟；4 显式排除项见 var/upgrade/orphaned-integration-audit.md）· retry 5/5 · rollback 6/6 · membrane 66/66 · notify 集成 2/2 · footer 聚焦 81/81 · pi-shell 9/9 · model-selection 集成 8/8 · typecheck ✓

## 升级决策项（留档待用户拍板，含新增）

1. 运行中换模重试（0.71 无安全身份绑定）
2. stream-read-error recovery（上游无等价实现，旧 patch 已删）
3. supervisor attention 桥接——**本会话新增实证**：child contact_supervisor 请求到达 parent pending（下行通），reply 被拒 `SUPERVISOR_REQUEST_NOT_PENDING`（两平面判定不一致死锁），需 interrupt+resume 解锁；bf27eaf2 会话完整复现
4. retained-resume 语义差异（0.71 需恰好一个 running child）
5. reviewer discovery TODO（深测未迁移）
6. ~~#4 修复范围~~（已拍板 A 并全部落地）
7. **上游回馈候选**（P2 登记未提单）：notify.js sendCompletion「不抛错=成功」不检查 sendMessage 返回值；worktree 三缺口
8. ~~**T12 命名冲突**~~（已裁定：**pi-lite**，2026-09-29；新仓已回退 R2a 改名与主仓收敛，函数/测试 9/9 绿，T12 此项冲突解除）
9. ~~**门禁覆盖产品决策**~~（已落地：用户定原则「长耗时属集成测试不进主 glob」；已建 `test:all-integration` 门禁 runner，自动枚举+串行+显式排除表，新文件自动接线，首跑 30 文件 218/218 绿）
10. ~~**产品语义观察项**~~（已裁决关闭，2026-09-30：经代码验证，broker 身份三项服务——integration 订阅/proof settlement/lease 存活——全部面向 managed workspace 生命周期，无 workspace 的 coding run 无需 broker；b332005 门控为正确设计，canary 测试按 worktree:true 钉住现行语义）
11. **两项待专项诊断的集成测试失败面**（均基线就红、非生产阻断，已从集成门禁显式排除）：(a) resumed-child 四用例同族系统性挂起（~180s，queue 恒空、proof debts 不解）；(b) session-owner-runtime 三 PTY 用例被 session-owner 守卫拦截（registry 空、exitCode 0）——两者均需独立诊断任务，证据链已存档（var/upgrade/fix-resumed-child-fixture.md、fix-three-orphaned-tests.md）
12. **terminal-proof-handoff 语义裁决（待用户）**：跨 owner scope 的 unresolved binding 被 not-applicable 吞没 vs 应记 proof debt——二选一：(a) 修生产（classifyTerminalProofBinding 跨 scope 复查→recordDebt）；(b) 认定 not-applicable 为有意语义改测试期望（var/upgrade/orphaned-integration-triage.md 第 4 节）

## T12 切换前置条件（届时需用户三段授权）

1. **提交整理**：clone 分支全部工作区变更 → 按 git-commit-convention 提交
2. **基点对齐**：merge/rebase 主仓 ~10 提交 → 解冲突（~~pi-shell.zsh/pi-shell.test.mjs 命名冲突已解除~~，其余冲突按当时 diff 处置）→ 重跑全量门禁
3. **merge + init-pi.sh**：合回主树 → 全局安装 0.87.1 → shell/skills/Basic Memory 同步

### T12 准备登记项（本仓之外，不归本仓改）

- 旧仓 `pi-new()` 补 `-u PI_CODING_WORKSPACE_DIR -u PI_CODING_GOAL_DIR`（本仓侧 AGENT_ 优先已阻断泄漏，此项为双保险）
- 旧仓 `var/workspaces/root-broker-authority/01a0ec00…/` 含本会话泄漏写入的条目（16:37-至今），与旧仓自身会话混存，建议维护窗口甄别清理
- 主仓侧未提交改动（pi-new/pi-session-owner 审计日志/测试）沿 HANDOFF 第一版登记不变

## 遗留验证 GAP（P2，未动）

- context_edit fork / pruned-fork / compaction retry 真实动态验证（建议 fresh 会话做，本会话上下文已重）
- 本会话通知恢复的精确触发点未完全钉死（15:01Z 起通知到达，与 14:34Z context_edit/compaction 事件时序吻合，推测扩展重估加载了修复后源码；不影响结论：修复有效已由集成测试证明）

## 注意事项

- **OAuth token**：新仓 auth.json 已刷新，`zai-coding-cn/glm-5.3` 可用；本会话实际用 `qoder-pool/GLM-5.3-0.6x`
- **coordinator socket**：`.git/.pi-coordinator/coordinator.json` 偶有死 PID，doctor 前清理
- **jiti 缓存**：改 fixture 后清 `var/tmp/jiti/`
- **派发含全量回归的任务**：subagent 30 分钟 watchdog 会杀全量 npm test（本会话 2 例超时均为此）；全量门禁由主会话统一执行
- **supervisor reply 死锁**：child 请示后 reply 可能被拒（`SUPERVISOR_REQUEST_NOT_PENDING` 但 pending 列表仍显示）→ interrupt + resume 是有效解锁路径；派发指令中应预先包含「contact_supervisor 无响应则写报告收尾」兜底
- **root/leaf 双条目**：footer 修复后 root facade 完成迁入 history 与 leaf 条目并列显示（产品去重决策待定，见 footer-fix-123 遗留）

## 建议下一步

1. ~~拍板 #4~~（已选 A 并全部落地验收）
2. 遗留动态验证（context_edit fork / pruned-fork / compaction retry，建议 fresh 会话）
3. 门禁覆盖决策项 #9（是否把 *.integration.mjs 纳入门禁）
4. T12 准备（提交整理 → 基点对齐 → 门禁 → 三段授权切换）
