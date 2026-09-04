# 初始化链 npm audit/fund 请求阻塞

## 现象与证据

正常执行 `init-pi.sh` 与一次手动启动后停止的初始化均在 npm debug log 的 `silly audit bulk request` 之后长时间等待。此前正常 npm registry 请求已经成功，因此现场首先指向 audit endpoint 的额外网络副作用，而不是包下载或 `NPM_CONFIG_REGISTRY` 指向的 registry 不可用。

## 完整调用链

`init-pi.sh` 先以 `NPM_CONFIG_REGISTRY=https://registry.npmjs.org` 执行全局 `npm install`，随后以同一环境变量执行 `npm --prefix "$SCRIPT_DIR" run setup:subagents-enhanced`。该 npm script 进入 `scripts/setup-subagent-runtime-deps.ts`，后者依次执行卸载、增强包安装、`setup:runtime`、`verify:package`、scheduler 安装和 peer 安装；其中 `setup:runtime` 再进入 `packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts`，执行包本地的 `npm install`。

## 首个偏离点与可达性分类

首个偏离点是 `init-pi.sh` 的全局 `npm install -g --ignore-scripts` 未显式传递 `--no-audit --no-fund`；之后 setup 链的各个 npm mutation 和嵌套 setup invocation 也保留 npm 默认 audit/fund 行为。此路径由普通初始化入口直接调用，不依赖测试 fixture、手工残留 node_modules 或非公开入口，且 registry 请求已成功后仍可触发 audit 请求，分类为**预期 production 数据未被正确处理的 production 可达缺陷**。

## 修复边界

不增加 `npm_config_audit`、`npm_config_fund` 等环境变量；为每个会 mutation 或进入嵌套 setup 的 npm CLI 调用显式添加 `--no-audit --no-fund`，并将 `npm run` 的 flags 放在 `run` 之前，避免传递给子脚本。继续保留 `NPM_CONFIG_REGISTRY` 对 global install 与 setup invocation 的传递，子进程通过既有 `env` 继承该 registry。
