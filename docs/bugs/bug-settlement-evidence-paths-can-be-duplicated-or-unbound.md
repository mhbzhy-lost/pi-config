# Bug：结算证据路径可被重复或未绑定

## 现象
结算若只比较 Agent 的完成描述、criterion 名称或 YAML 文本，执行者证据与复核者证据可能是同一份内容的改写，仍被误认为两条独立路径。

## 影响
攻击者或故障流程可复用同一 reference、替换 ID/描述、调整数组顺序，绕过独立复核；相对路径、未知字段和过大内容还可能把未受控数据带入结算记录。

## 根因
证据缺少严格 canonical schema、与 dispatch identity 的逐字段绑定，以及基于不可变 reference 的独立性检查；写盘也没有统一的内容寻址与原子权限策略。

## 复现条件
1. 提交 identity 不完整或与预期 run/HEAD 不同的 YAML；或加入未知字段。
2. 让 reviewer YAML 复用 executor 的任一 evidence/output reference，只改 criterion ID、描述或顺序。
3. 提交相对 reference、内联完整输出/secret，或超出上限的字段。

## 期望行为
normalize 必须拒绝上述输入，criterion 必须精确覆盖 contract 快照；成功 outcome 只能包含 satisfied criterion。两路径必须 identity 相同、各自 fingerprint 不同且 immutable refs 完全不相交。YAML 必须稳定、只保存 refs、以 0600 临时文件 rename 到 SHA-256 内容寻址文件。

## 修复方案
提供 settlement evidence codec：严格 normalize、语义 fingerprint、稳定 YAML serializer、独立路径断言，以及 0600 temp+rename materialization；本修复不接线 `goal_settle`。
