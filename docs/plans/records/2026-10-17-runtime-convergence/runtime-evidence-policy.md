# T4：coding 验收证据默认类别去测试暗示

## 结论

`CODING_ACCEPTANCE_EVIDENCE` 已删除固定的 `tests-added`，默认证据类别只剩 `changed-files`、`commands-run`、`validation-output`、`residual-risks`、`no-staged-files`。未新增 `tests-not-added`、测试授权字段或任何通用 runtime 阻断器。

## 事实

- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:592-598`：常量当前五项；`git diff HEAD` 对该常量只有一行删除（`-  "tests-added",`）。
- 同一文件的其余本轮改动只有两处：`import { createSupervisorIntentId }`（`:21`）与 steer/reply 的 `intentId` 派生（`:1501`、`:1590`）；未触碰工具注册、exposure 或 spawn 参数结构。
- child 侧 `child-extensions/acceptance-evidence.ts` 仍只要求 `outcome`、`criteria`、`commandsRun`、`changedFiles`，没有把测试作为必填证据。
- 测试授权约束只在 `pi/AGENTS_SHARED.md` 保留一条：未经用户明确授权不得主动新增测试。

## 证据

- `node --test test/subagent-acceptance-evidence.integration.mjs`（与 real-git 合并运行）：该文件 6/6 通过，日志 `/tmp/rc-positional-check.log`。
- root/package `npm run typecheck` exit 0（见 `current-validation.md`）。

## 边界

未运行真实 coding child 端到端去观察证据类别被消费；本记录只证明默认合同不再暗示必须新增测试，不证明任何 child 的实际证据质量。
