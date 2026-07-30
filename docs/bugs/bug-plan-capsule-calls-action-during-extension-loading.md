# Bug: Plan Capsule 在 extension loading 阶段调用 action method

## 症状

真实flat Plan Runner child加载fixture extension时立即失败：`Extension runtime not initialized. Action methods cannot be called during extension loading.`。错误发生在Capsule factory调用`pi.setActiveTools()`，模型首轮尚未开始。

## 影响

Capsule静态工具注册已能满足pi-subagents strict registry validation，但Plan Runner仍无法启动。所有依赖真实child extension加载的parallel、Attention和amendment Harness被阻断；使用宽松Pi test double的单元测试错误转绿。

## 复现

1. Child loader调用Plan Runner extension factory。
2. Factory创建Capsule并静态注册Plan工具。
3. Capsule在factory返回前调用`pi.setActiveTools(["plan_open", "read", "grep"])`。
4. 真实Pi在extension loading阶段禁止action methods并抛错，pi-subagents把Plan Runner step标为failed。

## 根因

上一修复正确分离了静态registry与动态active授权，但把active集合收敛放在了extension factory。`registerTool`是允许的声明动作，`setActiveTools`是只能在runtime初始化后的action method；单元fixture没有模拟这条Pi生命周期约束。

## 修复

Factory只静态注册工具。`session_start` handler在runtime已初始化后根据当前branch设置active集合：未打开Plan时精确设置`plan_open,read,grep`；恢复到已打开Plan时设置完整`PLAN_ACTIVE_TOOLS`。`plan_open`成功后的激活路径保持不变。

## 验证

测试double增加可选loading action guard，独立证明Capsule factory不调用`setActiveTools`；pre-open active断言改在`session_start`后执行。完整Capsule与runtime policy回归通过，真实flat Harness不再出现`Extension runtime not initialized`。
