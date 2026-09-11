# Finalization canonical managed-workspace receipt gap

终审 manifest 对 managed-workspace.v1 receipt 仍按 legacy `phase`/`released`/`executorHead` 字段校验，导致真实非空 runtime task 即使服务已产生 canonical released/integrate receipt 也永久阻塞。修复使 canonical public path 消费 receipt 的 state/disposition、owner attempt、Goal disposition receipt/service hash 与 settled verified executor head；legacy 字段仅保留 replay 兼容校验。
