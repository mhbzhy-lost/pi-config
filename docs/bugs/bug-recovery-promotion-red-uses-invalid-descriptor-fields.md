# Bug：recovery promotion RED 使用非法 descriptor 字段

## 现象

`dea5332` 的 recovery promotion tests-only RED 有 6 个目标：一个成功的 descriptor 提升用例、四个 security rejection 用例，以及独立的 method-missing 用例。成功 fixture 顶层包含 pinned schema 未知的 `sentinel` 与 `sentinelNested`，并且 `artifactConfig` 仅写入 `enabled: true`。pinned `readAsyncRecoveryDescriptor` 会先拒绝这两个未知字段，且要求 `artifactConfig` 具备五个布尔字段和非负整数 `cleanupDays`，因此该成功 fixture 本身不能被严格 parser 读取。

## 触发条件

在 production 按既定决策复用严格 `readAsyncRecoveryDescriptor` 读取 `recovery-descriptor.json` 后，运行该 RED。成功 case 在 bootstrap tools 提升之前即因 descriptor 非法失败；它不能证明目标行为。四个 security case 应继续分别产生 `Missing expected rejection`，method-missing case 也必须保持独立，不能被 fixture parser 失败掩盖。

## 根因

测试为了证明非 `tools` 字段在提升后保留，添加了 `sentinel` 和 `sentinelNested`，但没有按 async-resume 的 `allowedFields` 建模 descriptor。`artifactConfig` 同样只使用了最小片段，未按 async-resume 所要求的完整结构建模。这使测试 fixture 的表达能力超过了上游 recovery descriptor 合同。

## 风险

若直接按当前 RED 编写 production，为令成功 case 通过，只能绕过或放宽 strict parser，接受上游不会接受的 descriptor。这会让 recovery 路径失去 fail-closed 边界，并造成 production 与 pinned async-resume 对 descriptor 合同的分歧。生产必须复用严格 `readAsyncRecoveryDescriptor`，不得自建宽松 parser。

## 修复

仅修正测试 fixture：删除未知的 `sentinel` 和 `sentinelNested`；将 `artifactConfig` 补齐 `enabled`、`includeInput`、`includeOutput`、`includeJsonl`、`includeMetadata` 与 `cleanupDays`，可选加入 `includeTranscript`。用已允许的 `extensions`、`skills`、`systemPrompt` 等字段证明其他非 `tools` 内容会被保留。不得减少 RED 数量，不得修改 production。

## 验证

修正后运行既有聚焦命令，结果仍应为 1 pass、6 fail：成功 case 仍实际执行 bootstrap tools 的目标断言；四个 security case 仍为 `Missing expected rejection`；method-missing case 保持独立。确认修复提交仅含测试文件，production 相对 `dea5332` 不变；本 bug 文档用于记录 fixture 缺陷，不改变上述 RED/GREEN 边界。
