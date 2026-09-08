# pi-subagents 0.62.0 编译 async runner 路径错误

## 复现（RED）

fresh 安装后的 `node-runtime.tsconfig.json` 以 `rootDir: "."`、`outDir:
"./node-runtime"` 编译上游源码。实际产物是
`node-runtime/src/runs/background/async-execution.js` 和
`node-runtime/src/runs/background/subagent-runner.js`，但前者保留了运行时动态字符串
`"subagent-runner.ts"`。`tsc` 的相对 import extension rewrite 不会改写该字符串，
所以 package verify、Doctor 和真实 async spawn 会尝试加载不存在的 TS runner。

首次偏离发生在 `src/runs/background/async-execution.ts` 的 `path.join` runner 构造：
它不是静态 import，无法由编译器重写。此前 verify 错误地假定/检查了编译树的一部分，
未把实际 runner 字符串与同一输出根绑定。

## 修复边界

安装期 patch 从 tsc `outDir` 导出唯一的 `compiledNodeRuntimeRoot`/`Path` helper。
编译、安装 setup、verify 和 ordered-models runtime patch 共用它；编译完成后只在安装的
`node-runtime/.../async-execution.js` 将 runner 重写为同目录
`subagent-runner.js`，并验证两个 JS 产物和 package exports。上游 tracked TS 源码及
增强包内的 `node_modules` 生成物不提交。
