# Plan Runner 退役验证摘要

## 结论

Plan Runner 已从 `main` 的可部署产品表面、共享 runtime 协议、配置、Skill、测试夹具和现行专属文档中移除。Goal Engine、typed subagent、Root 直属 Executor ownership、原生 Supervisor、Root close 与可重试清理继续保留。累计差异完成两轮独立复审及后续 TDD 修复，当前判定为 **production-ready**。

## 存档与远端历史

- 移除前存档：`archive/plan-runner-before-removal-20260805 → 61ab540b4c454916af60c744893e20f1767dfc03`。
- 独立历史候选：`fix/plan-supervisor-bound-wake → 02c4151c4a46156862c3fcc009d70234bbdc95b9`，未合入 production。
- `origin/main` 的原四个配置提交已通过 `f490312` 纳入；执行期间新增的 `e8b7869` 又通过 `9877644` 合入。
- 新增远端配置冲突按既定边界解决：保留 DeepSeek 默认值和自定义 Provider 模型，同时继续移除退役 Todo package。
- 最终部署只允许普通 push，不使用 force push；archive ref 与 `main` 在本摘要提交后推送并在远端复验。

## 删除边界

已删除：

- `pi/agents/plan-runner.md`、`pi/agents/plan-reviewer.md`；
- Plan launcher、runner、capsule extensions；
- `scripts/lib/plan/**` 与 `plan-runner-dispatch` Skill；
- `plan_run`、`plan_attention_reply`、Plan caller/follow-up/revival/Plan Supervisor 路由；
- Plan 专属 Goal Contract state、fixtures、tests、plans、architecture、audit 和 handoff 文档；
- `setup:plan-runtime` 及 Plan Doctor/config 公开面。

对 `README.md`、`package.json`、`init-pi.sh`、`pi/`、`scripts/`、`skill-overrides/` 扫描以下生产标识无命中：`plan-runner`、`plan_executor_supervisor`、`plan_run`、`plan_attention_reply`、`setup:plan-runtime`、`scripts/lib/plan`、`/plan-run`。

## 保留边界

- Goal Engine 精确七工具 ABI 与事件、workspace、Git、审计、并发存储实现；
- `pi-subagents@0.37.2`、`typebox@1.1.38`、`.pi-subagents/` 与 `/var/` ignore；
- `setup-subagent-runtime-deps.mjs` 通用安装入口；
- Root Broker 的 direct Executor grant、birth identity、订阅、official terminal proof、Root close、强制清理与 retry debt；
- 项目 typed `subagent`、原生 `subagent_supervisor` 和通用 Supervisor adapter；
- Goal/shared runtime 历史材料及本次退役计划；
- TokenRec 的 recovery refs、attempt-1 lease/worktree/branch 均未由本会话修改或处置。

## TDD 与复审

- Round 1：无 Critical；发现 listener 部分注册失败泄漏，以及一项 transport retry 风险。
- TDD 修复 listener 泄漏：先记录 `docs/bugs/bug-root-broker-startup-listener-leak.md`，观察 RED，再最小 GREEN。
- Round 2：确认 listener 核心泄漏已修复；证明 transport retry 永久卡死为误报，但发现启动回滚错误覆盖原错及活跃 socket 阻塞两个衍生风险。
- 按同一 bug 根因扩展 tests-only RED，随后修复原错保留、已接入连接关闭和 transport 回滚；聚焦测试最终 53/53。
- 同一累计差异已用满两轮独立复审上限，不运行第三轮；Round 2 后发现有明确证据的风险已由主代理完成 TDD 修复和全套回归。
- 两轮均为 0 Critical；最终不存在已知未处置的 Critical/Important。

## 验证结果

| 范围 | 结果 |
|---|---|
| Goal Engine 冻结回归 | 310/310 通过 |
| using-goal-engine Skill/discovery | 28/28 通过 |
| Plan 移除、deterministic provider、Root Broker/RPC/runtime 聚焦回归 | 53/53 通过 |
| Root Broker 启动回滚专项 | listener、原错保留、活跃 socket 三项通过 |
| `npm run doctor` | 通过；仅两条既有已知限制 warning |
| 真实 Pi Skill integration | 1/1 通过 |
| 真实 pi-subagents integration | 3/3 通过 |
| 真实 Root Broker startup integration | 1/1 通过 |
| `npm test` | 769 项：768 通过、1 失败 |
| 远端新增配置提交聚焦回归 | 38 项：37 通过、同一既有项失败 |

唯一全仓失败为：

`installed launch arguments keep project child agents outside fanout hierarchy`

原因是只读 unit suite 运行前不存在安装期生成文件 `.pi-subagents/root-session-owner-entry.mjs`。真实 Root Broker startup integration 会创建并验证该入口且已通过；该失败在本次退役前已存在，不由 Plan Runner 删除或最终 Broker 修复引入。

## 用户文件与本地资源

- 用户 `pi/settings.json` 已从固定 stash `183567f037a61b5fdcf78e93d27a9c8ebb2f0002` 恢复。
- 恢复后 SHA-256：`7b9c3ace7929e9c3a3e13dfb024188f55a619089f002fa754083971e60559adf`。
- 该文件保持为未暂存本地修改，不进入任何退役、合并或验证提交。
- `skill-overrides/aliyun-beijing-server/` 由本仓库 `.git/info/exclude` 的 `/skill-overrides/aliyun-beijing-server/` 规则本地忽略；目录内容未修改、未暂存、未提交。
- 固定 settings stash 暂时保留为额外恢复证据；未创建其他 stash。

## 最终判定

**Production-ready：是。** Plan Runner 已无 production launch path；Goal Engine exact-seven、typed subagent、Root Broker 与 Supervisor 保留面均通过定向和真实 Pi 验证。剩余单项 unit failure 有明确的安装期前置条件和通过的真实集成证据，不阻断普通推送。
