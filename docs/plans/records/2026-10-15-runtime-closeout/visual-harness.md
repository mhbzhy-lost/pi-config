# V1：真实后台活动 TUI fixture 与 harness

Inline 构建；不修改 production，不注册新 sender/scheduler/authority。

- `test/fixtures/background-activity-visual.ts` 仅通过 package 公开 ActivitySource/bus 提供明确带 `fixture:` 的三类显示行；详情原文是自造两块文本。
- 记录0600 probe JSONL（fixture epoch、动作、session ID、draft/key事实），new/resume/fork 使用真实命令 ctx 与 fresh withSession；reload 不复用旧 ctx。
- `test/helpers/background-activity-visual.mjs` 固定 launcher argv 和环境白名单，不继承用户凭据/代理；增加 helper 是为了避免 contract 导入 runner 而意外执行 Host。
- `test/background-activity-visual.integration.mjs` 八个显式场景，默认 skip，只有 PI_TEST_BG_VISUAL=1 启动；使用 P0 直接 child/reap，无强杀；证据根始终保留供人工视觉确认。
- 几何采用隔离 Host `/debug` 原始渲染行/visible widths 与已知 winsize；不将 strip-ANSI 历史流当最终屏幕。

## 构建验收

- `node --test test/background-activity-visual-contract.test.mjs`：exit0，4/4。
- package 内 TypeScript 5.9.3 的 tsc，显式 `--noEmit --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck test/fixtures/background-activity-visual.ts`：exit0。
- 根 TypeScript 7 的同一命令先报告 TS5112（显式files与当前tsconfig冲突），未当代码错误；使用 package 既有5.9.3编译器，不安装/升级/改tsconfig。
- `node --check test/background-activity-visual.integration.mjs`、`git diff --check`：通过。

真实运行证据由V2另记录。L3色彩/闪烁/字体/IME/整体观感仍需用户确认，合同构建不冒称真实视觉通过。
