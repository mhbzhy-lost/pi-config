# Condition evidence 未与当前世界对齐

## 问题
旧的运行时投影可把过期的观察结果当作仍满足的 Condition，外部提交、工作区改动或运行环境漂移均可能绕过复验。

## 复现
1. 在观察后产生外部 commit，或修改已跟踪/未跟踪文件。
2. 让 Git 状态、合并冲突、sequencer、仓库根符号链接，或 adapter/environment/fixture/resource/run 清单不可证明。
3. 使用旧 evidence 或重复、跨 Condition 的 supporting evidence 计算满足状态。

## 修复
捕获脱敏的 fail-closed Current World Snapshot；仅接受完整绑定的 Host artifact evidence；以完整不相交证明 freshness，并按 Condition DAG 级联失效和审计 stability。
