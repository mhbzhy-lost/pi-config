# T16：fresh Host 依赖闭包与真实 integration 验收

| 维度 | 状态 | 事实 |
| --- | --- | --- |
| install closure（联网安装/依赖闭包） | `verified-isolated` | 用户授权联网后在隔离临时目录执行 `npm ci --ignore-scripts`（官方 registry）：exit 0，`npm ls` 显示 `@earendil-works/pi-coding-agent@1.0.4` 且 `@earendil-works/pi-codemode@1.0.4 overridden`；当前物理 Host 的 `node_modules` 未被改动或热替换（`/tmp/rc-fresh-install.log`） |
| package verify 与 N1 八项 | `verified` | 本轮实跑：`npm run test:subagents-enhanced` 8/8 exit 0（联网，官方 registry）；`npm run verify:subagents-enhanced` 离线与联网各 exit 0（1259 upstream files、166 import edges、1828 tarball files / 17568320 bytes）。S6 历史数字保留为历史值，不与本轮混算 |
| tool exposure（fresh 注册面） | `verified-synthetic`（本仓 SDK 与隔离安装闭包各一次） | `node --test --test-name-pattern='configured enhanced local package' test/pi-runtime.integration.mjs` 1/1 exit 0：14 个 operation tools 全部注册且 `model-only`，无网络、显式 ModelRuntime |
| physical Host identity | `verified` | `node scripts/probes/physical-host.ts`：version 1.0.4 healthy，core identity 与 watchdog 一致 |
| fixture compatibility | `partial→mostly-verified` | 见 `fixture-inventory.md`：model-selection 23/23、real-git 4/4、managed-worktree 5/5、merge-queue probe 43/43（验证已迁移的 `root-provider.mjs`）、resumed-child 1/1、acceptance-evidence 3/3、deterministic+model-only 8/8、fresh contact 2 场景；仅 `recovery-resume/scripted-model-server.mjs` 因全仓无消费方而无法验证 | 
| provider compatibility（真实 provider/CLI/TUI） | `not-run` | 无真实 provider 授权；fresh CLI 检查使用隔离 synthetic provider |

## 未验证项（不得外推）

1. 当前交互 Host 内存是否加载了本轮全部源码修改：用户曾重启一次 Host，但其后仍有改动（含 settlement 专项用例、黑名单移除、reviewer description），因此不声称已加载；隔离安装闭包只证明依赖可安装与注册面合同，不代表当前 Host 已重装。
2. 真实 provider 下的 Supervisor/派发行为、真实 TUI 观感（F6 属用户后验）。
3. 全仓 `npm test` / `test:all-integration`：需用户另行授权与资源窗口，且开跑前需审计危险/网络/敏感配置入口。
