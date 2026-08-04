# Bug：移除 Todo 后暴露 Pi Peer 依赖解析假设

## 现象

从 `pi/npm` 卸载 `@juicesharp/rpiv-todo` 后，`test/pi-subagents-compat.test.mjs` 的浏览器 transcript 兼容测试失败，报错为无法从 `pi-subagents/src/tui/fleet-transcript.ts` 解析 `@earendil-works/pi-coding-agent`。

## 影响范围

Todo 组件虽然已从配置和安装脚本移除，但聚焦门禁无法通过；如果继续依赖旧安装残留，干净环境与已有环境会得到不同结果，并可能掩盖测试夹具的模块解析缺口。

## 复现步骤

1. 在当前仓库执行 `npm uninstall --prefix pi/npm @juicesharp/rpiv-todo`。
2. 确认 `pi-subagents@0.37.2` 和 `typebox@1.1.38` 仍存在。
3. 运行 `node --test test/pi-subagents-compat.test.mjs`。
4. 观察浏览器 transcript 兼容测试在导入 `fleet-transcript.ts` 时报告 `MODULE_NOT_FOUND`。

## 根因

`pi-subagents` 把 Pi 核心包声明为可选 peer dependency，正常运行时由 Pi 宿主提供。该测试直接创建独立 Jiti 实例，却没有像仓库其他 Pi TUI 测试一样把 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 映射到真实宿主安装。此前 `rpiv-todo` 的传递依赖恰好在 `pi/npm/node_modules` 提供这些模块，掩盖了测试夹具的不完整性。

## 修复方案

由共享测试 helper 通过 `npm root -g` 定位真实 Pi 宿主安装，并为相关 Jiti 实例配置 Pi 核心包 alias。不要固定 Homebrew 路径，不要把 Pi 核心包加入 Plan Runtime 的独立依赖，也不要为了让测试通过保留 Todo 的传递依赖。

## 验证方式

确认本地 `pi/npm/package.json` 只保留 `pi-subagents@0.37.2` 和 `typebox@1.1.38`，随后运行 Todo 移除聚焦测试、完整 `npm test`、Doctor 与真实 Pi RPC integration；浏览器 transcript 兼容测试应在无 `rpiv-todo` 的干净依赖图中通过。
