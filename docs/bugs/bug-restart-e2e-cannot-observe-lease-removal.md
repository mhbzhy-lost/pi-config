# Restart E2E 无法正确观察 Lease 删除

## 现象

更新后的 Parent restart E2E 在等待 `parent-lease.json` 删除时固定超时，并据此报告旧 Parent 未清理 lease。

## 影响范围

仅影响 restart E2E 的新生命周期断言；当前失败不足以证明生产 lease cleanup 有问题。

## 复现步骤

测试调用 `waitFor(leasePath, () => false, 30000)`。该 helper 只有 predicate 返回 true 才成功；文件存在时 predicate 永远 false，文件缺失时又吞掉 `ENOENT` 继续等待，因此两种情况都必然超时。

## 根因

测试未使用同文件已有的 `waitForMissing()`，并保留了“Parent 关闭后 runner 仍 active”的旧合同断言，使新语义和旧观测混杂。

## 修复方案

删除关闭 Parent 后仍要求 active/PID存活的旧断言；先等待原 run terminal 和 PID退出，再用 `waitForMissing()` 验证 lease。恢复响应按实际 `recovery.status` 结构比较同一终态。

## 验证方式

重跑 restart E2E，确认第一 Parent 关闭后旧 run终止且 lease缺失；第二 Parent只观察同一终态，不产生新 handle、async run或 lease。
