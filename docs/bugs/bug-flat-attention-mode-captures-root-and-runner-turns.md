# Flat Attention 模式误截获 Root 与 Plan Runner turn

## 1. 现象

A2 provider GREEN在显式state单测中通过，但准备接入真实Harness时发现：Harness只能从Root进程设置`PI_PLAN_HARNESS_ATTENTION=1`，该环境会被Plan Runner和Executor继承。provider把这个flag无条件传为`attentionMode: true`，state又在Root/Plan Runner分支之前执行Executor Attention逻辑。

因此Root首次收到`PI_PLAN_FLAT_ROOT_HARNESS`时没有typed Executor contract，会返回`PLAN_EXECUTOR_ATTENTION_INVALID`而不是调用`plan_run`；即使Root被绕过，Plan Runner bootstrap也会被同样截获，无法调用`plan_open`。

## 2. 真实证据与反证

提交`7113ac2`的41项provider测试全绿，但新增测试只以typed Executor prompt调用`attentionMode: true`，没有覆盖同一flag下的Root Main和Plan Runner turn。代码顺序明确为：解析Root decisions，然后无条件进入`if (attentionMode)`，最后才到Root Harness和Plan Runner bootstrap。

普通A1没有设置该flag，所以原有Root/Runner单测和唯一真实A1 GREEN不能反证A2路径。问题可由纯state输入确定性复现，不需要消耗真实Harness基线。

## 3. 根因

`attentionMode`被错误建模为“当前turn属于Executor”，实际它只是Root级Harness场景开关。进程环境继承不能表达agent role，而state已有更精确的typed Executor判据：approved `deterministicExecutorCommand(userText)`以及可解析的Task ID、Declared Write Scope和`executorRunId`。

无条件分支把场景能力开关误当成调用者身份，扩大了fixture行为面。

## 4. 正确修复

只有同时满足以下条件时才进入Executor Attention状态机：

1. `attentionMode === true`；
2. 当前prompt能映射到唯一approved deterministic Executor command；
3. typed identity/单一write path/executorRunId通过既有marker校验。

flag开启但当前turn不是approved typed Executor时，必须继续执行既有Root、Plan Runner、amendment和compat分支。eligible Executor缺少身份时仍fail closed，不得退回直接bash。

## 5. TDD 验证

先在`test/deterministic-provider.test.mjs`增加tests-only RED：

- Root Main在`attentionMode: true`且无executorRunId时仍调用第一个`plan_run`；
- Plan Runner bootstrap在`attentionMode: true`且有Runner runId时仍调用`plan_open`；
- 现有typed Executor Attention marker和contact-before-bash测试保持通过。

当前实现应精确在前两条返回`PLAN_EXECUTOR_ATTENTION_INVALID`。GREEN只收窄state分支条件，不修改env传播或其他provider状态。

## 6. 影响边界

仅影响启用A2 Attention场景开关的真实多agent Harness；普通provider路径不受影响。若不修，A2在第一个Root turn即停止，无法产生任何Plan、Executor或Supervisor ownership证据。若错误地仅按`executorRunId`判断，Plan Runner同样具有runId，仍会被误截获；修复代价低，但错误识别会使真实基线失效。
