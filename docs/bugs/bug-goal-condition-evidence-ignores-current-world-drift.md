# Condition evidence 未与当前世界对齐

## 问题
旧实现把路径哈希后丢失 scope 比较能力，并让 capture 的字段与 freshness 读取字段断裂；它只比较 HEAD 相等，且从 evidence 自行拼装 authority。CAS 读取也没有覆盖目标替换窗口，导致外部提交、工作区改动、注册表漂移或替换文件可能被误判为可复用证据。进一步地，`worldSnapshot.freshnessProofs` 是调用者可伪造的数据，能够把相关提交误判为 fresh；sequencer 单项探测异常也会被吞掉并误作无 sequencer，既有 evidence 目录还会被 chmod 修复。

## 复现
1. 观察后切换到 descendant commit，或产生 tracked/untracked、冲突、rebase/cherry-pick 等 Git 状态。
2. 改变 adapter 版本、environment/fixture 指纹或可用性、resource/run identity，或提供未知 diff/scope。
3. 提供伪造的 `freshnessProofs`，或在 sequencer 探测时使 Git 单项命令失败。
4. 用错误 goal、condition、revision、hash、HEAD、run、proof、artifact 或调用者 classifier 的 evidence 物化/派生 verdict。
5. 在 lstat 与读取、临时文件写入、发布或目录 fsync 之间替换 CAS 目标；或预先创建 mode/identity 不符的 evidence 目录。

## 修复
Snapshot 保留 canonical realpath repo root 供 Host 内部 Git 验证，并只对非 model-facing snapshot 使用；freshness 不读取调用者 proof，而以受控 Git ancestor 与 NUL-safe rename-aware diff 完整证明不相交，并从 durable projection mutation sequence 判定相关 Task。所有 sequencer Git path probe 的异常均使 snapshot unsafe。expected identity 与 classifier 均由 Host 独立提供；CAS 在 realpath 边界内使用 no-follow、身份稳定检查、0600/0700、no-replace 与 fsync，既有不安全目录一律拒绝而不 chmod 修复。Condition 图只返回 freshness/applicability 事实，按前驱级联失效，并逐份审计 stability history。
