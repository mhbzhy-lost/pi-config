/**
 * 「拒绝码 → next 指引」唯一权威表（Phase B / INV-EXIT）。
 *
 * 新增 MANAGED_WORKSPACE_* 拒绝码必须同变更补一条，不得留下只能看到「为什么不行」
 * 而看不到「下一步去哪」的回执。本表只补文案，不参与任何判定；各站点可用 next
 * 参数覆盖为更精确的语义（同一 code 多语义时不猜）。
 *
 * 放在独立模块而不是 service.ts：`git-worktree.ts`（底层，被 service 依赖）与
 * `service.ts`（上层）都要用同一张表，独立模块避免双向 import，也避免第二份表结构。
 */
export const MANAGED_WORKSPACE_NEXT_ACTION: Record<string, string> = {
  MANAGED_WORKSPACE_OWNER_SCOPE: "以当前 Host session 的 root session 身份调用（owner scope 只来自 runtime，不接受工具参数）；不属于该 session 的 workspace 必须由所属 session 处置。",
  MANAGED_WORKSPACE_TERMINAL: "用 status 或 coordinator 的 durable 事实（run.asyncDir 下官方 process-terminal.json）重建 7 字段权威证明后重试，不要伪造 proof 或手工改 ledger。",
  MANAGED_WORKSPACE_EXPECTED_HEAD: "重新 status 取当前 HEAD 与 action_token 后按新快照操作；HEAD 已漂移时先确认变更来源。",
  MANAGED_WORKSPACE_ACTION: "重新调用 status/issueDisposition 取得本次的 action_token 与 snapshot 后再操作；token 一次性，不得复用、不得跨动作使用。",
  MANAGED_WORKSPACE_DISPOSITION: "按 status 返回的 allowed_dispositions 选择动作；preserve 必须带非空 reason，integrate 仅支持 rebase-ff。",
  MANAGED_WORKSPACE_BINDING: "以 workspace 记录（status/readOwned）的 leaseId/runId 为准核对调用参数；身份不一致属越界调用，不要重试同一 binding。",
  MANAGED_WORKSPACE_RUN: "run binding 必须恰好 {runId, asyncDir}；recovery 重绑必须携带已授权的 resume intent，普通 bind 不改已绑定身份。",
  MANAGED_WORKSPACE_RUN_CONFLICT: "workspace 已绑定到另一个 run：续跑请走 recovery 重绑（带 resume intent），否则按新合同 fresh 派发新 workspace。",
  MANAGED_WORKSPACE_CAS: "workspace 在本次操作期间被改动：重新 status 取新快照与 token 后重试；不要绕过 CAS 直接写 ledger。",
  MANAGED_WORKSPACE_SCHEMA: "检查写入的 disposition/ledger 结构版本，按当前 schema 重新构造；未知 schema 保持现场上报。",
  MANAGED_WORKSPACE_POLICY: "publication/application 策略由派发合同决定：按合同重新派发，或改用 discard/preserve/release 处置。",
  MANAGED_WORKSPACE_RECOVERY: "先用 service.reconcile 或 coordinator 结算既有 prepared disposition 收口，再发起新动作。",
  MANAGED_WORKSPACE_WRITE_PATHS: "确认越界文件是否属派发合同漏声明的合法产物：是则在 dispose(integrate) 显式携带 additionalWritePaths 补授权；否则丢弃越界改动。",
  MANAGED_WORKSPACE_INTEGRATE: "以 status 的 allowed_dispositions 与 integrate_blocked_reasons 为准，先修 origin/workspace 干净与 HEAD 同步后重试；身份不符不要手工改 intent，交给 service.reconcile 收敛。",
  MANAGED_WORKSPACE_ORIGIN_DRIFT: "origin 已被推进或切到别处：按当前 origin HEAD 重新 status/issueDisposition 后再操作，不要强推。",
  MANAGED_WORKSPACE_ORIGIN_DIRTY: "origin 工作区不干净：由人工确认改动归属并清理后再重试；本层不自动 stash/reset。",
  MANAGED_WORKSPACE_IDENTITY: "Git worktree 身份（路径/分支/HEAD/注册）与 ledger 记录不一致：保留现场并人工核对，不要重建 workspace 或强推。",
  MANAGED_WORKSPACE_ERROR: "把错误码与现场（workspace_id、phase）一起上报，按 stop condition 等待决策，不要盲目重试。",
  // ── git-worktree.ts 直接抛出的拒绝码（GAP-2：Phase B 只覆盖了 service 路径）──
  MANAGED_WORKSPACE_REBASE: "managedRebase 的前置身份或工作树事实不满足：保留现场核对 worktree 注册/分支/HEAD 与冲突状态，用 managed_workspace_status 查看允许动作后在归属 workspace 内解决冲突再 continue，不要手工 abort/reset 或强推。",
  MANAGED_WORKSPACE_GIT: "按 category 定位 git 拒绝的真实原因（locked/sequencer-in-progress/path-missing/unmerged-entries/dirty 等）：先消除该状态再重试，不要用 -f、--abort、stash 或手改 .git 绕过。",
  MANAGED_WORKSPACE_LOCKED: "worktree/index 已被锁或被占用：确认无并发 git 进程后清理残留锁文件，再重试；不要强删正在被使用的锁。",
  MANAGED_WORKSPACE_SEQUENCER: "已有 merge/cherry-pick/revert/sequencer/rebase 现场：先确认该现场归属并显式收口（continue 或人工 abort），本层不会自动清理。",
  MANAGED_WORKSPACE_DIRTY: "工作区有未提交或未跟踪改动：先确认改动归属（child 产物还是残留），提交或清理后重试；本层不自动 stash/reset。",
  MANAGED_WORKSPACE_CONFIG: "仓库本地 Git 配置不安全（executable hook、.gitattributes 变更等）：由人工确认来源并移除后再重试，不要在受管 worktree 内放宽配置。",
  MANAGED_WORKSPACE_QUEUE: "队列 admission（lease/generation/状态）与本次推进不一致：以 queue.audit 的最新 lease/generation 为准重新取号后重试，不要跨 lease 强推。",
  MANAGED_WORKSPACE_APPLY_CONFLICT: "候选应用出现真实冲突：按冲突文件就地解决并提交，或改用 preserve 后人工处置；不要强推覆盖 origin。",
  MANAGED_WORKSPACE_REF_CAS: "目标 ref 在操作期间被推进：重新取 origin HEAD 后重跑集成/发布，不要用 force 覆盖他人提交。",
  MANAGED_WORKSPACE_TARGET: "目标 HEAD 与 admission 记录不一致：重新 status 取当前 target 与 workspace HEAD 后按新快照操作。",
  MANAGED_WORKSPACE_UNSUPPORTED_STATE: "workspace 处于本操作不支持的状态：先 status 读取 state 与 allowed actions，按允许动作收口后再重试。",
  MANAGED_WORKSPACE_CLEANUP_DEBT: "回收处于 cleanup-debt：用 release 重试回收，持续失败需人工处理 worktree 目录与注册。",
};

/**
 * 把 next 指引拼进拒绝文案（`<message>; next: ...`）。
 * 已有 `next: ` 的文案不重复追加（内层错误已带指引时外层只透传）。
 */
export function withManagedWorkspaceNext(message: string, code: string, next?: string): string {
  const guidance = next ?? MANAGED_WORKSPACE_NEXT_ACTION[code];
  return guidance !== undefined && !message.includes("next: ") ? `${message}; next: ${guidance}` : message;
}
