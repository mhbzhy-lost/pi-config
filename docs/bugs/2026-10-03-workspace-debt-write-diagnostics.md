# workspace debt 二次写入失败缺少诊断

合法 workspace allocation/discard/disposition/release/reconcile 失败时，主错误继续抛出且 fail-closed，但 markDebt 的二次失败原本被空 catch 丢弃。增加 diagnosticSink 携带 primary/secondary error 与 cause，不改变主错误和 durable 状态判定。
