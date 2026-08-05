# Bug: 全局 Skill 自动发现重新暴露已退役 Plan Runner

## 症状
切换到扫描 `~/.agents/skills` 后，真实 Pi RPC 再次暴露 `skill:plan-runner-dispatch`。该 Skill 来自另一套本地配置的全局 symlink，不在本仓库 `skills.list`，因此本次 Plan Runner 删除和生产源码扫描都无法移除它。

## 影响
主仓库虽然已经删除 `plan_run`、launcher 和 Plan runtime，模型仍会看到一个声称可以 `/plan-run` 的 Skill，产生无效调用和错误操作指导；“Plan Runner 无 production launch path”的验收不再成立。

## 复现
在 `~/.agents/skills/plan-runner-dispatch` 放置有效 Skill symlink，启动真实 Pi 并读取 RPC commands。结果包含 `skill:plan-runner-dispatch`，现有真实 Pi integration 因实际命令集合出现该项而失败。

## 根因
新的 `discoverSkillsInDir()` 接受全局目录中所有含 `SKILL.md` 的目录或 symlink，没有退役产品 denylist。跨工具共享目录可以合法保留其他项目的 Skill，但 Pi 配置缺少自己的产品边界过滤。

## 修复
Pi 的 Skill discovery 在全局和项目目录统一排除精确名称 `plan-runner-dispatch`；不删除或修改 `~/.agents/skills` 及其外部目标。其余个人、机器和项目 Skill 继续自动发现。

## 验证
把真实 Pi integration 改为验证必需 Skill 子集、无重复项及退役 Skill 缺席；先观察它因 `skill:plan-runner-dispatch` 仍存在而 RED，再实现精确过滤并重跑真实 Pi、Skill discovery、Doctor、Goal Engine 与全仓回归。
