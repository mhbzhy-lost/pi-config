# openai-codex proxy 在 node --test 进程中无法解析 undici

## 现场与 RED
- 入口：`test/openai-codex-proxy-extension.test.mjs:101` 通过公开测试导出 `hostPackageEntryForTest("undici", { inferredRoot: process.cwd() })` 复现。
- RED：`node --test test/openai-codex-proxy-extension.test.mjs` 报 `openai-codex proxy cannot resolve undici from the Pi host package tree`。
- 真实依赖事实：`node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json` 存在；仓库根 `node_modules` 没有顶层 undici。

## 双列归因
这是 production 缺陷。测试只改变 `argv`/推断 root，且依赖树中存在由 Pi Host 拥有的 undici；扩展仅尝试 root 自身 package.json、扩展自身和向上目录，未尝试 Host 包的嵌套 node_modules。失败首个偏离点在 `pi/extensions/openai-codex-proxy.ts:hostPackageEntry`，不是测试伪造依赖或非法入口。

## 最小处置
在既有 root 候选之后增加 Host 包路径候选，以 Host package.json 作为 `createRequire` 解析起点；不引入新依赖、不改变代理行为。
