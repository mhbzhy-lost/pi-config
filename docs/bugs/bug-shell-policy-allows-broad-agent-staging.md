# Shell Policy 允许 Agent 宽泛暂存并发文件

## 1. 预期行为

Agent 只能显式列出本任务文件执行 `git add path...`，提交也不得使用自动暂存；并发会话或用户尚未提交的文件不能被当前任务顺带收入提交。

## 2. 实际行为

Shell Policy 只阻止部分不可逆 Git 命令，仍允许 `git add -A`、`git add .`、`git commit -a`。TokenRec 执行中一次宽泛暂存把另一个会话刚创建的计划文档收入了无关提交。

## 3. 稳定复现

对 `checkShellPolicy` 分别传入 `git add -A`、`git add .` 与 `git commit -am "fix: 修复门禁"`，当前均返回 `undefined`，Agent 可继续执行。

## 4. 根因

策略把 Git 风险限定为不可逆操作和提交消息格式，没有把 staging set 视为跨会话共享资源，也没有校验 `add`/`commit` 的宽泛参数。

## 5. 影响范围

同一仓库存在用户改动、并发 Agent 或后台任务时，提交可能混入未审查文件，破坏 WritePaths、证据归属和后续 cherry-pick 的可验证性。

## 6. 修复与验证

增加 Agent shell 的宽泛暂存门禁：拒绝 `git add -A|--all|.|./` 与 `git commit -a|--all`，继续允许显式路径（含 quoted path）。先用 table-driven tests 观察 RED，再实现最小参数校验并运行 `test/shell-policy.test.mjs` 与全量测试。
