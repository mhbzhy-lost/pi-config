# Bug：升级期间 Pi 默认模型设置被并发写入

## 1. 现象

升级开始前，`pi/settings.json` 的默认配置为 `codex-pool/gpt-5.6-sol`，`defaultThinkingLevel` 为 `minimal`。完成 Pi 和 extension 安装后，文件变为 `anthropic-idealab/claude-opus-4-6`，thinking 为 `low`；本次升级代码只计划修改版本和 package source。

## 2. 影响

如果把该变化误判为 `pi install` 副作用并直接恢复旧值，可能覆盖用户或并行进程在升级期间产生的最新配置。版本升级本身不依赖默认模型，因此不应把模型选择纳入升级写集。

## 3. 触发条件与证据

- 升级前 `git diff -- pi/settings.json` 只显示 `defaultThinkingLevel: xhigh -> minimal`。
- 安装后文件 mtime 为 `2026-07-30 20:09:56`，diff 额外出现 provider/model/thinking 变化。
- 没有运行中的独立 `pi`/`pi-subagents` OS 进程可由 `pgrep` 定位。
- 在独立临时 `PI_CODING_AGENT_DIR` 中，先写入 `codex-pool/gpt-5.6-sol/minimal`，再分别执行官方 registry 的 `pi install npm:@juicesharp/rpiv-todo@2.2.0` 与 `pi install npm:pi-subagents@0.37.2`；三项值均保持不变。
- 后续只运行 `npm run setup:plan-runtime` 后，主配置又从 `anthropic-idealab/claude-opus-4-6/low` 变为 `codex-pool/gpt-5.6-sol/low`；setup 脚本不读取或写入 `pi/settings.json`，进一步证明存在外部并发写入。

## 4. 根因

直接安装路径已被隔离实验排除。主配置在本次长会话期间存在外部并发写入，写入者未能从进程列表和命令输出中唯一定位。根据仓库并发工作树约束，该变化应视为用户或其他生成进程的最新状态，不能由升级任务回退。

## 5. 处理决策

- 保留任务执行期间观察到的最新 provider/model/thinking 值，不按升级开始时的快照回退。
- 升级只继续维护 `lastChangelogVersion` 和两个 package source。
- 不为未定位的外部写入者添加猜测性锁或覆盖逻辑。

## 6. 验证

完成升级后通过 `git diff -- pi/settings.json` 确认版本字段正确，且后续安装和测试不再改动 provider/model/thinking。最终报告明确披露该并发变化，避免把它归入升级实现。
