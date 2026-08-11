# 未绑定 Goal 的审批 session transfer 被错误拒绝

## 问题

事件 schema 明确允许 `goal.session_transferred.data.fromSessionId` 为 `null`。`buildTransferChallenge` 对历史上没有 session binding 的 projection 也会生成 `fromSessionId: null` 的审批转移事件。

但 projector 在应用该事件时仍会查找 source binding。历史未绑定 Goal 不存在该 binding，因此已通过显式 challenge、用户批准和 token 的安全转移会被 domain error 拒绝，无法完成首次 owner binding。

## 修复原则

`fromSessionId: null` 且当前 `ownerSessionId` 也为 `null` 表示没有历史 owner binding：不查找或修改 source，直接新增目标 session 的 `watching` binding。非空 source 仍必须与当前 owner 一致、保留 source 审计，并在缺失时 fail closed；不得允许 owner mismatch。
