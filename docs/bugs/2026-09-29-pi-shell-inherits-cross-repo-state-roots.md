# Bug：pi-shell.zsh 条件默认导致跨仓状态根继承（新仓写旧仓目录）

- 发现日期：2026-09-29
- 发现方式：footer 幽灵条目诊断（var/upgrade/footer-bug-diagnosis.md 待诊断 4）的次要发现，经主 agent 现场复核确认
- 严重级别：P0（违反用户核心约束「所有改动仅在新仓执行，不可影响旧仓」：新仓会话的 broker authority 状态写入旧仓目录）
- 分类：类别 1（预期 production 数据未被正确处理）——真实 pi-new 启动链、真实环境继承、真实状态写入

## 现象与证据

- 当前会话环境（pi-new 启动）：
  - `PI_CONFIG_HOME=/Users/leshi.zhy/pi-config-upgrade`（✓ 新仓）
  - `PI_CODING_AGENT_WORKSPACE_DIR=/Users/leshi.zhy/pi-config-upgrade/var/workspaces`（✓ pi-new 显式设置）
  - **`PI_CODING_WORKSPACE_DIR=/Users/leshi.zhy/pi-config/var/workspaces`（✗ 旧仓！）**
  - **`PI_CODING_GOAL_DIR=/Users/leshi.zhy/pi-config/var/goals`（✗ 旧仓！）**
- 旧仓 `var/workspaces/root-broker-authority/` 目录 mtime **2026-09-29 16:37**——正是本会话派发首批 subagent 的时刻（40 个条目），实证新仓会话状态写入旧仓。
- 新仓自身 `var/workspaces/root-broker-authority/` 最后写入 12:35（升级验证期的测试进程）。

## 泄漏链（完整调用链）

1. 旧仓 `scripts/pi-shell.zsh` 的 `pi-new()`（:44-69）env 块显式设置 `PI_CONFIG_HOME/PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR/PI_CODING_AGENT_GOAL_DIR/PI_CODING_AGENT_WORKSPACE_DIR/PI_SESSION_OWNER_REGISTRY` 等，但**不设置 `PI_CODING_WORKSPACE_DIR` 与 `PI_CODING_GOAL_DIR`**；
2. 用户 shell 中早前旧仓 pi 使用已导出 `PI_CODING_WORKSPACE_DIR=$HOME/pi-config/var/workspaces`（连同 `PI_CODING_GOAL_DIR`）；
3. pi-new 内部 `zsh -f -c 'source "$1/scripts/pi-shell.zsh"; …'` 加载**新仓** pi-shell.zsh，其 :5-7：
   ```zsh
   export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-…}"
   export PI_CODING_GOAL_DIR="${PI_CODING_GOAL_DIR:-…}"
   export PI_CODING_WORKSPACE_DIR="${PI_CODING_WORKSPACE_DIR:-…}"
   ```
   `:-` 条件默认**不覆盖继承值**（对照 ：4-5 的 `PI_CONFIG_HOME`/`PI_CODING_AGENT_DIR` 为无条件硬绑定）；
4. 增强层 workspace 全链消费 `PI_CODING_WORKSPACE_DIR`：`src/workspace/coordinator-server.ts:30`、`ledger.ts:434`、`administration.ts:27/:137` 等（stateRoot 默认）→ 新仓会话的 managed workspace/broker authority 状态落旧仓目录。

## 后果

1. **隔离约束违反**：新仓会话状态持续写入旧仓 `var/workspaces/`（含 root-broker-authority）。
2. **跨仓 authority 竞争**：旧仓的其他活跃 Pi 会话与新仓会话共享同一 authority store 文件锁（`durable-storage.ts:26-37` 无等待锁）——这很可能是 footer 诊断 #4 中 `authority_store_unavailable` 派发失败、spawn 无回滚、幽灵 leaf 与重派副本**并行重复执行**（浪费 417k tokens）的诱因或放大器。
3. `PI_CODING_GOAL_DIR` 同类泄漏（本会话未启用 goal runtime，暂无实际写入）。

## 处置

1. **修复已落地（2026-09-29，TDD）**：新仓 `scripts/pi-shell.zsh` :5-7 的 GOAL/WORKSPACE 两行改为优先采用 AGENT_ 前缀变体（pi-new 的权威通道，显式 env 设置）：`PI_CODING_GOAL_DIR="${PI_CODING_AGENT_GOAL_DIR:-${PI_CODING_GOAL_DIR:-…}}"`（WORKSPACE 同构）。非 AGENT 变体保留为裸 source 时的用户覆盖通道（基线用例「preserves custom workspace/goal directory」语义不变）。SESSION 无需修复：pi-new 设置的恰是 pi-shell.zsh 直接读取的同名变量 `PI_CODING_AGENT_SESSION_DIR`，无错位。修复前发现 `PI_CODING_AGENT_GOAL_DIR/WORKSPACE_DIR` 在全仓（pi core + 增强层 + scripts）零消费方——本修复使新仓 pi-shell.zsh 成为首个消费者，正是 pi-new 设计意图的补齐。
2. **验证**：新增用例 `shell integration lets pi-new agent-prefixed state roots win over stale inherited non-agent values`（RED：旧仓残留值胜出 → GREEN：AGENT_ 值胜出）；既有用例 1/2/3 补充 AGENT_ 变体显式清空以保持原意图；`TMPDIR=/tmp node --test test/pi-shell.test.mjs` 9/9 GREEN。
3. **旧仓侧 pi-new 的补充修复**（`-u PI_CODING_WORKSPACE_DIR -u PI_CODING_GOAL_DIR`）：属旧仓文件，**不归本仓改**，登记为 T12 切换准备项；本仓侧修复已足够阻断泄漏（AGENT_ 通道优先于任何继承值）。
4. **旧仓污染残留**：旧仓 `var/workspaces/root-broker-authority` 中本会话写入的条目（16:37 起）与旧仓自身会话的条目混存，**不自动清理**（不动旧仓）；建议用户在 T12 准备或旧仓维护窗口自行甄别清理。
5. **本会话后续仍泄漏**：当前进程环境已定型（PI_CODING_WORKSPACE_DIR 仍指旧仓），修复只对下次 pi-new 启动生效；本会话剩余派发继续写旧仓 authority（功能可用，但违反隔离约束）——已向用户报告，由用户决定是否提前重启会话。

## RED（已观察）

`test/pi-shell.test.mjs`：预设 `PI_CODING_AGENT_GOAL_DIR/WORKSPACE_DIR=本仓路径` + `PI_CODING_GOAL_DIR/WORKSPACE_DIR=旧仓路径` 后 source `scripts/pi-shell.zsh`，断言三个 dir 变量全部解析为本仓路径。修复前实测 RED（goals/workspaces 解析为 `/Users/leshi.zhy/pi-config/var/...` 旧仓值）；修复后 GREEN（9/9）。
