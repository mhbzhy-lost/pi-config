# Bug: Task5C RED 把 legacy dispatch 开关放入 plan_continue 输入

## 症状

V3 amendment 兼容测试通过 `deps.continuePlan({ legacyDirectDispatch: true }, ...)` 请求旧 direct spawn。该字段属于测试过渡能力，却被放进了领域方法的 model-callable input 位置；真实 `plan_continue` schema 只声明 `reason`。

## 影响

若生产为了满足测试读取该字段，会形成未声明的派发绕过：绕过一次性 Executor authorization，直接调用 backend spawn。即使 Capsule schema 当前拦截，Dependencies 公共方法也不应把安全模式交给调用输入控制。

## 复现

查看 `test/plan-runner-dependencies.test.mjs` 的 amendment replay 测试，可见两次 `continuePlan` 都传入 `legacyDirectDispatch: true`，而 `plan-capsule-extension.mjs` 的 `plan_continue` 参数只允许 `reason`。

## 根因

Tests-only RED 将“构造时选择兼容 backend”与“运行时生命周期 intent”混为一个对象，没有保持 capability 配置和模型输入的权限边界。

## 修复

把 `legacyDirectDispatch: true` 放到该测试的 `createPlanRunnerDependencies()` 构造选项中；两次 `continuePlan` 恢复 `{}`。Production 默认 false，真实 child 不传；只有明确的 legacy test fixture 可启用。

## 验证

静态断言 `continuePlan` 调用输入不含 `legacyDirectDispatch`；V3 secure test默认仍期望 `dispatch-required`，legacy amendment fixture通过构造选项保持旧端到端覆盖。Capsule `plan_continue` schema和prompt不新增该字段。
