# 子进程完成未产生绑定验收证据

## 现象
coding child 完成后只有自然语言报告，Goal 无法得到可复核且可归属的验收证据。

## 影响
主 Agent 可能把未绑定、含敏感输出或不完整的报告错误地用于 settle。

## 根因
child runtime 没有受限 typed evidence 提交通道，也没有把派发身份与当前 HEAD 传给规范化存储。

## 修复
仅为 executor coding child 注册 `submit_acceptance_evidence`；使用 canonical settlement codec 校验并内容寻址写入受限 YAML。

## 验证
集成测试覆盖精确 identity、非法输入拒绝、root 七工具 ABI 和 shutdown 后无残留提交器。

## 预防
身份缺失或不一致、未知字段与不安全引用一律 fail closed；root runtime 永不注册该工具。
