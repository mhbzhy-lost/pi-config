# pi-subagents 0.62.0 的 Node modules type-stripping 阻塞

## 复现（RED）

在 `packages/pi-subagents-enhanced` 执行：

```sh
node --input-type=module -e 'import("pi-subagents")'
```

Node 26.5.0 报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，首个文件为
`node_modules/pi-subagents/index.ts`。这也在 Goal executor-binding 的
`createTypedSubagentExtension → src/compat/pi-subagents-0.62.ts → pi-subagents`
加载链中先于业务断言出现。

## 来源分类

这是 production dependency packaging 缺陷：增强包声明并 bundle 了固定的
`pi-subagents@0.62.0`，而该上游 package 的 root 和全部 exports 指向 `.ts`。
根 `setup-subagent-runtime-deps.ts` 会安装该副本，再调用 package-local
`setup:runtime`；原有 ordered-models patch 只修改源码，未提供可由 plain Node
加载的公开 JS 入口。不是 Goal 测试 fixture 的解析污染。

## 修复

安装期在应用有版本校验的 ordered patch 后以 TypeScript 5.9.3 编译 pinned
upstream 到其 `node-runtime/`，重写相对 `.ts` import，并把安装副本 exports（含
增强兼容所需的集中式子路径）重定向到生成的 `.js`。生成物仅位于安装的
`node_modules`/bundled dependency，不复制到增强 package `src`，也不使用 loader、
`NODE_PATH`、link 或绝对路径。
