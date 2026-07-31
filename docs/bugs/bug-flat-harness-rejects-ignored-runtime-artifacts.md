# flat Harness 错把 runtime artifacts 判为工作区污染

## 1. 现象

真实persisted flat Harness在Plan已达到`validated`、两个Task均`accepted/integrated`、两次提交和全部四个gate通过后，最终失败于`assertFutureGreen()`的raw Git洁净断言：

```text
actual:   ?? .pi-subagents/
expected: <empty>
```

该冻结基线只运行一次，报告见`.pi-subagents/artifacts/verification/task63ce-flat-harness-terminal-proof-red.md`。

## 2. 真实证据与反证

Owned accumulator worktree中的`.pi-subagents/artifacts`只包含3代Plan Runner各自的input、meta、output和transcript，共12个runtime evidence文件。`git ls-files -- .pi-subagents`为空，证明没有tracked runtime artifact；raw untracked列表除这些文件外为空。

领域实现有一致约定：

- `workspace.mjs`的Plan workspace inspection忽略untracked `.pi-subagents/`；
- `gates.mjs`的change set忽略untracked `.pi-subagents/`；
- `attempt-validator.mjs`忽略attempt中的untracked `.pi-subagents/`；
- `attempt-workspace.mjs`在释放attempt worktree前删除其runtime artifacts；
- 既有workspace/gates测试明确覆盖该行为。

Plan Runner generation共享accumulator cwd，其transcript是Root-owned runtime evidence，不属于attempt worktree release。最终`plan.validated`记录`worktreeClean:true`，与上述领域定义一致。

## 3. 根因

`test/plan-flat-runtime-harness.integration.mjs`在`assertFutureGreen()`中直接执行：

```js
assert.equal(await git(handle.worktree, "status", "--porcelain"), "");
```

该测试oracle使用Git绝对空作为clean定义，没有复用Plan workspace的“忽略untracked runtime namespace，但禁止tracked runtime files和其他dirty内容”语义。此前Harness未走到validated末尾，因此该过严断言一直未暴露。

## 4. 正确修复

只修改flat Harness测试，新增本地`assertRuntimeClean(cwd)`：

1. 使用NUL分隔的`git status --porcelain=v1 -z`，过滤且仅过滤path以`.pi-subagents/`开头的untracked runtime entries；任何tracked dirty、其他untracked或路径不匹配继续失败。
2. 单独执行`git ls-files -z -- .pi-subagents`并要求为空，禁止通过忽略规则掩盖tracked runtime文件。
3. `assertFutureGreen()`用该helper替代raw空字符串断言；不删除runtime evidence，不修改Plan production clean语义。

不得把整个Git clean断言删除，不得忽略`attempts/`或任意其他目录，不得在Harness验证前清理`.pi-subagents`。

## 5. TDD 验证

本修复属于tests-only oracle纠错，无production逻辑变更。TDD RED由task63ce真实Harness提供：所有前置领域断言通过，唯一失败精确为`.pi-subagents/`。

修复后先运行不触发真实Harness的静态/focused测试，确认helper解析NUL status并拒绝tracked runtime文件。然后冻结新的HEAD/index/porcelain/migration/root-basename S0，只运行一次新的persisted flat Harness；预期同样产生3代Plan Runner、2个exact Executor、official exit 0、最终validated，并通过runtime-aware clean断言。

不得重跑task63ce旧基线。新基线无论GREEN/RED也只能运行一次。

## 6. 影响边界

变更仅影响flat Harness的最终证据判定，不改变Root broker、Plan Runner、Executor、artifact位置、Plan gates、workspace cleanup或用户仓库行为。

若不修，正确保留的Plan Runner transcript会让真实happy path永久假RED，阻塞migration提交；在Plan首次真正validated时暴露，修复代价低。若过滤范围过宽，则可能掩盖真实workspace污染，修复代价高，因此必须同时保留other-dirty检查和tracked runtime fence。
