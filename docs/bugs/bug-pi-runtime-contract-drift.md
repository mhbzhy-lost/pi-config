# Bug: Pi 运行时契约漂移

## 现象

`npm test` 执行 227 项测试中 6 项失败，`npm run doctor` 因读取不存在的 `agents/skills.list` 而崩溃。失败测试分布于 doctor、global-rules、migration-contract、skill-whitelist-extension、init-pi 和 model-system-prompt 六个文件。

## 影响

- Pi 配置仓主分支无法通过验收基线
- `init-pi.sh` 一键初始化不能闭环（会执行失败测试）
- Plan Capsule 无法启动验证 Gate（doctor 是前提）
- 所有依赖 CI 绿灯的下游工作被阻断

## 时间线

| 时间点 | 事件 |
|--------|------|
| commit `b7a922e` | Skill 清单从 `agents/skills.list` 迁移至 `skill-overrides/skills.list`；`pi/SYSTEM.md` 拆分为 `SYSTEM.qwen.md` 和 `SYSTEM.anthropic.md` |
| 同一 PR | Pi 版本实际升级至 `0.80.10`，但 doctor 和 README 仍写 `0.80.6` |
| 同一 PR | OpenAI Idealab 模型名变为 `Peach-07-17-DogFooding`，但 Qwen 兼容正则仅匹配 `/Qwen/i` |
| 发现时 | 手动执行 `npm test` 确认 221/227 通过 |

## 根因

四项独立的契约漂移同时存在：

1. **Skill/SYSTEM 路径漂移**：`b7a922e` 将主清单从 `agents/skills.list` 移至 `skill-overrides/skills.list`，本地清单对应为 `skill-overrides/skills.local.list`；系统提示从单文件拆为 `SYSTEM.qwen.md` 和 `SYSTEM.anthropic.md`。doctor、测试和文档仍引用旧路径。

2. **Pi 版本常量漂移**：实际安装版本为 `0.80.10`，但 `scripts/doctor.mjs` 中 `PI_VERSION` 常量仍为 `"0.80.6"`，README 也声称只验证 `0.80.6`，`init-pi.sh` fixture 同步落后。

3. **Anthropic temperature 语义漂移**：Anthropic provider 实现不再发送 `temperature` 参数，但 Python reviewer 测试仍断言 Anthropic payload 包含 `temperature`，属于 provider 抽象泄露。

4. **Plan external-review 完成语义漂移**：`docs/pi-plan-execution-capsule.md` 声称 `unavailable` 时 fail-closed，但实际 `gates.mjs` 代码和测试允许 `unavailable` 通过验证。

## 促成因素

- 版本常量分散在 doctor、README、init-pi 三个位置，无单一事实来源
- Skill 路径变更无自动化契约校验，迁移 commit 未同步更新所有消费者
- Provider 抽象不够严格，测试假设 OpenAI 风格参数在所有 provider 通用
- Plan Gate 文档与代码由不同阶段的不同任务产出，缺乏双向一致性验证

## 修复与防复发

**修复：**
- 统一路径为 `skill-overrides/skills.list` 和 `skill-overrides/skills.local.list`
- 将 `PI_VERSION` 统一为 `0.80.10`，README 和 init-pi 同步
- 增加 Peach 模型匹配至 Qwen 兼容集合
- 收紧 Plan `validated` 判定，`unavailable` 不再视为通过
- 增加 Anthropic request rewriter 直接测试

**防复发：**
- 版本常量归集为单一导出，doctor/README/init-pi 共享同一来源
- 为 provider-specific payload 增加独立测试套件
- Plan Gate 文档与代码采用测试驱动一致性：测试引用文档声明
