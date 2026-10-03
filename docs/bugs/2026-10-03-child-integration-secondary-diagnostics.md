# child integration lifecycle secondary failure diagnostics

合法 managed child 生命周期在 proof 查询、preserve debt 写入或 shutdown inspect 失败时原本仅保留 fail-closed/权威 durable 状态，丢失原始异常。修复只向既有 trace 注入 error/cause，不改变 proof 拒绝、生命周期存活或 preserve 判定。
