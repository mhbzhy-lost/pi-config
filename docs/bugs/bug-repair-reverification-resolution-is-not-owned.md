# 修复复验结论未绑定归属证据

修复 Episode 的完成结论曾只检查最新一次通过，导致同一 Condition 的未归属通过证据可混入连续稳定性证据链。

## 可复现流程

1. 为连续通过次数为 2 的 Condition 打开修复 Episode。
2. 先记录一个未链接到该 Episode 的通过观察，再记录一个已链接观察的通过结果。
3. 当前实现会仅因最新观察归属该 Episode 而产生 `repair.episode_resolved`，且事件没有完整的运行与证据身份。

## 修复方案

定义含当前 `runId`、`evidenceId` 及有序完整 `supportingEvidenceRefs` 的规范完成 payload；计划器和 reducer 都逐项验证这些引用属于同一 Episode、对应已记录的同 Condition PASS 证据和精确运行身份，并把深拷贝的 resolution identity 保存到 Episode。
