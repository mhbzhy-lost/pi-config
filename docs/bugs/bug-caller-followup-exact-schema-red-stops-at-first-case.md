# Bug：caller.followup exact schema RED 首 case 遮挡其余 case

## 现象

`test/root-broker-caller-followup-protocol.test.mjs` 的 exact params schema RED 用例把五个非法
`caller.followup.params` 输入放在同一个 `for` 循环中，并在循环体同步调用
`assert.throws`。focused 执行显示 1 pass、1 fail，但失败只报告 `missing wakeId`。

## 影响

`missing reason`、`extra field`、`unsafe wakeId` 和 `unsupported reason` 没有独立 RED 证据。
当前失败结果不能证明 exact schema 已分别覆盖缺失字段、额外字段、不安全 wakeId 与不支持的
reason，也不能作为后续生产 schema 实现的完整 RED 基线。

## 根因

`assert.throws` 在 `missing wakeId` 未抛错时会同步抛出断言失败，立即中止外层 `for` 循环。
后续四个 case 因此不会执行、不会被测试框架记录，也不会出现在 focused 输出中。

## 触发条件

在 production schema 尚未拒绝首个 `missing wakeId` 输入时，执行该 focused 测试。第一个
`assert.throws` 失败后循环终止，测试仅报告该 case 的 RED；即使其余输入同样未被拒绝，也没有
运行证据。

## 修复方案

将每个非法 params case 放入独立的 `t.test`/subtest，或等价地建立彼此独立的 subtest，使单个
同步 `assert.throws` 失败不影响其他 case。修正后的 RED 基线必须明确得到 1 个既有 GREEN 和
5 个独立 RED，且 0 个 cancelled；生产 schema 实现等待该独立 RED 修正完成后再进行。

## 验证标准

执行 focused 测试时，合法 `caller.followup` 用例为 1 GREEN；`missing wakeId`、`missing reason`、
`extra field`、`unsafe wakeId`、`unsupported reason` 分别为 5 RED。测试报告必须显示 0 cancelled，
并能从每个 subtest 的独立结果确认全部五类非法输入均实际执行。
