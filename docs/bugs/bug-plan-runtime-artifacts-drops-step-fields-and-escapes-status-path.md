# Runtime Artifact 丢失 Step 字段且 Status 路径可逃逸

## 现象

真实 `pi-subagents` status 将 model、attemptedModels 和 nested children 放在 `steps[]`，当前 reader 返回空值；派生 status 写入时又直接使用未经校验的 planId。

## 影响范围

Plan projection 无法绑定 nested child 的运行身份和模型证据；恶意或损坏的 planId 可把 status 写到 `var/plan-runs` 之外。

## 复现步骤

1. 读取含 `steps[0].model/attemptedModels/children[].id` 的真实形态 status，观察投影字段为空。
2. 调用 `writePlanStatus()` 并传入 `planId: "../escape"`，观察输出路径逃出计划目录。

## 根因

Reader 只从 status 顶层挑字段，没有把 `steps` 当作 stable 字段容器；writer 将领域 identity 当成已验证路径段，没有执行路径边界检查。

## 修复方案

单 step status 在顶层字段缺失时，从 step 提取 model、attemptedModels、sessionFile，并 flatten children；将 child 的真实 `id` 规范化为 typed `runId`。写入前校验 planId 安全 token 和最终目录边界。

## 验证方式

加入真实 step fixture 与 `../escape` RED；修复后运行 Task 8 目标测试和完整单元测试，确认未知字段与格式化文本仍不进入投影。
