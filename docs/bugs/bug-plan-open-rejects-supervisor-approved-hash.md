# plan_open 拒绝 Supervisor 批准的哈希覆盖

## 现象

Supervisor 已批准计划文件的实际 SHA-256 哈希，但 plan-runner 使用 `approvedHash` 重试 `plan_open` 时，绑定验证仍接收启动参数中的旧 `planHash`，导致打开计划失败。

## 影响范围

仅影响计划文件在创建工作区后发生变更、且 supervisor 明确批准实际哈希的 plan-runner 恢复路径；正常的原始哈希校验不受影响。

## 复现步骤

调用 `plan_open`，提供不同的 64 字符 `planHash` 与 `approvedHash`，并在 `validateBinding` 中断言收到实际哈希。当前断言收到旧哈希，工具返回错误。

## 根因

`plan_open` 的参数 schema 未声明 `approvedHash`，执行处理器也将原始输入直接传入 `validateBinding`。`readBinding` 只将 `input.planHash` 与文件 SHA-256 比较，没有读取可选批准值。

## 修复方案

在 capsule schema 中声明可选的固定长度 `approvedHash`，在 validator 调用边界将其设为有效 `planHash`；同时由 `readBinding` 使用同一可选覆盖值进行哈希比较。

## 验证方式

先运行针对批准哈希覆盖的测试确认其因旧哈希而失败；实现后运行该测试及 capsule 和 gate-enforcement 全量测试，确认全部通过。
