#!/usr/bin/env python3
import json,re,subprocess
from pathlib import Path
root=Path('/Users/leshi.zhy/pi-config')
out=Path('/tmp/wt-analysis/reports')
plans=['2026-09-20-subagent-lifecycle-overall.md','2026-09-12-pi-0851-repository-merge-queue.md','2026-09-16-durable-fifo-resumed-child.md','2026-09-16-five-child-convergence.md','2026-09-20-subagent-orphan-recovery.md','2026-09-10-unified-delegation-workspace-harness.md']
keywords=['queue','coordinator','admission','proof','settle','settlement','worktree','cleanup','reclaim','rebind','schema','contract','workflow','submodule','inspect','reminder','paused','model','path','stderr','artifact','orphan','resume']
res={"plans":{},"bugs":{},"git":{}}
for fn in plans:
 p=root/'docs/plans'/fn
 text=p.read_text(errors='replace') if p.exists() else ''
 lines=text.splitlines()
 checks=[]
 for i,l in enumerate(lines,1):
  if re.search(r'[-*] \[[ xX]\]',l):
   checks.append({'line':i,'checked':bool(re.search(r'\[[xX]\]',l)),'text':l[:500]})
 res['plans'][fn]={'exists':p.exists(),'lines':len(lines),'checked':sum(x['checked'] for x in checks),'total':len(checks),'items':checks}
for p in sorted((root/'docs/bugs').glob('*.md')):
 text=p.read_text(errors='replace'); low=text.lower()
 hits=[k for k in keywords if k in low]
 if hits:
  lines=text.splitlines(); excerpts=[]
  for i,l in enumerate(lines,1):
   if any(k in l.lower() for k in hits) and (re.search(r'root cause|根因|修复|fixed|status|状态|test|测试|commit|提交|结论|resolution|解决',l,re.I)):
    excerpts.append({'line':i,'text':l[:500]})
  res['bugs'][p.name]={'lines':len(lines),'hits':hits,'excerpts':excerpts[:80]}
res['git']['status']=subprocess.run(['git','status','--short'],cwd=root,text=True,capture_output=True).stdout
res['git']['diff_names']=subprocess.run(['git','diff','--name-only'],cwd=root,text=True,capture_output=True).stdout.splitlines()
res['git']['diff_stat']=subprocess.run(['git','diff','--stat'],cwd=root,text=True,capture_output=True).stdout
res['git']['log']=subprocess.run(['git','log','--oneline','-40'],cwd=root,text=True,capture_output=True).stdout.splitlines()
(out/'coverage_extract.json').write_text(json.dumps(res,ensure_ascii=False,indent=2))
print(json.dumps({"plans":{k:(v['checked'],v['total']) for k,v in res['plans'].items()},"bug_count":len(res['bugs']),"diff_files":len(res['git']['diff_names'])},ensure_ascii=False))
