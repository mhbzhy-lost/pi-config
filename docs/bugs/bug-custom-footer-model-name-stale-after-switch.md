# Bug：自定义 Footer 切换模型后名称不实时更新

## 1. 现象

在 Pi TUI 中切换模型后，自定义 Footer 继续显示切换前的 provider 和 model；通常要等新模型产生 assistant 消息后才会变化。

## 2. 影响

用户无法从 Footer 判断当前请求将使用哪个模型，容易在成本、能力或上下文窗口不同的模型之间误判当前状态。

## 3. 稳定复现

1. 启动启用 `custom-footer.ts` 的 Pi TUI，并发送一条消息。
2. 通过模型选择器切换到另一个 provider/model。
3. 不发送新消息，观察 Footer。
4. Footer 仍显示上一条 assistant 消息记录的旧 provider/model。

## 4. 证据

Footer 的 `render()` 先从动态的 `ctx.model` 读取当前模型，随后遍历 branch，并用最后一条 assistant 消息的 `provider`/`model` 覆盖该值。Pi 的模型切换路径调用的是内置 `this.footer.invalidate()`；当前扩展没有监听 `model_select`，自定义组件的 `invalidate()` 也是空实现。

## 5. 根因

Footer 混淆了“当前选择的模型”和“上一条消息实际使用的模型”，把历史消息错误地作为当前状态来源；此外，自定义 Footer 未接入模型切换后的重绘信号。两个条件叠加，使名称在下一条 assistant 消息出现前保持陈旧。

## 6. 修复与验证策略

provider/model 始终以动态 `ctx.model` 为准，历史 branch 只用于计算最近一次上下文用量。让自定义 Footer 的 `invalidate()` 请求 TUI 重绘，并在 `model_select` 中调用它。先增加当前模型优先及 invalidate 重绘测试，再实现最小改动并执行扩展加载 smoke test。
