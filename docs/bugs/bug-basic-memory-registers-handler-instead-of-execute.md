# Bug：Basic Memory 工具使用过期执行入口导致全部调用失败

## 1. 现象

Pi 能发现并向模型暴露 `memory_search`、`memory_read`、`memory_context`、`memory_recent` 和 `memory_write`，但调用任一工具都会在进入 Basic Memory CLI 前失败：

```text
definition.execute is not a function
```

## 2. 影响

五个本地持久存储工具均不可用。模型看到工具已注册，实际却无法搜索、读取或写入笔记，容易把注册成功误判为持久化成功。

## 3. 稳定复现

在当前 Pi 会话中调用任一 `memory_*` 工具，例如：

```text
memory_write({ title, folder, content, project })
```

或者对 `createBasicMemoryExtension()` 注册出的工具按当前 Pi Custom Tool API 调用 `execute(...)`；注册结果没有 `execute` 方法。

## 4. 证据

- `pi/extensions/basic-memory.ts` 加载 `scripts/lib/basic-memory-extension.mjs`。
- `scripts/lib/basic-memory-extension.mjs` 通过 `pi.registerTool()` 注册工具，但只提供 `handler(params)`。
- 当前 Pi Extension 文档规定 Custom Tool 必须提供 `execute(toolCallId, params, signal, onUpdate, ctx)`。
- 既有 `test/basic-memory-extension.test.mjs` 直接调用 mock 工具的 `handler()`，因此测试通过但没有覆盖真实 Pi 调用边界。
- 报错发生在 Pi 查找 `definition.execute` 时，早于 `basic-memory` CLI 启动。

## 5. 根因

Basic Memory Extension 沿用了旧的或自定义 mock 约定 `handler`，没有实现当前 Pi 的 `execute` 合同；单元测试又复制了同一错误约定，只验证内部 mock 能调用 `handler`，未验证 Pi 实际消费的工具定义及返回结果结构。

## 6. 修复与回归标准

1. 先增加按当前 Pi 签名调用注册工具 `execute(...)` 的 RED 测试，并确认其因 `execute` 缺失而失败。
2. 五个工具统一注册 `execute`，返回 Pi ToolResult 结构：`content` 为文本内容数组，并提供 `details`。
3. 保留现有命令参数、`--local`、秘密拒绝、错误传播和 50KB 截断行为。
4. 测试不再调用非 Pi 合同的 `handler`，避免再次用 mock 掩盖真实注册错误。
5. `node --test test/basic-memory-extension.test.mjs` 与相关 Doctor 门禁全部通过。
