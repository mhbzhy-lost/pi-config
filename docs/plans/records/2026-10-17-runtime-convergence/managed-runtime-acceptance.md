# T27：H1/H2/H3 跨层验收状态

| 项 | 状态 | 证据 | 未覆盖 |
| --- | --- | --- | --- |
| H1 opaque intent ID | `behavior-verified` | fresh CLI ask/managed 2 场景 exit 0；wire focused 8 项（含复合 `call_*\|fc_*`）；typecheck | 其它 provider 的 ID 形态未穷举 |
| H2 bound release proof 收紧 | `behavior-verified` | focused 组合 69/69；本轮真实 `release` 因缺 observed proof 返回 `MANAGED_WORKSPACE_TERMINAL` | 真实删除事故重演、跨 owner orphan 全拓扑 |
| H3 public/queue 处置分离（含 T25A/B/C） | `code-implemented，未验证` | typecheck、合同文档 `workspace-disposition-contract.md`、`settlement-window-audit.md` | 七个新故障窗口、新 settlement/replay API、startup barrier mutation 门禁、跨仓分区隔离均零行为覆盖 |

## 建议验收范围（待授权，未实施）

见 `settlement-window-audit.md` 末节：逐窗口注入 + replay 幂等、intent 补建与不可变字段核对、receipt/handoff 半写防护、startup barrier 门禁与两种 listen 路径一致、分区隔离。全部可复用既有 fault 注入与临时 ledger fixture，不需真实 provider、网络、SIGKILL 或真实 workspace。

## 结论

不得把 H3 写成已闭环；也不得用旧发布链四窗口（`after-prepared`/`after-intent`/`after-merge`/`before-queue-complete`）的通过替代新窗口证据。
