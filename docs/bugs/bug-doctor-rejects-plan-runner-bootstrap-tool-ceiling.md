# Bug：Doctor 拒绝 Plan Runner 的最小启动工具集

## 1. 现象

当前 `pi/agents/plan-runner.md` 按运行时授权边界只声明 `plan_open,read,grep`，但 `npm run doctor` 报告缺少 `plan_status`、`plan_continue`、`plan_verify`、`plan_block`、`plan_read_revision` 和 `plan_amend`，并以状态码 1 退出。

## 2. 影响

正确的 Plan Runner 配置被初始化门禁判定为错误，导致 `npm test` 与 `init-pi.sh` 最终验收失败。若按 Doctor 提示把生命周期工具重新写回 frontmatter，会让模型在项目工具尚未生效的首轮提前生成派发意图，重新引入无执行能力的半授权状态。

## 3. 稳定复现

```bash
npm run doctor
node --test test/doctor.test.mjs
```

Doctor CLI 稳定列出六个 missing control tool；`doctor CLI reports Root broker readiness without retired Host terminology` 因退出码为 1 失败。

## 4. 根因

远端已把 Plan Runner frontmatter 收敛为只含 `plan_open,read,grep` 的 bootstrap tool ceiling，完整生命周期工具由 Capsule 在 `plan_open` 后动态激活；`scripts/doctor.mjs` 的 `REQUIRED_PROFILES.plan-runner.requiredTools` 仍保留旧的静态生命周期清单，Doctor fixture 也继续构造旧配置，两个合同发生漂移。

## 5. 修复

Doctor 只要求 frontmatter 中存在 `plan_open`，并把六个只能在授权后动态激活的生命周期工具列为禁止预激活项；测试 fixture 改为真实的 `plan_open,read,grep`，逐项证明 lifecycle 与 subagent 类工具写回 frontmatter 都会被拒绝。

## 6. 验证

先让当前 Doctor CLI 测试以缺失工具诊断稳定失败；更新测试期望后确认旧 Doctor 因把新 fixture 判为缺失而保持 RED，再修改 Doctor 常量。最终运行 `test/doctor.test.mjs`、`test/migration-contract.test.mjs`、`npm run doctor`、完整 `npm test` 与 `git diff --check`。
