# Bug：init-pi.sh 未安装 Plan Runtime 的顶层 TypeBox 依赖

## 1. 现象

`init-pi.sh` 只执行 `pi install npm:pi-subagents@0.37.0`。新机器完成初始化后，`pi/npm` 不保证存在顶层 `typebox@1.1.38`，但 Doctor、typed Subagent runtime 和 Standalone Plan Runner 都把它视为必需依赖。

## 2. 影响

root extension 可能正常加载，但 detached Subagent 或 Plan Runner 在导入 `typebox/compile` 时失败。初始化末尾虽然运行测试和 Doctor，但安装流程本身没有建立当前仓库声明的精确依赖状态，一键配置合同不完整。

## 3. 证据

`scripts/setup-plan-runtime-deps.mjs` 已定义精确安装命令：在 `pi/npm` 顶层安装 `pi-subagents@0.37.0` 与 `typebox@1.1.38`。`package.json` 已暴露 `setup:plan-runtime`，`pi/npm/package.json` 也固定两者版本；`init-pi.sh` 没有调用该入口。

现有 `test/init-pi.test.mjs` 的 fake Pi 只创建 pi-subagents fixture，不创建或断言 TypeBox，因此缺口不会让测试失败。已有 `bug-pi-subagents-0351-missing-typebox-peer.md` 已证明标准 `pi install` 不会可靠安装 optional peer。

## 4. 根因

Plan Harness 增加顶层依赖 helper 后，初始化入口和 fixture 没有同步接入。安装职责被拆成“Pi package manager 安装 extension”和“npm 建立 detached runtime 顶层依赖”两条路径，但唯一新机入口只执行了前一条。

## 5. 修复策略

在 `pi install` 后通过仓库脚本执行 `npm --prefix "$SCRIPT_DIR" run setup:plan-runtime`，复用单一精确版本合同，不在 shell 中复制依赖版本。保持重复执行安全，并继续由 Pi package manager 管理 package metadata。

扩展 init fixture：fake npm 观察到该命令时创建 TypeBox fixture；测试同时断言命令被调用、`typebox@1.1.38` 安装结果存在、两次初始化仍幂等。README 的初始化清单明确说明会安装 Plan/Subagent runtime 依赖。

## 6. 验证计划

先修改 `test/init-pi.test.mjs` 并确认当前脚本因缺少 setup 命令和 TypeBox fixture 稳定 RED；再最小修改 `init-pi.sh` 与 README。运行 init/migration/package/compat/Doctor 测试、`bash -n`、完整 `npm test`，并在隔离 HOME 的 fixture 中连续执行两次初始化。

## 7. 验证结果

RED 在缺失 `npm --prefix <repo> run setup:plan-runtime` 的精确命令断言处失败。接入 helper 后，init/package/compat/runtime/Doctor 聚焦回归 41/41，`bash -n init-pi.sh` 与 scoped `git diff --check` 通过；fixture 连续执行两次初始化并确认 `typebox@1.1.38` 安装结果。
