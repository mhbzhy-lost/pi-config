# Bug：Supervisor grant-failure RED 在失败结算前提前发送 ingress

## 症状

新增started grant失败资格RED等待 `ownedRuns.has(runId) && !principals.has(runId) && executorGrants.size === 0` 后发送迟到Supervisor request。focused结果返回 `code: undefined`，但pending、reservation和context又都是零。

这表示request不是在grant失败后发送，而是在started observation写入ownedRuns、尚未进入 `ensureExecutorOwner()` 的短窗口发送；随后grant失败cleanup把它释放。

## 影响

测试虽然RED，但只证明grant进行中的合法暂存，不证明review指出的“grant失败完成后ownedRuns仍让新request重新积压”。若按该结果实现拒绝grant进行中的request，会破坏A2需要的真实owner绑定前窗口。

因此当前RED可能诱导错误GREEN：过早撤销ingress资格，而不是在失败结算点撤销并允许合法重试恢复。

## 复现

1. `subagent:async-started` listener同步写入ownedRuns，然后在异步函数中await birth capture。
2. 立即检查ownedRuns存在、principal不存在、executorGrants为空；条件成立。
3. 此时发送Supervisor request，被ownedRuns证明为known并暂存。
4. 后续ensure grant失败调用release，断言时pending已清零但route result仍是undefined。

## 根因

等待条件描述的是“ensure尚未开始”与“ensure已经失败”两个状态的并集，缺少started observation promise的settlement barrier。`events.emit()`不await listener返回的promise，单看Map瞬时状态无法区分。

测试误把最终collection清空当成request一开始就被拒绝。

## 修复

在emit后先await现有`events.settled()`事件循环barrier，让birth capture、ensure rejection和observation catch完成；随后再用原Map条件确认principal与executorGrants都已释放。只有此后发送的request才是失败后的迟到ingress。

不覆盖observeStarted或ensureExecutorOwner，不向production暴露新的测试hook。

## 验证

修正后当前production应返回undefined并保留pending/reservation/context，明确因ownedRuns继续授予资格而RED。GREEN后同一时点返回 `supervisor_request_unknown_owner` 且零引用；显式ensure重试后同requestId重新合法入队。

与normal-close和close lifecycle focused测试串行运行，Node必须自行退出。
