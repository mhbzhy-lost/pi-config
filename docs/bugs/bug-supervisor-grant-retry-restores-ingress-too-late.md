# Bug：Supervisor grant 重试开始后仍保持 ingress revoked

## 症状

Supervisor pending GREEN用 `supervisorIngressRevokedRuns` 区分生命周期owned run和路由资格。首次grant失败会正确加入revoked集合，但后续 `ensureExecutorOwner()` 新attempt只有在writeGrant成功后才删除revoked。

如果重试grant处于pending，Executor已经重新建立principal，却仍被route判定为unknown；Supervisor request不能像首次owner绑定窗口一样有界暂存。

## 影响

真实spawn重试期间Executor可能在grant写入完成前启动native Supervisor channel。此时request被明确拒绝且native seen-file不会重发，会重现A2原始永久丢失，只是发生在recovery/retry路径。

这也使“失败后撤销、合法重试恢复”只有成功后恢复，弱于已批准合同中的attempt-start语义。

## 复现

1. 可信started observation的首次Executor grant受控失败，确认run进入revoked且迟到request被拒绝。
2. 启动第二次 `ensureExecutorOwner(runId)`，让writeGrant停在deferred gate。
3. 等新principal已建立后、grant promise未结算时发送同requestId的新payload。
4. 当前实现仍返回 `supervisor_request_unknown_owner`，pending与reservation为零。

## 根因

`supervisorIngressRevokedRuns.delete(runId)`位于writeGrant成功分支和已有Executor principal分支，而不是新合法grant attempt的开始点。新attempt设置principal后到writeGrant完成前仍保留旧失败状态。

资格状态没有与 `executorGrants` single-flight的新generation同步转换。

## 修复

在确认没有既有grant single-flight、且不存在非Executor principal冲突后，于创建新Executor principal/writeGrant之前删除revoked。这样新attempt的owner绑定前窗口可暂存request。

若writeGrant或post-grant close fence失败，既有catch必须重新加入revoked并释放该attempt期间积压的pending/reservation/context；已有非Executor principal冲突不得误删principal或恢复资格。

## 验证

扩展started grant失败测试：第二次grant使用deferred gate，在principal建立但grant未完成时发送同requestId的新payload，必须入队并保留retry context；释放gate后ensure成功，队列仍待后续owner promotion。

当前production应在该中间状态返回unknown而RED；最小GREEN后与owner/promotion/close及完整Root Broker suite共同通过。
