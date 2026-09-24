# 2026-09-22 Managed Worktree / Merge Queue 调查产物（恢复版）

## 本目录是什么

本目录的 9 份调查报告与提取脚本，是 2026-09-21/22 一次 runtime 归因调查（主 session
`2026-09-21T11-58-07-128Z_01a0c3d4-a118-743f-83c9-97587cbfe21f`）的产物。原始文件当时写在
`/tmp/wt-analysis/reports/`，后被 macOS `/tmp` 清理机制删除。本目录内容于 2026-09-23
**从 child session JSONL（`~/pi-config/var/sessions/`，持久存储）按时间顺序重放工具调用确定性重建**，
并非原始文件的拷贝。

> ⚠️ 文中出现的 `/tmp/wt-analysis/reports/...`、`/tmp/wt-analysis/...` 路径均为**失效的历史引用**，
> 保留原文未改——它们是当时的事实。原始中间产物 JSON（child-map.json 10.4MB、coverage_extract.json
> 507KB 等）未恢复，可由 `_scripts/` 下脚本重跑再生。

## 恢复方法

1. 逐行流式读取 session JSONL，取 `type=="message"` 且 `message.role=="assistant"` 条目中
   `content[].type=="toolCall"` 的 `write` / `edit` / `apply_patch` / `bash` 调用。
2. **以 toolResult 实际成败门控**（`toolCallId` → `isError`）：参数存在 ≠ 已执行。被 runtime
   拒绝的调用（schema 校验失败等）不参与重放。
3. `write` 全量替换；`edit` 按 `edits[]` 逐条 `str.replace(old, new, 1)`；`bash` 仅提取
   `cat >`/`cat >>` heredoc 写入；严格按 session 文件行序处理。
4. `D-error-prevalence.md` 与 `.csv` 当年由 `prevalence_scan.py` 生成而非 write 调用；该脚本
   本身经历了 2 次 write、1 次 edit 和 8 处 `python3 - <<'PY'` 内联变异（其中 L77 变异生效但
   同命令尾部运行失败、L81 变异自身失败未写回——按 result 文本中的 `<stdin>` traceback 区分），
   全部按实际生效顺序重放后重跑生成。
5. 工具链：`_scripts/replay.py`（主 agent 预写）、`_scripts/recover_all.py`（批量重放+统计+交叉
   扫描）、`_scripts/apply_inline_mutations.py`（内联变异重放）。

## 完整性对照表

| 文件 | 来源 session | 恢复操作序列（成功执行） | edit-FAIL | 恢复结果 | 参考值 | 判定 |
|---|---|---|---|---|---|---|
| 00-INTEGRATED-runtime-gap-report.md | MAIN | write + edit | 0 | 24,488B / 303 行 / H2×10 H3×10 | 20.5K 初版+edit 追加，最终更大 | 完整 |
| A-session-forensics.md | 1b3bf0ed | write + edit×3 | 0 | 43,577B / 344 行 / H2×11 H3×19 | 42.6K | 完整 |
| B-dispatch-contract-rootcause.md | 255d91b7 | write + edit | 0 | 43,244B / 661 行 / H2×10 H3×22 | 42.2K | 完整 |
| C-workspace-mergequeue-rootcause.md | 0bbce36c | write + edit×2 +（1 次被拒 edit）+ edit×3 | 0 | 33,925B / 274 行 / H2×12 H3×16 | 33.9K | 完整 |
| D-error-prevalence.md | cd8af2da | 由脚本重跑生成 | — | 15,741B / 233 行 | 14.3K | 完整（live 漂移，见下） |
| D-error-prevalence.csv | cd8af2da | 由脚本重跑生成 | — | 15,393B / 66 行 | 14.8K | 完整（live 漂移，见下） |
| E-coverage-mapping.md | ea54837a |（1 次被拒 write）+ write +（1 次被拒 edit）+ edit×7 | 0 | 28,349B / 138 行 / H2×6 H3×10 | ≈28K / 137 行 | 完整 |
| F-rebaseline-delta.md | 0899302e | write×2 | 0 | 25,044B / 139 行 / H2×7 H3×2 | 138 行 | 完整 |
| G-residuals-confirmation.md | eb81920d | write + edit +（1 次被拒 edit）+ edit×4 | 0 | 35,269B / 228 行 / H2×8 H3×11 | 227 行 | 完整 |

- 全部文件「待填」占位残留为 0；G 与主 agent 事前独立验证的重放产物（`/tmp/recover/G-residuals-confirmation.md`）**逐字节一致**。
- 行数口径：统计为「`\n` 数 +1」，故 E/F/G 显示 138/139/228（参考值 137/138/227 按末行换行口径），差 1 行为计数口径而非内容差异。
- 「被拒」操作 = 该 toolCall 的 toolResult `isError=True`（参数未被文件系统执行），例如 C 的 L71
  edit 因 `edits[]` 序列化畸形（oldText/newText 拆散）被 schema 校验拒绝，agent 随后以 L73 成功重试。

## D 组重生成与原版的差异

`_scripts/prevalence_scan.run.py` 与恢复出的 `_scripts/prevalence_scan.py` 唯一差异是
`OUT`（输出目录）从 `/tmp/wt-analysis/reports` 改指本目录——恢复期的必要调整。重跑扫描
`var/sessions/*.jsonl`（只读）时目标会话是 live 的：会话数 312→316、目标会话 Started 64→104、
toolResults 相应增长，因此 .md/.csv 数字与 2026-09-21 原版存在系统性偏大，属预期漂移。

## 未恢复 / 未包含

- 中间产物 JSON（`child-map.json`、`coverage_extract.json`、`coverage_targets.json`、`facts.json`、
  `evidence-summary.json` 等）：按计划不恢复，可由 `_scripts/` 脚本重跑再生。
- 主 agent 当时写的三份 `docs/plans/` 计划：不在本目录范围，仓库内另有留存。
