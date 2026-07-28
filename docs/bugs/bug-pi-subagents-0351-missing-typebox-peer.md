# Bug: pi-subagents 0.35.1 异步 Runner 缺少 TypeBox

## 现象

通过标准方式安装 `pi-subagents@0.35.1` 后，root extension 能正常加载和响应 RPC，
但 detached async subagent 在模型调用前失败：

```text
Error: Cannot find module 'typebox/compile'
Require stack:
- pi-subagents/src/runs/shared/structured-output.ts
- pi-subagents/src/runs/shared/pi-args.ts
- pi-subagents/src/runs/background/subagent-runner.ts
```

## 影响范围

影响 `async: true`、后台 chain/parallel 和依赖 detached runner 的 Plan Harness。
Foreground extension 加载不一定失败，因为 Pi extension loader 可以解析宿主依赖。

## 触发条件

1. 使用 `pi-subagents@0.35.1`。
2. 扩展安装目录没有可解析的 `typebox/compile`。
3. 启动 detached async runner。

## 根因

0.35.1 将 `typebox` 从直接依赖改成 optional peer dependency。`pi install` 不会自动
安装这个 optional peer，而 detached runner 通过独立 Jiti 进程直接加载
`structured-output.ts`，不能依赖 Pi extension loader 的宿主模块解析。

## 根因证据

- 隔离执行 `pi install npm:pi-subagents@0.35.1` 只安装 3 个包，没有 `typebox`。
- 缺少依赖时 async run 的 `status.json` 记录上述 `MODULE_NOT_FOUND`。
- 在同级 `node_modules` 显式安装 `typebox@1.1.38` 后，相同 Pi 0.82.0 async probe
  完成并返回 `COMPAT_OK`。
- Pi 0.80.10、0.81.1、0.82.0 均能加载 0.35.1 root extension，排除核心
  Extension API 不兼容。

## 修复与防复发

在 `pi/npm/package.json` 中把 `pi-subagents@0.35.1` 和 `typebox@1.1.38` 都声明为
精确直接依赖，不修改 `node_modules` 内发布包。安装后验证：

1. 从 `pi-subagents` 路径可解析 `typebox/compile`。
2. 已安装版本与锁定版本一致。
3. 真实 async child 进入 `complete` 并返回预期输出。
4. 后续扩展更新后重复以上门禁，直到上游发布 host TypeBox 解析修复。
