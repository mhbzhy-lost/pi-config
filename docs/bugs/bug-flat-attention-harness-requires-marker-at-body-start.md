# Bug：flat Attention Harness 要求 marker 位于 body 首字符

## 症状

A2真实Harness在owner-binding GREEN后首次观察到两个Plan各2个、共4个 `waiting-attention` Attempt，但 `attentionMarker()` 对第一份durable body执行 `body.startsWith("PI_PLAN_FLAT_ATTENTION ")` 时失败。

真实native Supervisor body以“Subagent needs a supervisor decision.”开头，中间有唯一独立 `PI_PLAN_FLAT_ATTENTION {...}` 行，末尾还有reply提示。四份body均可从该行解析出正确marker。

## 影响

Harness在发送四个显式交错decision之前提前终止，无法验证request/reply/ack/resolved/Executor tool result、双Plan validated和graceful close。

早停时四个Executor仍等待Supervisor reply，finally的Root close进入8秒超时并强制退出；虽然所有PID最终ESRCH，但缺少完整official proof与`close.completed`，不能作为A2或B场景GREEN。

## 复现

1. 在真实persisted flat Harness中让两个Plan各派发task-1/task-2。
2. owner绑定竞态修复后等待4个Attempt均为 `waiting-attention`。
3. 读取任一 `attention/<requestId>.md`。
4. body首行是native说明；`startsWith(prefix)`为false，但按行筛选得到exact 1条marker，JSON schema和身份均正确。

## 根因

Harness把Executor传给 `contact_supervisor` 的message原文形状，误当成Plan Attention持久化body的完整形状。native Supervisor channel会为message增加run、agent、child target和reply指令包装。

旧A2因owner竞态只得到两个waiting Attempt，停在polling阶段，未执行marker parser，所以该oracle缺口一直被遮蔽。

## 修复

`attentionMarker()`按换行拆分body，只接受恰好一条以exact prefix开头的独立行；对该行prefix后的JSON继续执行现有exactObject字段白名单、schema和后续run/task/path断言。

禁止substring任意匹配、首个匹配静默接受或放宽marker字段。零条和多条都fail closed，避免包装文本或重复marker混淆身份。

## 验证

使用已保存真实owned-root中的四份body做离线fixture验证：每份exact marker行数量均为1，解析结果与对应Attempt一致。修正后提交Harness-only变更，冻结新HEAD和新porcelain/Harness hash，再在新基线唯一运行一次真实A2。

旧HEAD `5d518aeacd577d173fd7ef8f7d4fcc34ad63e719`已唯一运行，严禁重跑。
