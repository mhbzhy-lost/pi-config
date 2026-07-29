# Bug: plan.amended reducer 缺少输入边界与 supersede 栅栏

## 症状
`plan.amended` reducer 对 `requestId` 和 `reason` 只做非空检查，未执行工具 schema 的 ID 格式与 4096-byte 上限；当 projection 已有 `supersede-requested` Attempt 时仍允许提交下一轮 amendment。

## 影响
Event Writer 的 reducer-before-append 不能独立保证事件合同，绕过 Capsule 的 producer 可写入超长或非法 request identity。连续 amendment 还可能在旧 Attempt 清理未完成时再次改变 effective hash，造成 stop/release 与新 revision 交叉。

## 复现
直接对 revision projection 应用 `plan.amended`：传入包含空格/路径分隔符的 requestId、超过 4096 UTF-8 bytes 的 reason，或先提交一轮产生 `supersede-requested` 后再用新 requestId 提交第二轮；当前 reducer 均可能接受。

## 根因
实现复用了宽松的 `requireIdentity()`，没有复制 amendment schema 的专用边界；supersede 状态集合只用于计算本轮受影响 Attempt，没有把未完成的上一轮 cleanup 作为 amendment 前置条件。

## 修复
新增 amendment request ID 正则与 UTF-8 reason byte 限制；在任何 diff/revision 更新前拒绝 projection 中已有 `supersede-requested` Attempt。保持 request replay 与 revision chain 的既有验证顺序。

## 验证
新增 reducer RED 测试覆盖非法 requestId、reason 空白、4097-byte reason、已有 supersede-requested 时第二轮 amendment；修复后 focused event/amendment/Event Writer 回归通过，并断言失败不修改输入 projection。
