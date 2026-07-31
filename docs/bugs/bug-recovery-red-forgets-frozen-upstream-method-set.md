# Bug: recovery RED 遗漏 frozen upstream method set

## 症状

提交 `dea5332` 为 Root upstream recovery 新增 `preparePlanRunnerRecovery` 方法期望，却没有更新现有 `Object.keys(upstream).sort()` 的 frozen method-set literal；该 literal 仍只允许旧的九个方法。当前 production 尚未导出 `preparePlanRunnerRecovery`，所以旧 method-set 测试仍通过；未来 GREEN 增加该方法时，旧测试必然失败。

## 影响

GREEN 阶段必须修改测试，或为保持旧测试通过而隐藏新方法，迫使实现跨越 RED/GREEN 边界。冻结键集合测试与新增的“method exists”测试又重复表达同一份公开 API 合同，无法提供互补的回归保护。

## 复现

运行 `node --test test/subagent-runtime-root-upstream.test.mjs`。当前结果为 7 total、1 pass、6 fail：独立的 method exists 测试通过，而 recovery 提升、路径和符号链接边界、source run id、agent 校验四项预期拒绝仍失败。实现随后导出 `preparePlanRunnerRecovery` 时，旧九方法的 sorted key literal 会失败。

## 根因

RED 新增了重复的“method exists”测试，却未升级作为唯一 method presence 合同的权威 frozen method-set expected literal。测试作者将方法存在性从键集合合同中拆出，遗漏了该 literal 必须随 public upstream surface 同步更新的约束。

## 修复

仅修改测试：在现有 sorted key literal 中加入 `preparePlanRunnerRecovery`，并删除重复的 method exists 测试。其余 recovery 成功路径与 security rejection RED 保持不变，使新增方法仍由单一 frozen method-set 合同覆盖。

## 验证

修正后的目标结果应为 6 total、0 pass、6 fail：method-set 因缺少 `preparePlanRunnerRecovery` 失败、tools 尚未提升失败，以及 4 项 Missing expected rejection 失败。pinned fixture 的校验必须仍先通过，确保失败来自尚未实现的 recovery 行为而非 fixture 漂移。
