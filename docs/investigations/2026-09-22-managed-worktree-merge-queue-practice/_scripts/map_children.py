#!/usr/bin/env python3
"""按首条 user 文本与启动时间，将 nested child session 映射到根 subagent 调用。"""
from pathlib import Path
import json, re, datetime, difflib, collections
S=Path('/Users/leshi.zhy/pi-config/var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl')
D=S.with_suffix('')
OUT=Path('/tmp/wt-analysis/reports/child-map.json')

def cont_text(m):
 c=m.get('content','')
 if isinstance(c,str): return c
 if isinstance(c,list): return '\n'.join((x.get('text') or x.get('thinking') or '') for x in c if isinstance(x,dict))
 return ''
def norm(s): return re.sub(r'\s+',' ',s).strip()
def iso(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
# Root calls
calls=[]; pending={}
for ln,line in enumerate(S.open(),1):
 x=json.loads(line)
 if x.get('type')!='message': continue
 m=x.get('message',{})
 if m.get('role')=='assistant':
  for c in m.get('content',[]) if isinstance(m.get('content'),list) else []:
   if c.get('type')=='toolCall' and c.get('name')=='subagent':
    a=c.get('arguments') or {}; d={'callId':c.get('id'),'line':ln,'time':x.get('timestamp'),'args':a,'result':None}; calls.append(d);pending[d['callId']]=d
 elif m.get('role')=='toolResult' and m.get('toolCallId') in pending:
  d=pending[m['toolCallId']]; d['result']=cont_text(m); d['details']=m.get('details');d['result_line']=ln
# child facts
children=[]
for p in sorted(D.glob('*/run-0/session.jsonl')):
 lines=p.read_text(errors='replace').splitlines()
 if not lines: continue
 first=json.loads(lines[0]); user=''; calls_in=[]; assistant_text=[]
 for i,l in enumerate(lines[1:],2):
  try:x=json.loads(l)
  except:continue
  if x.get('type')!='message':continue
  m=x.get('message',{})
  if m.get('role')=='user' and not user:user=cont_text(m)
  if m.get('role')=='assistant':
   t=cont_text(m)
   if t:assistant_text.append(t)
   for c in m.get('content',[]) if isinstance(m.get('content'),list) else []:
    if c.get('type')=='toolCall':calls_in.append({'line':i,'name':c.get('name'),'args':c.get('arguments')})
 children.append({'dir':p.parent.parent.name,'path':str(p),'sessionId':first.get('id'),'time':first.get('timestamp'),'cwd':first.get('cwd'),'firstUser':user,'toolCalls':calls_in,'assistantText':assistant_text})
# Match only successful starts, similarity using objective/title/task and time window
used=set()
for ch in children:
 best=None
 ct=iso(ch['time']); u=norm(ch['firstUser'])
 for idx,c in enumerate(calls):
  a=c['args']; res=c.get('result') or ''
  if not re.search(r'Started|Resumed',res):continue
  dt=(ct-iso(c['time'])).total_seconds()
  if dt < -5 or dt > 120: continue
  needles=[str(a.get(k,'')) for k in ('taskId','title','objective','task') if a.get(k)]
  score=max([difflib.SequenceMatcher(None,norm(n)[:1200],u[:5000]).ratio() for n in needles]+[0])
  # strong substring
  if any(norm(n)[:80] in u for n in needles if len(norm(n))>=20):score+=1
  cand=(score,-abs(dt),idx,dt)
  if best is None or cand>best:best=cand
 if best and best[0]>=0.15:
  c=calls[best[2]]; ch['match']={'callId':c['callId'],'line':c['line'],'time':c['time'],'deltaSeconds':best[3],'score':best[0],'args':c['args'],'result':c['result'],'details':c.get('details')}; used.add(best[2])
# Output compact summary
x={'rootLineCount':sum(1 for _ in S.open()),'rootLast':json.loads(list(S.open())[-1]),'calls':calls,'children':children,'unmappedChildren':[c['path'] for c in children if 'match' not in c],'unmatchedSuccessfulCalls':[c for i,c in enumerate(calls) if re.search(r'Started|Resumed',c.get('result') or '') and i not in used]}
OUT.write_text(json.dumps(x,ensure_ascii=False,indent=2))
print('children',len(children),'mapped',sum('match'in c for c in children),'unmapped',sum('match'not in c for c in children),'calls',len(calls))
print('cwd',collections.Counter(c['cwd'] for c in children))
print('worktree true',sum(((c['args'].get('execution')or{}).get('worktree') is True or c['args'].get('worktree') is True) for c in calls))
for c in children:
 if '/worktrees/' in (c['cwd'] or '') or (c['cwd'] or '').endswith('/sub2api'):
  m=c.get('match',{}); print(c['time'],c['cwd'],'<= L'+str(m.get('line')), (m.get('args')or{}).get('taskId') or (m.get('args')or{}).get('title'), 'tools',collections.Counter(z['name'] for z in c['toolCalls']))
