# 双 Plan flat Harness 错把 async root 当作 TMPDIR 直属目录

## 1. 现象

A1 tests-only提交`ec9b381`新增实际runtime目录独立计数时，构造：

```js
const asyncRoot = path.join(runtimeTmp, "async-subagent-runs");
```

但pinned `pi-subagents`的真实async root是`$TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs`。如果直接冻结并运行真实Harness，`readdir(asyncRoot)`会稳定以`ENOENT`假RED，无法到达双Plan拓扑断言。

## 2. 真实证据与反证

此前task63cj唯一GREEN owned root的所有五个真实status和两个exact `coding-dispatch-handle.v1`均指向：

```text
<runtimeTmp>/pi-subagents-uid-501/async-subagent-runs/<runId>
```

v4 Plan handle的`asyncDir`也使用同一根。现有`assertFutureGreen()`已逐run验证：

- `path.basename(asyncDir) === runId`
- `path.basename(path.dirname(asyncDir)) === "async-subagent-runs"`
- resolved asyncDir位于本次`runtimeTmp`之下

因此production路径正确；错误只在A1新增测试把中间trust-root目录漏掉。

## 3. 根因

A1实现把环境变量`TMPDIR`误当成upstream async artifact root。`TMPDIR`只是upstream用于创建private per-user runtime root的系统临时目录；真实`async-subagent-runs`属于该per-user root的子目录。

测试已经持有两个经过v4 schema/rootSession校验且被`assertFutureGreen()`验证过的Plan Runner handle，却没有复用其authoritative `asyncDir`父目录，转而猜测路径布局。

## 4. 正确修复

只修改flat Harness：

1. 从两个已验证handle的`path.dirname(handle.asyncDir)`取得候选async root。
2. 要求两个候选exact相同，basename为`async-subagent-runs`，且resolved root位于本次`runtimeTmp`之下。
3. 仅对该共同root执行`readdir`并读取status。
4. 保留actual Executor exact 4、Plan Runner包含两个initial handle、全体top-level/no-parent/session/cwd归属断言。

不得硬编码`pi-subagents-uid-501`，因为uid是运行环境事实；不得扫描整个TMPDIR或用glob寻找目录；不得从调用数量反推actual dirs。

## 5. TDD 验证

这是tests-only Harness oracle纠错，无production逻辑变更。RED由task63cj真实GREEN artifact路径与`ec9b381`新增literal直接构成，无需运行一个已知必然`ENOENT`的真实Harness。

修正后运行syntax和deterministic provider suite，确认测试可解析且provider双Plan状态机不变；随后才冻结新HEAD/index/porcelain/root-basename S0，并对新基线只运行一次真实persisted Harness。

## 6. 影响边界

只影响A1实际目录枚举起点，不改变Root broker、upstream runtime、Plan Runner、provider、handle或cleanup。

若不修，下一次真实Harness会在正确业务完成后因错误路径假RED，暴露于目录计数阶段，修复代价低。若改为TMPDIR扫描，则可能进入其他测试或用户遗留root并破坏ownership约束，修复代价高，因此必须从当前owned handle收敛到唯一共同父目录。
