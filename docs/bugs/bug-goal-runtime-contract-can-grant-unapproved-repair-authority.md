# Bug：运行时合同可能授予未经批准的修复权限

## 描述
若初始化输入接受调用者提供的执行细节、越界修复路径或伪造的激活批准，Agent 可在未经真实用户批准的情况下获得修复权限。

## 复现步骤
1. 提交含顶层 `tasks`、`profile`、命令或敏感字段的 runtime 初始化输入。
2. 提交引用未知注册项、循环 Condition、越过 write policy 的 remediation，或非确定性 adapter 的 `single` stability。
3. 使用 challenge 前、跨 session 或非 interactive/RPC 的用户输入作为批准。

## 修复方案
以纯函数严格规范化 runtime 合同，只保留注册引用和脱敏声明；从规范化义务派生形状与 canonical hash；只读注册表计算 readiness。激活 challenge 精确绑定合同和会话，`recordHumanChoice` 仅接受 challenge 后的 interactive/RPC 用户批准。
