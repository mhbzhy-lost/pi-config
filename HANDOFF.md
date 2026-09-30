# 升级会话交接文档（Handoff）

> 写于 2026-09-30（第三段：main-merge 完成 + 三缺陷收尾）。主仓编排会话 → 新仓续接会话（pi-new）。本段完成 `docs/plans/2026-09-30-main-merge-and-consolidation.md` 的 T1-T10。

## 你在哪

- 工作区：`~/pi-config-upgrade`（独立 clone，分支 `upgrade/pi-stack-0.87`）
- **main 已 merge 进来**（merge commit `fcc43a6`，双父 `93b00b3`+`0b59878`），76 冲突路径分层解完，工作区干净
- `pi/settings.json` 已从 index 移除、磁盘保留（随主仓 fed4655 模板机制）
- 入口命令 `pi-new` 已就绪；本仓侧环境泄漏已修复（见 Bug E）

## 升级状态一句话

**pi core 0.87.1 × pi-subagents 0.71.0 升级本体 + main merge（v2 dispatch 合同 × 0.71 运行时）全部完成；静态门禁 933/0 全绿；三项遗留缺陷中 T7/T8 已诊断定性（均非 merge 引入、非生产缺陷）并登记，T9（terminal-proof 语义）待用户 (a)/(b) 裁决、暂 suspended；仅剩后续切换阶段（原 T12 第三段）待三段授权。**

## 本段（第三段）完成：main-merge + 三缺陷收尾

| 任务 | 状态 | 提交 / 证据 |
|---|---|---|
| T1 工作区分组提交（代码/文档两笔，排除 settings） | ✅ | `f41234a`、`93b00b3` |
| T2 fetch+merge+批量取侧+僵尸清理 | ✅ | merge `fcc43a6`（B25 theirs/C29 ours/4 modify-delete/2 僵尸删除） |
| T3 A 类生产交织（extension.ts 29 块）+ T5 doctor v2 迁移 | ✅ | 并入 `fcc43a6`；typecheck 双绿 |
| T4 A 类测试交织 + 真实 Host 夹具迁移 | ✅ | `fcc43a6`、`7ee6ef3`、`115f3e8` |
| T6 全量门禁收口 | ✅ | `7ee6ef3`（npm test 933/0） |
| T7 resumed-child 诊断 | ✅ 定性 | `e3df534`；upstream 扩展传播缺陷，非 merge 引入 |
| T8 session-owner PTY 诊断 | ✅ 定性 | `13d2806`；夹具时序脆弱，非生产缺陷 |
| T9 terminal-proof 裁决 | ⏸ suspended | 待用户 (a)/(b)；集成门禁保持 PENDING-ADJUDICATION |
| T10 HANDOFF + 收尾 | ✅ | 本文件 |

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

## 静态门禁状态（merge 后新基线，2026-09-30）

npm test **934tests/933pass/0fail/1todo**（TMPDIR=/tmp）· typecheck:root ✓ · typecheck:subagents-enhanced ✓ · verify:subagents-enhanced ✓（controlled 1207 文件对齐 registry）· 真实 Host focused：project-workflow 2/2、session-owner-install 3/3、notification 2/2、runtime 3/5（attention 双测受决策项 #3 影响）。

集成门禁 `test:all-integration` 保持 4 显式排除（均已精确诊断）：pi-subagents-runtime（WIRED-ELSEWHERE）、resumed-child（DIAGNOSED-UPSTREAM）、session-owner-runtime（DIAGNOSED-FIXTURE）、terminal-proof-handoff（PENDING-ADJUDICATION，待 T9 裁决）。**最终完整 integration gate 待所有子任务收口后一次性重跑（用户指示，避免重复全量循环）。**

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
11. ~~两项待专项诊断的集成测试失败面~~（**已诊断定性，2026-09-30**）：(a) resumed-child——根因为 upstream pi-subagents@0.71 runs.run leaf→step 丢弃 subagentOnlyExtensions，child 不加载 integration-queue 扩展→队列恒空；非 merge 引入，修复归属 upstream（docs/bugs/2026-09-30-resumed-child-integration-extension-propagation.md）。(b) session-owner-runtime 三 PTY 用例——夹具时序脆弱（2 独跑通过、SIGKILL 接管超 60s 预算）；守卫/ESRCH 逻辑正确、merge 仅附加审计日志，非生产缺陷（var/upgrade/t8-session-owner-pty-diagnosis.md）。注：resumed-child 是 auto-integration 恢复续跑（child 退出后自动收尾），与控制面手动 resume 无关，后者使用正常。
12. **terminal-proof-handoff 语义裁决（待用户，T9 suspended）**：跨 owner scope 的 unresolved binding 被 not-applicable 吞没 vs 应记 proof debt——二选一：(a) 修生产（classifyTerminalProofBinding 跨 scope 复查→recordDebt，符合“失败不静默”哲学，主会话倾向此项）；(b) 认定 not-applicable 为有意语义改测试期望（var/upgrade/orphaned-integration-triage.md 第 4 节）

## 后续切换阶段前置条件（原 T12 第三段，届时需用户三段授权）

1. ~~**提交整理**~~（已完成：T1 两笔 + merge 后逐任务提交，工作区干净）
2. ~~**基点对齐**~~（已完成：main 已 merge，76 冲突解完，静态门禁 933/0）
3. **merge + init-pi.sh**：合回主树 → 全局安装 0.87.1 → shell/skills/Basic Memory 同步（待三段授权）
4. **待用户裁决**：T9 terminal-proof (a)/(b)；裁决后解除对应集成门禁排除并重跑完整 gate

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
