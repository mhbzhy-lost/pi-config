# Subagent facade 未暴露既有 resume control

## 现象

上游 supervisor 已支持 `interrupt` 后以新指令 `resume`，工具恢复提示也会要求调用 resume；但项目 owned facade 的 control action allowlist、schema 与说明只暴露 `status/steer/interrupt/stop`。因此调用者按恢复提示执行时会在进入 RPC 前收到 `UNSUPPORTED_ACTION`，已暂停但可恢复的 child 无法继续。

## 影响

这是既有控制能力的接线缺口，不是新增调度语义。它会让 intervention/recovery 路径无法闭合，并迫使调用者停止原 run 或另派任务。`stop` 后仍不可恢复；resume 必须携带非空新指令。

## 修复边界

项目 facade 仅新增对上游既有 `resume` RPC 的透传，并在 RPC 前拒绝缺失或空 `message`。不改变 spawn、status、steer、interrupt、stop、workspace lifecycle 或 Goal Engine 语义。
