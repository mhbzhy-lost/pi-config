# pi-subagents-enhanced 本地 peer 副本破坏 Host 模块身份

## 现象

执行 `npm run setup:subagents-enhanced` 后，`packages/pi-subagents-enhanced/node_modules/` 下实际安装了以下 Pi core peer：

- `@earendil-works/pi-coding-agent@0.84.4`
- `@earendil-works/pi-tui@0.84.4`
- `@earendil-works/pi-ai@0.84.4`
- `@earendil-works/pi-agent-core@0.84.4`

这些依赖在 package manifest 中声明为 peer，本应由当前 Pi Host 提供。npm 7+ 默认会 reify peer，因此仅声明 `peerDependencies` 不能阻止本地物理副本。

## 数据来源与分类

该异常属于 AGENTS 定义的第 1 类：**预期 production 数据未被正确处理**。

- 实际入口：仓库公开的 `npm run setup:subagents-enhanced` 初始化命令，以及 package 自带的 `npm run setup:runtime`；
- 权威身份：package manifest 的 peer 声明、npm 生成的 package-local lockfile 和安装后的真实 `node_modules` 目录；
- 事件与资源顺序：根 setup 先执行 package install，随后 package setup 再执行一次精确版本 install；两次调用都使用 npm 默认 peer reification，最终生成四个 Pi core peer 的 package-local 目录；
- 与 production 事实的差异：local-path Pi package 应消费当前 Host 的 core/TUI/AI 模块身份，但普通 Node/Jiti 相对 package 解析会优先看到更近的 package-local 副本。

这些数据来自合法 npm 安装入口、真实 manifest/lockfile 和实际文件系统结果，不是手工构造 projection、缺字段 mock 或不可达 fixture。

`typebox` 不属于本缺陷的禁止目标。`pi-subagents@0.62.0` 自身将 `typebox@1.1.38` 声明为 dependency，因此 package-local 安装中存在可满足该真实传递依赖的 `typebox` 是预期行为。

## 首个偏离点

首个偏离点是根 `setup:subagents-enhanced` 的第一次 `npm install` 未声明 `--omit=peer`。随后 `scripts/setup-runtime-deps.mjs` 发起的第二次 `npm install --save-exact pi-subagents@0.62.0` 同样未声明 `--omit=peer`，会再次恢复 peer 副本。因此只修其中一层不能建立稳定不变量。

## 完整生成调用链

```text
npm run setup:subagents-enhanced
  -> npm install --prefix packages/pi-subagents-enhanced --ignore-scripts
  -> npm 7+ 读取 pi-subagents-enhanced.peerDependencies
  -> 默认 reify 四个 @earendil-works Pi core peers
  -> npm --prefix packages/pi-subagents-enhanced run setup:runtime
  -> setupRuntimeDependencies()
  -> npm install --prefix <package> --ignore-scripts --save-exact pi-subagents@0.62.0
  -> 再次默认 reify peers
  -> package-local node_modules 保留四个 Pi core 副本

T4 启用 local path source 后
  -> Pi ResourceLoader / Jiti 加载 package extension
  -> extension import @earendil-works/pi-coding-agent 或 pi-tui
  -> 普通 package-relative Node resolution 优先命中 package/node_modules
  -> Host 与 extension 可能分别持有不同的类、renderer、theme 或模块级 singleton 身份
```

## 修复边界

- 根 setup 和 package 内 setup 的每一次 npm install 都必须显式使用 `--omit=peer`；
- package verify 必须拒绝四个 Pi core peer 的任何 package-local 物理副本；
- 重新执行 setup，令当前 `node_modules` 与 lock/reification 状态匹配新策略；
- compat 测试继续通过 Pi Host aliases 提供 peers，不得依赖被禁止的 package-local core 副本；
- `pi-subagents` 及其真实传递依赖继续进入 npm tarball，四个 Pi core peers 不得进入 tarball；
- 不要求 package-local `typebox` 缺失，不修改 runtime、TUI、settings、models、init 或 Doctor。

## 验收

1. RED 证明当前 setup 命令缺少 `--omit=peer`，且 verify 接受实际存在的 Pi core peer 副本。
2. GREEN 后两层 npm install 都带 `--omit=peer`，四个 Pi core peer 在 package-local `node_modules` 中均不存在。
3. verify 对任一被注入的 Pi core peer 副本 fail closed。
4. compat 通过 Host aliases 加载，`typebox` 与 `pi-subagents` 的真实 dependency 闭包仍可用。
5. `npm pack --dry-run --json` 继续包含 bundled `pi-subagents` 及其真实传递依赖，但不包含四个 Pi core peers。
