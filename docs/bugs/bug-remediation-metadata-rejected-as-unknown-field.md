# Bug：remediation metadata 被误报为未知字段

## 一句话描述
非 Host 调用提交合法 remediation metadata 时，校验先将 metadata 视为未知字段，未返回应有的 Host-internal 权限诊断。

## 复现
1. 构造包含完整合法 remediation metadata 的 taskDef。
2. 调用未设置 `hostInternalRemediation` 的 `validateTaskDefinitions()`。
3. 观察实际抛出 `contains unknown field`，而非 `metadata is Host-internal only`。

## 修复方案
将 `metadata` 保持为已知字段并优先执行 Host-internal 门禁；继续对其他未知字段和不符合精确格式的 metadata 关闭拒绝。
