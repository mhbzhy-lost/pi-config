# Lifecycle 恢复 RED 省略空 sessionFile

## 1. 现象

tests-only 提交 `1260553` 新增的 fail-closed fixture 在 `attempt.bound` 里完全省略 `sessionFile`。RED 阶段因 `recoverExecutionState` 不存在，在 reducer 执行前失败，所以未暴露 fixture 非法。GREEN 提交 `4d78922` 为让 77/77 通过，在 `recoverExecutionState` 中 catch exact message `invalid sessionFile`，并翻译成 `Persisted execution binding recovery data is incomplete.`。

## 2. 证据/反证

`plan-events.mjs` 的 `attempt.bound` reducer 规定 `asyncDir`/`sessionFile` 必须是 `null` 或非空 string；`undefined` 既不等于 `null`，也不是 string，因此非法。`coordinator.mjs` 持久化使用 `sessionFile: binding.sessionFile ?? null`，所以合法身份缺失事件是显式 `null`。这不是 durable schema 允许缺字段，也不是 backend completeness 检查本身错误。

## 3. 根因

fixture 把“值缺失”误写成“字段缺失”，而最初 missing-method RED 遮住第二层错误；GREEN 按 reducer 英文文案 catch 是测试驱动过拟合，耦合私有消息并吞掉非法事件原始错误。

## 4. 正确修复

测试 event 单行补 `sessionFile: null`；删除 `recoverExecutionState` 中的 try/catch，直接 `currentProjection(ctx)`；合法 `null` 进入 projection 后由 binding completeness 检查抛 `Persisted execution binding recovery data is incomplete.`。非法 `undefined` 继续由 reducer 原义拒绝。

## 5. 验证

TDD 豁免理由为已有目标 RED 由父级精确复现，这是单行 fixture 合法化和 GREEN refactor，不新增行为。修复后运行 focused dependencies + Capsule，预期 77/77；Root fixed socket 单独串行，预期 131/131。

## 6. 影响边界

只影响测试合法性和错误归属，不改变 durable event schema、backend recovery、订阅顺序、Broker 协议或 Harness 策略。
