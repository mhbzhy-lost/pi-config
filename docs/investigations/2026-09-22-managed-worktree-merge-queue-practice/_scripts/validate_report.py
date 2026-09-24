#!/usr/bin/env python3
from pathlib import Path
import json,re,sys
R=Path('/tmp/wt-analysis/reports/A-session-forensics.md')
S=Path('/Users/leshi.zhy/pi-config/var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl')
W=Path('/Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0')
s=R.read_text(); frozen=852
assert 'L852 / 2026-09-21T12:22:36.135Z' in s
refs=[int(x) for x in re.findall(r'\bL(\d+)\b',s)]
assert refs and min(refs)>=1 and max(refs)<=frozen, (min(refs),max(refs))
for h in ['## 1. 摘要','## 2. 完整时间线','## 3. 错误因果链逐条分析','## 4. 死结清单与遗留现场状态','## 5. workaround 清单与 raw Git 使用统计','## 6. 认知负担量化','## 7. merge queue 是否真正生效','## 8. agent 原话痛点摘录','## 9. 错误信息可行动性评估','## 10. runtime 缺口候选清单（需源码确认）']:
 assert h in s,h
# frozen source lines and final timestamp still present even if live file appended
lines=S.read_text().splitlines(); assert len(lines)>=frozen
assert json.loads(lines[frozen-1])['timestamp']=='2026-09-21T12:22:36.135Z'
# current persistent state agrees with described snapshot class
states={json.load(p.open())['workspaceId']:json.load(p.open())['state'] for p in (W/'records').glob('*.json')}
assert len(states)==5
assert list(states.values()).count('cleanup-debt')==4,states
assert list(states.values()).count('active')==1,states
q=json.load((W/'integration-queue'/'0ed45c9b-ec5f-4579-b509-e0bb944a436b.json').open())
assert q['state']=='queued' and q['attempt']==1
proof=json.load((W/'terminal-proof-outbox'/'terminal-proofs.json').open())
assert proof.get('receipts')=={}
assert len(list((W/'worktrees').iterdir()))==5
assert 'managed-workspace-owner.v1:' not in s
assert 'managed-workspace-action.v1:' not in s
print(f'PASS headings=10 citations={len(refs)} citation_range=L{min(refs)}..L{max(refs)} report_bytes={R.stat().st_size}')
print(f'PASS frozen_line={frozen} live_lines_now={len(lines)} frozen_timestamp={json.loads(lines[frozen-1])["timestamp"]}')
print(f'PASS workspace_states={sorted(states.values())} queue={q["state"]} receipts={len(proof["receipts"])} worktree_dirs=5')
