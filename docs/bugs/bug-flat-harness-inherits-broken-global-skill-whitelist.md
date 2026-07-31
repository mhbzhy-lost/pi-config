# Bug：Flat Harness 子进程继承无关的全局 Skill allowlist

## 1. 现象

真实 A2 Harness 的所有 Plan Runner 与 Executor 子进程都输出
`missing SKILL.md for allowlisted skill: crash-analyzer-usage`。Harness 已通过 absolute extension 参数提供
deterministic provider、Plan Runner 和 Executor fixture，但子进程仍从仓库全局 `PI_CODING_AGENT_DIR`
加载 `skill-whitelist` extension。当前 allowlist 指向的 Skill 目录不存在，四个 Executor 均被该错误污染。

## 2. 影响

与 flat runtime 行为无关的本机全局 Skill 配置可以改变真实 Harness 结果。即使 Attention reply 路径修复，
Executor 仍可能因全局资源发现错误被标记 failed，导致冻结 HEAD 的唯一真实复验无法判断 production
runtime 是否正确。

## 3. 复现

1. 使用 Harness 当前的 `PI_CODING_AGENT_DIR=<repo>/pi` 启动 Root，并让 child 只声明
   `subagentOnlyExtensions`。
2. 保持 `skill-overrides/skills.list` 含 `crash-analyzer-usage`，但对应目录不存在。
3. 启动任一 Plan Runner 或 Executor。
4. 观察 child 在业务 tool call 前输出 allowlist resource discovery error。

## 4. 根因

Root 使用 `--no-extensions`，但 child 的 `subagentOnlyExtensions` 只增加 child extension，不关闭 ambient
global extensions。Harness 把生产仓库的全局 coding-agent 目录直接传给所有子进程，因此测试 fixture
没有隔离用户可变的 extensions、skills 和 settings。

## 5. 修复

Harness 为真实 Pi 创建最小临时 `PI_CODING_AGENT_DIR`，只提供运行所需目录；Root 与 child 的业务
extensions继续使用已冻结的 absolute paths。project-local `.pi/agents`、真实 installed Pi、persisted
session 和 Root broker拓扑保持不变。不得通过创建伪造 Skill 或修改用户全局 allowlist 掩盖隔离缺口。

## 6. 验证

focused real-Pi startup 测试在仓库全局 allowlist 故意不可用时，临时 Harness agent dir 启动的 child
仍不得加载 `skill-whitelist`，stderr 不含该错误，显式 fixture extension 必须正常执行。最终 A2 Harness
的所有 Executor 具有真实 tool call、official terminal proof 与 exit 0。

该修复只改变测试环境装配，不改变生产 Pi 配置或 Skill 内容。若隔离不足，会在用户本机配置变化时暴露，
修复代价低；若误隔离 project-local agents，则 Plan Runner 无法启动，修复代价中。
