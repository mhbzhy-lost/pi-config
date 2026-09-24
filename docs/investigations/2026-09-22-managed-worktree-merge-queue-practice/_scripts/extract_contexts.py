#!/usr/bin/env python3
from pathlib import Path
import json
S=Path('/Users/leshi.zhy/pi-config/var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl')
targets=[276,304,318,395,397,446,456,497,520,534,548,550,568,571,573,577,583,675,677,679,681,692,700,704,708,716,720,722,724,726,728,734,737,753,755,759,769,772,774,780,784,786,790,792,802,804,806,810,812,816,818,820,823,825,827,829,831,833,836,838,840,843,845]
lines=S.read_text().splitlines(); out=[]
def fmt(i,x):
 s=f"--- L{i} {x.get('timestamp')} {x.get('type')}"
 if x.get('type')=='custom_message': return s+f" {x.get('customType')}\n"+str(x.get('content'))
 if x.get('type')!='message':return s+'\n'+str(x)
 m=x.get('message',{}); r=m.get('role'); s+=' '+str(r)+'\n'
 c=m.get('content')
 if isinstance(c,str):return s+c
 if isinstance(c,list):
  z=[]
  for p in c:
   if not isinstance(p,dict):continue
   typ=p.get('type')
   if typ in ('text','thinking'):z.append(f"[{typ}] "+(p.get('text') or p.get('thinking') or ''))
   elif typ=='toolCall':z.append('[toolCall '+str(p.get('name'))+'] '+json.dumps(p.get('arguments'),ensure_ascii=False))
  return s+'\n'.join(z)
 return s+str(c)
seen=set()
for t in targets:
 for i in range(max(1,t-2),min(len(lines),t+2)+1):
  if i in seen:continue
  seen.add(i);out.append((i,fmt(i,json.loads(lines[i-1]))))
out.sort()
Path('/tmp/wt-analysis/reports/contexts.txt').write_text('\n\n'.join(x[1] for x in out))
print(len(out))
