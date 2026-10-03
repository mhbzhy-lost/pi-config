# pi-config 主仓收口交接

更新时间：2026-10-03

## 当前权威仓

- 唯一权威仓：`/Users/leshi.zhy/pi-config`
- 当前分支：`main`
- 当前 HEAD：`3d6ed1e`
- 工作区：干净
- `0.87.1` 升级分支的最终提交 `4082154` 已合入当前 `main`，`git merge-base --is-ancestor 4082154 HEAD` 成功。
- 不要再把 `/Users/leshi.zhy/pi-config-upgrade` 当作代码源；其中没有未合入 main 的 tracked 提交。

## 当前版本

- Pi core：`0.87.1`
- `pi-subagents`：`0.71.0`
- 全局 Pi：`0.87.1`
- Basic Memory：`0.22.1`

权威版本核验：读取绝对路径 package.json，不使用受环境变量覆盖影响的 `pi --version`：

```bash
node -e 'console.log(require("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json").version)'
node -e 'console.log(require("./packages/pi-subagents-enhanced/package.json").dependencies["pi-subagents"])'
```

## 已完成的收口结果

- `npm test`：`956 tests / 955 pass / 0 fail / 1 todo`
- integration gate：`35 files / 243 pass / 0 fail / 0 todo`
- `typecheck:root`：通过
- `typecheck:subagents-enhanced`：通过
- `test/init-pi.test.mjs`、`test/setup-subagent-runtime-deps.test.mjs`、`test/pi-shell.test.mjs`：`14/14` 通过
- B9：非法 `ps` 输出不再伪造 process birth identity
- B5/C3/C4/C8/C9/C10：诊断可观测性增强已完成
- T8 与 runtime 集成排除已解除
- 结束 child 的自动 `resume` 已按产品决定下线：保留 queue/worktree/proof/owner 检查和 durable intent，改为生成 `subagent-integration-handoff`，通知主 Agent 接管 worktree、提交修改并完成 merge queue
- 普通控制面 `resume`、运行中 child 的 lease heartbeat renewal 保留
- `pi-new` 函数及专属测试已从主仓移除
- shell 集成已收敛到主仓 `scripts/pi-shell.zsh`
- `init-pi.sh` 已改为主仓路径，并包含全局 Pi、enhanced runtime、skills/settings、Basic Memory、npm test、doctor、integration gate 初始化流程

## 新会话首先执行

```bash
cd /Users/leshi.zhy/pi-config
git status --short
git branch --show-current
git log --oneline -5
```

预期：分支 `main`、工作区干净、HEAD `3d6ed1e` 或其后续提交。

然后阅读：

- `HANDOFF.md`
- `HANDOFF-2026-10-03-main-consolidation.md`
- `docs/plans/2026-09-30-main-merge-and-consolidation.md`

## 升级仓清理

`/Users/leshi.zhy/pi-config-upgrade` 目前仍保留，是因为一个旧的 `pi-new` 会话可能仍在使用该目录。**不要在该会话结束前删除目录，也不要主动杀掉该会话。**

确认不再有旧会话使用后，才执行：

```bash
rm -rf /Users/leshi.zhy/pi-config-upgrade
```

之后可删除本地升级分支引用（若仍存在）：

```bash
git branch -D upgrade/pi-stack-0.87 2>/dev/null || true
git update-ref -d refs/remotes/local/upgrade-pi-stack-0.87 2>/dev/null || true
```

删除前必须再次确认：

```bash
git -C /Users/leshi.zhy/pi-config status --short
git -C /Users/leshi.zhy/pi-config log --oneline --all --decorate -5
```

## 旧仓库 migration debt

`doctor` 可能继续报告旧仓库只读路径：

```text
/Users/leshi.zhy/pi-config/var/workspaces
```

这是历史 state-root migration debt。不要修改或删除旧仓库数据；只记录并向用户说明。

## 下一阶段

0.87.1 已合并并完成全局切换。下一步若开始新版本升级，应从 `/Users/leshi.zhy/pi-config` 的 `main` 创建独立分支；不要恢复 `pi-new`，不要重新使用 `pi-config-upgrade` 作为权威代码仓。0.99.1 属于新的独立升级轮次。

所有测试命令遵循：

```bash
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp <command>
```
