# Goal 静态验证覆盖缺口

- **入口：** 根 `npm run typecheck` 仅使用 `tsconfig.json`。
- **权威身份：** Goal production 是 `src/goal-engine/**/*.ts`、`pi/extensions/goal-engine.ts`，Root Broker 与受管 workspace 公共接口归 `packages/pi-subagents-enhanced`。
- **首个偏离：** `tsc --listFilesOnly` 不包含 `src/goal-engine/extension.ts`，因此旧 GREEN 不能证明 Goal 或 package 的类型安全。
- **修复边界：** 新增 focused Goal/package tsconfig 与明确 scripts；不把无关 feature 纳入。Doctor 使用公开工具注册、RunAuthorization、RootBrokerServer、managed workspace service 和 production entry composition 行为检查 readiness，不以私有实现文本判断。
- **当前阻塞：** focused semantic compile 已暴露 T1–T6 既有类型契约错误；本 Task 不修改这些 production 文件，也不以 `noCheck` 或排除文件伪造 GREEN。

## 2026-09-07 semantic compile inventory

`npm run typecheck` exits 2 after the legacy root config passes; the focused program reports 750 errors. Complete output is retained for this dispatch at `/tmp/t7-semantic-typecheck.out`.

| slice | errors matched by owned paths | first error |
| --- | ---: | --- |
| T1 Host authorization | 3 | `run-authorization.ts(99,39) TS2365`: comparison on `unknown` |
| T2 canonical Broker | 10 | `root-broker-protocol.ts(412,41) TS2345`: protocol callback contract mismatch |
| T4 async settle (including shared Goal extension call sites) | 159 | `settlement-evidence.ts(66,32) TS2554`: expected two arguments |
| T5 managed disposition | 64 | `workspace/ledger.ts(41,9) TS2339`: `Error.code` absent |
| T6 final review / production entry | 32 | `pi/extensions/goal-engine.ts(45,319) TS2365`: comparison on `unknown` |
| pre-existing or mixed cross-slice files | 482 | `extensions/custom-footer.ts(22,42) TS2322`: `number` not assignable to literal `1` |

The T4 count includes 150 errors in the shared `src/goal-engine/extension.ts`; its remaining errors cannot be assigned safely without an owner contract review. The inventory intentionally reports them rather than changing Goal business code.
