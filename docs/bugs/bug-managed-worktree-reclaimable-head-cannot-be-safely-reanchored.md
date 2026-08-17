# 受管 worktree reclaimable HEAD 无法安全 reanchor

Bug：失败任务为清理脏目录创建 checkpoint 后，manifest/branch HEAD 漂移，后续 cleanup receipt 的绑定 HEAD 不再匹配。

复现：将 reclaimable managed worktree 提交到 checkpoint，再以原 cleanup HEAD 执行 release/discard。

修复：owner-token CAS、allocation id 与 expected HEAD 共同校验后，先持久创建 recovery ref，再只把干净、身份完整的受管 worktree 回退至其祖先 target，并原子更新 manifest。
