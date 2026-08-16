# 修复流程可绕过发现与写权限

一句话：若修复任务可由调用者正文或未验证失败直接创建，便能绕过可审计的失败证据和目标写路径限制。

复现流程：构造非 Host 派生的失败信息或超出 Condition remediation 范围的修复任务；若系统接受它，就能在没有可信 Finding 的情况下修改不被授权的文件。

修复方案：只从规范化的 Host failed verdict 派生 Finding；以指纹复用开放 Finding；为 Episode 和 remediation Task 生成精确事件计划，并在创建任务前证明写路径与策略及用户能力一致。
