# Child Plan Extensions 被 Parent 全局自动发现

## 现象

正式安装 `pi-subagents` 后，直接启动 Parent Pi 失败：`Tool "plan_open" conflicts`，冲突来源是同时自动加载的 `plan-capsule.ts` 与 `plan-runner.ts`。

## 影响范围

所有使用仓库正式 `PI_CODING_AGENT_DIR` 的 Parent Pi 都无法启动；真实 Plan child profile 的 `extensions: ""` 无法修复 Parent 侧冲突。

## 复现步骤

执行正式 `pi install npm:pi-subagents@0.34.0` 后运行 `PI_REAL_BIN="$(command -v pi)" npm run test:integration`。Pi 自动发现 `pi/extensions/*.ts`，两个 child-only入口重复注册 `plan_open`。

## 根因

Pi 将 `PI_CODING_AGENT_DIR/extensions` 视为全局 auto-discovery 目录。实现把只应由 Plan child wrapper 显式加载的 Capsule/Runner 入口放入该目录；此前真实 integration 因 package 未正式安装而未形成完整启动组合。

## 修复方案

将 `plan-capsule.ts` 与 `plan-runner.ts` 移到非自动发现的 `pi/child-extensions/`。Parent 只自动加载 `plan-launcher.ts`；Plan worktree runtime wrapper 通过可信绝对 file URL 显式加载 child runner。doctor 同时检查 Parent 与 child 两类目录。

## 验证方式

基础 Pi RPC 可无冲突启动并加载精确 Skill 白名单；真实 Plan E2E 仍能通过 worktree wrapper加载 child runner；doctor 检查两个 child-only入口存在且 profile 保持 `extensions: ""`。
