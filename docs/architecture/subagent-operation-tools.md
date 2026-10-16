# Subagent 独立操作工具

## 工具面

fresh Host 的 main model-visible 工具拆为14项：

- `subagent_roster`
- `subagent_start`
- `subagent_run_status`
- `subagent_run_steer`
- `subagent_run_interrupt`
- `subagent_run_resume`
- `subagent_run_stop`
- `managed_workspace_list`
- `managed_workspace_status`
- `managed_workspace_dispose`
- `managed_workspace_release`
- `supervisor_request_pending`
- `supervisor_request_status`
- `supervisor_request_reply`

旧的 `subagent`、`subagent_worktree`、`subagent_supervisor` 不再作为 fresh Host 的模型工具注册。历史session中的旧toolCall仍按历史名称显示，不重写raw/session；上游通知中的旧调用示例同样是历史文本，不代表新schema。

`subagent_start`仍是一个启动语义，generic/coding由既有typed compiler按`writePaths`确定，不拆成两个调度器。run/workspace/supervisor工具都是薄factory：继续复用原dispatcher、workspace service、supervisor adapter、owner/CAS、terminal proof、receipt和G2 child gate。工具schema不能替代runtime guard。

## 权威与安全

- 所有14个工具是`model-only`，不能被codemode或其它工具间接调用。
- child runtime保持early-return和agent `tools`白名单，不因main工具拆分扩展child权限。
- workspace `action_token`只能来自本次`managed_workspace_status`；coding child-owned integration仍返回`CHILD_OWNS_INTEGRATION`，generic能否integrate以实时状态为准。
- supervisor `queued`只代表提交，不代表消费；reply/steer仍经过G2 owner、request、child、TTL和幂等门禁。
- `supervisor_request_pending/status/reply`不包含inspect/clear。由于上游pending absence存在静默漏检，C1/C2/C3 clear路径保持blocked，不以空数组签发清理token。
- resume保留新run/非原进程就地续跑/stopped不可resume前提；不实现`resume(model)`换模。

## 引导归属

操作对象、必填字段和实时权威在各工具description；跨操作的治理、授权、恢复顺序和安全政策仍在`pi/AGENTS_GLOBAL.md`与`pi/AGENTS_SHARED.md`。workspace completion reminder不再给出无条件`integrate or discard`，而是指向实时status和child-owned边界。TUI renderer按工具名映射operation，历史旧名仍可显示；raw arguments、details、session和上游通知不被改写。

## 验收

S1/S2/S3 factory分别通过13/13、11/11、12/12；G1 40/40；G2 173/173；S5 179/179。S6组合聚焦回归最终**492/492**，root/package typecheck、offline verify、diff check通过。fresh synthetic SDK probe `/tmp/s6-operation-probe.json`（测试自造session，不读取用户配置）确认14名全部model-only、旧三名不active、nested不可调用、两个操作smoke成功；UTF-8字节只作结构基线，不声称token节省或模型选择收益。

provider真兼容、真实CLI/TUI旧integration fixture迁移尚未声称全覆盖；旧ceiling-runtime和resource-isolation失败保持既有缺陷分类。外部models备份未读取、未提交、未删除。
