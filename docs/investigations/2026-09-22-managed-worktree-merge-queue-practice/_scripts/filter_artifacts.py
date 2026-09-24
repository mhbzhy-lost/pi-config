#!/usr/bin/env python3
from pathlib import Path
import json, re, datetime
ART=Path('/Users/leshi.zhy/new-api-account-pool/.pi-subagents/artifacts')
OUT=Path('/tmp/wt-analysis/reports/child-artifact-index.json')
need=('85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0','01a0bcca-9b19-751c-a28f-ba65e7d2b6e8','migration/v0.2.7-dual-pool','managed worktree')
items=[]
for p in ART.glob('*_meta.json'):
    try:
        raw=p.read_text(errors='replace'); x=json.loads(raw)
    except Exception: continue
    if any(s in raw for s in need) or p.stat().st_mtime>=datetime.datetime(2026,9,21,tzinfo=datetime.timezone.utc).timestamp():
        prefix=p.name[:-10] # remove _meta.json
        files=[]
        for q in ART.glob(prefix+'*'):
            files.append({'path':str(q),'size':q.stat().st_size,'mtime':datetime.datetime.fromtimestamp(q.stat().st_mtime,datetime.timezone.utc).isoformat()})
        items.append({'prefix':prefix,'meta_path':str(p),'mtime':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat(),'meta':x,'files':files,'matches':[s for s in need if s in raw]})
items.sort(key=lambda z:z['mtime'])
OUT.write_text(json.dumps(items,ensure_ascii=False,indent=2))
print('items',len(items),OUT)
for i in items:
 print(i['mtime'],i['prefix'],i['matches'], i['meta'].get('runId'),i['meta'].get('cwd'))
