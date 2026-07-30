# Bug: Task 5A2 GREEN 通过样例但遗漏四个 intent 合同边界

## 症状

Task5A1 happy 与 15 项 Task5A2 测试全部 GREEN，但提交前源码审查发现四个未覆盖分支：含单引号的 verification cwd 生成无效 shell；多个 durable pending intents 只返回第一项；缺少 current revision 的 v3 projection 被放行；长文本在空白边界分块后被 dispatch compiler 的 `trim()` 静默删字节。

## 影响

合法 Plan 可能收到无法执行的 acceptance command；parallel prepare 在 crash 后不能一次恢复全部待派发合同；legacy projection 可绕过 v3 revision identity；Task body 或 Plan instructions 的空白语义可能与批准 IR 不一致。这些问题都会使 durable event、typed contract 或 Executor 输入偏离同一 current `plan-ir.v3`。

## 复现

1. verification cwd 使用 `test/it's`，当前生成 `cd -- 'test/it'\"'\"'s' && ...`，交给 `/bin/sh -c` 返回 unmatched quote。
2. 先为两个 parallel root 生成两个 `dispatch-requested`，重建 Coordinator 后调用 prepare，返回数组长度为 1。
3. 使用 v3 IR 和没有 `revision` 的 legacy `plan.created` projection 调用 prepare，当前仍分配 workspace。
4. 构造完整 task body 在第 4096 byte 以空格结束，分块后 canonical contract 对每项 trim，`requirements.join("")` 不再等于 IR body。

## 根因

实现以现有 15 个样例为边界，没有逐项回查派发要求。cwd escape 字符串多加入了反斜杠；pending replay 在循环体内直接 `return`；revision helper 把 `projection.revision` 当成可选兼容字段；分块只控制 UTF-8 byte 数，没有考虑下游 compiler 会规范化每个数组元素。现有测试分别只覆盖无引号子目录、单 pending、带 revision happy 和连续 `x` 长文本，因此未暴露这些分支。

## 修复

先增加四个独立 RED。cwd 使用 POSIX 单引号标准拼接 `'<prefix>'"'"'<suffix>'`；pending replay 校验并返回所有 durable requested Attempt，任一项不匹配则整体 fail closed；typed v3 prepare 要求 projection revision 存在并与 IR 的根及全部 Task hash 一致；分块只能选择不会因 trim 丢字节的边界，无法在 32 项容量内无损表达时 pre-allocation 报 `capacity`。

测试 Harness 对 v3 Plan 默认使用 `createdV3Entry(ir)`，仅“缺少 revision”用例显式传 legacy event，避免测试基础设施继续把非法组合当正常输入。

## 验证

四个新用例必须在当前未提交 GREEN 上分别以 shell command 差异、pending 数量、missing revision 未拒绝和 body 重构差异 RED，不得先撞 reducer、fixture 或语法错误。修复后 Task5A1 与全部 Task5A2、完整 Coordinator、Plan Events/IR/dispatch IR 回归均通过；容量失败仍发生在 workspace allocation 前，prepare 路径不调用 spawn/bind。
