# T6：Operation tools 与 Supervisor gate 文档证据收口

## 结论

文档已能区分五种状态，且没有把“文档补齐”写成 clear 能力完成：

| 状态 | 对应事实 |
| --- | --- |
| `gate-fixed` | G1/G2 child gate、queued 放行、失败重试已实现；本轮 wire focused（8 项）与 fresh CLI ask/managed 2 场景通过 |
| `clear-verified` | 无。C1/C2/C3 未实现，也没有任何 exact absence 证据 |
| `blocked-upstream` | exact absence 不可证、root 归属与 triggerTurn 稳定关联缺上游接口 |
| `synthetic-only` | fresh SDK 注册 probe、隔离 synthetic provider、deterministic fixture；不代表真实 CLI/TUI/provider |
| `not-run` | 真实 provider、全仓 `npm test`/`all-integration`、SIGKILL/危险进程实验、离线 package verify 本轮未重跑 |

## 事实

- 新增 `docs/architecture/supervisor-gate-recovery.md` 描述 gate 与恢复路径；`docs/plans/records/2026-10-15-supervisor-gate/acceptance.md` 已存在，本批不重写其历史数字。
- S6 的 492/492 保留为**历史报告值**：精确 24 文件清单确认不可还原（`/tmp/s6-operation-verified.log`、`/tmp/s6-operation-final.log` 为 TAP 输出，除失败项外不含文件路径；`/tmp/s6-operation-probe.mjs` 只是工具面 probe）。不重跑猜测清单，也不用本轮不同组合冒充等价。
- `pi/AGENTS_GLOBAL.md` 的“工具名索引”给出旧 union → 新 14 工具的一次性映射，并明确上游通知里的旧调用示例是历史 raw 文本、不构成新 schema。

## M9 H1-key `111/111` 证据跟踪

- 精确命令可还原：`docs/bugs/2026-10-14-required-child-session-identity.md:8` 记录 `node --test test/subagent-runtime-membrane.test.mjs`：exit 0、**111/111**，包含三项持久/非持久 required-child identity 用例。
- 状态表引用：`docs/plans/records/2026-10-15-runtime-closeout/acceptance.md:26`（`H1-key | verified focused | 111/111+package types0，110cc0e`）；`docs/todos/2026-10-10-runtime-followups.md:81` 亦记 “H1-key identity：111/111、package typecheck 通过”。
- 另有逐文件计数交叉证据：`docs/plans/records/2026-10-15-runtime-closeout/supervisor-diagnostics.md:120` 记录 membrane **111/111**（同槽六文件合计 142）。
- 本批未重跑该历史命令，也不改写历史数字；上述三处来源一致，因此 closeout 最终命令汇总未单列属记录缺口而非证据缺失。

## 边界

文档一致性只是文档一致性：clear/inspect 逃生口仍不存在，`pending=[]` 仍不能当 exact absence。
