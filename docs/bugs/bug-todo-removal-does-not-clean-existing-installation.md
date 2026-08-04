# Bug：Todo 移除未清理既有安装

## 现象

仓库已从 `pi/settings.json`、`init-pi.sh` 和 Plan Runtime 安装参数中删除 `@juicesharp/rpiv-todo`，但在曾安装过该包的环境中重新执行 `init-pi.sh`，`pi/npm/package.json` 与 `node_modules` 仍可能保留 Todo 包。

## 影响范围

升级已有 pi-config 工作区时，Todo 工具仍可作为残留依赖存在；新环境与旧环境的依赖图不一致，配置变更无法保证用户要求的“去掉 Todo 组件”。

## 复现步骤

1. 在 `pi/npm/package.json` 中保留 `@juicesharp/rpiv-todo` 依赖。
2. 执行当前 `scripts/setup-plan-runtime-deps.mjs`，它只运行包含 `pi-subagents` 和 `typebox` 的 `npm install`。
3. 检查 `pi/npm/package.json` 或 `node_modules`。
4. 观察 npm 不会因为本次安装参数省略该包而自动删除旧依赖。

## 根因

安装脚本把“期望依赖列表”误当成声明式完整集合；实际上 `npm install <packages...>` 只新增或更新指定包，不会移除 `package.json` 中未出现在命令行的其他既有依赖。

## 修复方案

Plan Runtime setup 在安装保留依赖前，先对 `@juicesharp/rpiv-todo` 执行幂等的 `npm uninstall --prefix <pi/npm>`。通过注入 runner 的测试锁定卸载先于安装的调用顺序，并保留新环境重复执行的幂等性。

## 验证方式

先构造含旧 Todo 依赖的本地状态，再运行 setup/init 路径，确认 `pi/npm/package.json` 和 `node_modules` 均不再包含该包；随后运行聚焦测试、完整 `npm test`、Doctor 与真实 Pi RPC integration。
