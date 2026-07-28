# Bug：生产 Plan Runner 未激活 native Supervisor 工具

## 1. 现象

通过主仓真实 `plan_run` 启动 Crash Fix V2 回写计划后，Plan Session 在首次Attempt派发时进入 `blocked`。生产扩展stderr报告：`Standalone Plan Runner runtime tools are missing: subagent_supervisor`。领域状态停在 `dispatch-requested`，`runId=null`，未到达计划定义的物料前置门禁。

## 2. 影响范围

影响通过正式 `plan_run` 启动的Standalone Plan Runner。`subagent_wait`可用，但parent-facing native Supervisor tool虽由`pi-subagents`注册，却未进入active tool集合，导致生产`assertRuntimeCapabilities`失败。既有确定性smoke使用测试fixture扩展，未执行生产tool检查，因此产生false green。

## 3. 复现条件

1. 从普通主仓Pi Session调用正式`plan_run`。
2. Host使用`--no-extensions`并显式加载`pi-subagents`与生产`pi/child-extensions/plan-runner.ts`。
3. Standalone进程不通过`plan-runner` agent profile启动，因此profile中的`tools:`列表不生效。
4. `pi-subagents`在`session_start`注册`subagent_supervisor`，但当前active tool集合未包含它。

证据：`mega-aone-service/var/plan-runs/ab95b239-c1bd-45a0-bb2e-592253ce09af/runtime/stderr.log`和同目录`status.json`。

## 4. 根因

生产入口把`pi.getActiveTools()`同时当作“工具已注册”和“工具已激活”的事实源。Standalone Host不是通过agent profile启动，不能继承`pi/agents/plan-runner.md`的tool allowlist。测试fixture只验证RPC capability，没有复用生产入口的registered/active双重门禁，所以没有覆盖该差异。

## 5. 修复策略

新增独立runtime tool policy：先用`pi.getAllTools()`验证`subagent_wait`与`subagent_supervisor`真实注册，再显式把它们加入active集合，最后复读active集合fail closed。生产Plan Runner在RPC capability检查前调用该policy；测试分别覆盖“已注册但inactive时激活”和“未注册时拒绝”，并让真实production-entry smoke覆盖正式入口。

## 6. 回归与预防

- RED：已注册但inactive的`subagent_supervisor`导致当前policy缺失测试失败。
- RED：工具根本未注册时必须拒绝，禁止只靠`setActiveTools()`伪造能力。
- GREEN：定向tool-policy、Plan Capsule、Host/Launcher与完整`npm test`通过。
- 真实验收：重新通过`plan_run`启动同一Crash Fix计划；不得再出现runtime tool缺失，必须到达计划自己的readiness前置门禁或更后状态。

## 7. 真实复跑补充

第二次复跑证明`subagent_supervisor`已经注册并可调用。随后暴露的`session identity mismatch`不是当前源码的新缺陷，而是根Pi Session仍缓存修复前的launcher：运行产物继续落在旧`runtime/`路径，未创建`runtime/sessions`，而当前`plan-host-runtime.mjs`已经使用`host/`路径并在spawn前创建`sessionDir`。Pi因此只返回RPC UUID，`sessionFile=null`，Backend按设计fail closed。

真实验收前必须启动新的根Pi进程并恢复本会话；本次实际验证证明`/reload`虽然刷新了普通资源，却没有替换API当前暴露的`plan_run`工具绑定。否则child extension会从磁盘加载新代码，而`plan_run`仍由旧launcher发起，形成混合版本运行。失败运行`1f3a8455-fa91-4805-b1da-6d7734234638`与热重载后的`d40ba3e0-6708-44c0-b1bf-54088f3b2ce4`均保留为该验证环境差异的证据，不作为修复后验收结果。
