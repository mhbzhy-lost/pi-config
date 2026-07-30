# Bug: Plan Runner profile 在项目工具生效前预激活生命周期工具

## 症状

真实flat Plan Runner完成`plan_open`后，在同一agent turn调用`plan_continue`并得到两个`dispatch-required` intent，却没有调用项目`subagent`，随后输出等待文本并正常退出。Plan状态停在`dispatch-requested`。

## 影响

parallel Harness无法启动Executor。更严重的是，Plan Runner已经持久化dispatch intent但当前turn没有对应派发能力，造成看似等待lifecycle、实际永远不会产生lifecycle的死等状态。

## 复现

1. Profile首轮静态激活`plan_open`及全部Plan lifecycle工具，但按安全约束不声明项目`subagent`。
2. `plan_open`成功后Capsule调用`setActiveTools`加入`subagent`和`plan_executor_supervisor`。
3. Pi明确规定active tool变更只在下一agent turn生效；当前turn的provider snapshot仍只有profile工具。
4. 模型可在同turn调用`plan_continue`生成dispatches，但看不到`subagent`，于是返回等待文本且child完成。

## 根因

Profile把bootstrap inventory与打开Plan后的授权inventory混为一体。静态注册解决strict registry validation，但profile的首轮active列表仍绕过了Capsule的turn级激活边界，形成“能生成intent、不能执行intent”的半授权turn。

## 修复

生产和真实Harness的Plan Runner profile只声明bootstrap工具`plan_open,read,grep`。全部Plan lifecycle工具仍在extension factory静态注册，`plan_open`成功后Capsule设置完整active集合；当前turn因看不到`plan_continue`而settle，既有`agent_settled` follow-up启动下一turn，完整Plan和项目工具同时可用。不得把`subagent`写入frontmatter。

## 验证

Profile单测精确断言bootstrap工具且继续禁止frontmatter中的`subagent`。真实session必须出现首轮仅`plan_open`，下一turn才出现`plan_continue`和两个exact `subagent`调用；Plan不再停在无runId的`dispatch-requested`。
