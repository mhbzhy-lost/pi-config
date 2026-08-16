# Condition evidence 未与当前世界对齐

## 问题
旧实现把路径哈希后丢失 scope 比较能力，并让 capture 的字段与 freshness 读取字段断裂；它只比较 HEAD 相等，且从 evidence 自行拼装 authority。CAS 读取也没有覆盖目标替换窗口，导致外部提交、工作区改动、注册表漂移或替换文件可能被误判为可复用证据。

## 复现
1. 观察后切换到 descendant commit，或产生 tracked/untracked、冲突、rebase/cherry-pick 等 Git 状态。
2. 改变 adapter 版本、environment/fixture 指纹或可用性、resource/run identity，或提供未知 diff/scope。
3. 用错误 goal、condition、revision、hash、HEAD、run、proof、artifact 或调用者 classifier 的 evidence 物化/派生 verdict。
4. 在 lstat 与读取、临时文件写入、发布或目录 fsync 之间替换 CAS 目标；或复用、乱序、跨 Condition/revision 的 stability evidence。

## 修复
Snapshot 保留已校验的 repo-relative 路径、完整冻结事实和结构化 unsafe 原因；freshness 只接受祖先关系和 NUL-safe name-only diff 的完整不相交证明，并逐项绑定 registry/resource/run。expected identity 与 classifier 均由 Host 独立提供；CAS 在 realpath 边界内使用 no-follow、身份稳定检查、0600/0700、no-replace 与 fsync。Condition 图只返回 freshness/applicability 事实，按前驱级联失效，并逐份审计 stability history。
