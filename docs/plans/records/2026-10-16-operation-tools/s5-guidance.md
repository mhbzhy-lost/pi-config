# S5：独立操作工具引导迁移验收

## 交付

- 新工具 descriptions/guidelines补齐对象、必填与权威来源；resume保留新run/不可原地续跑/stopped不可resume；supervisor reply提交不等child消费。
- `workspaceNotice`与`completion-reminder`不再无条件建议integrate/discard，改为managed_workspace_status实时权威、coding child-owned、generic以状态返回为准；details/customType/delivery/去重/raw不变。
- AGENTS_GLOBAL示例迁移到`subagent_start`、`subagent_run_*`、`managed_workspace_*`、`supervisor_request_*`，保留治理/授权/恢复政策；新增旧→新映射及上游旧通知为历史raw声明。
- child边界采用保守“可用时contact_supervisor，否则报告阻塞事实并停止”，不为reviewer加权限；与runtime镜像的刻意差异已记录。
- bash_async只补clear_queue为Host/RPC侧非本工具参数；sleep合法载荷、retry/backoff、测试延迟、用户delay、scheduler_create例外保留。
- system-prompt override三处既有白名单未扩；TUI/raw/session/details未改。

## 验收

- `node --test test/operation-guidance-contract.test.mjs test/subagent-workspace-completion-reminder.test.mjs test/bash-async.test.mjs test/subagent-runtime-membrane.test.mjs test/system-prompt-override-policy.test.mjs`：exit0，**179/179**。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck`：root/package exit0。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run verify:subagents-enhanced`：exit0，1259 upstream files、156 import edges、1823 tarball files。
- `git diff --check`：exit0。

S5未修改历史docs/research、上游、settings/models/auth、integration fixtures；ceiling-runtime和resource-isolation既有失败不纳入本任务。外部models备份未读未动。
