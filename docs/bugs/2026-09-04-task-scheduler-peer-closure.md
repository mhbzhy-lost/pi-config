# 初始化后 task-scheduler 的 ESM peer 依赖闭包缺失

## 数据来源与分类

这是可由正常生产入口稳定产生的 production 缺陷：`init-pi.sh` 的常规初始化会调用 `scripts/setup-subagent-runtime-deps.ts`，随后 Pi 从 `pi/npm/node_modules/@amaster.ai/pi-task-scheduler` 加载调度器。为了在干净环境复现，删除 `pi/npm/node_modules` 与增强包安装目录中本地残留的 `typebox` 后，按该入口执行 setup；不设置额外环境变量，也不手工安装依赖。

与此不同，`test/subagent-dispatch-schema-coercion.test.mjs` 和 `test/subagent-dispatch-validation-errors.test.mjs` 曾直接从已退休的 `pi/npm/node_modules/typebox`、`jiti` 取 fixture 依赖。这些路径不是增强 package 的运行时所有权，也不是上述入口生成的契约，属于测试 fixture 污染；应改为增强 package 的 canonical 依赖闭包路径，而非给生产代码添加兼容分支。

## 首个偏离点

`scripts/setup-subagent-runtime-deps.ts` 的 `buildTaskSchedulerInstallCommand()` 对 scheduler 执行：

```text
npm install --prefix pi/npm --omit=peer --save-exact
```

`--omit=peer` 使 npm 不把 scheduler 的 peer `typebox` 放入 `pi/npm/node_modules`。此前 `pi/npm/package.json` 的 direct dependency `typebox` 或开发机残留目录会偶然掩盖该缺失；手工 `npm install typebox` 虽能令 import 加载，却违反 Doctor 的 `pi/npm must not directly depend on typebox` 边界，不能作为修复。

## Node ESM 调用链

```text
init-pi.sh
  -> scripts/setup-subagent-runtime-deps.ts: installSubagentRuntimeDependencies()
    -> buildTaskSchedulerInstallCommand()
      -> npm install --prefix pi/npm --omit=peer @amaster.ai/pi-task-scheduler
        -> pi/npm/node_modules/@amaster.ai/pi-task-scheduler 的 ESM entry
          -> Node ESM package resolution("typebox"，从 importer 向父目录查找)
            -> pi/npm/node_modules/typebox（被 --omit=peer 省略）
              -> ERR_MODULE_NOT_FOUND
```

因此修复必须让 host 在 `pi/npm` 中拥有 scheduler 所需的 peer，同时保持 `pi/npm/package.json` 不声明 `typebox` direct dependency；增强 package 继续把 Pi core 与 `typebox` 作为 peer，且不在其本地生产依赖中复制它们。
