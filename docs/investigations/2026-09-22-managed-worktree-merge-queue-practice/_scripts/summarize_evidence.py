#!/usr/bin/env python3
from pathlib import Path
import json,re,collections,datetime
F=json.load(open('/tmp/wt-analysis/reports/facts.json'))
C=json.load(open('/tmp/wt-analysis/reports/child-map.json'))
OUT=Path('/tmp/wt-analysis/reports/evidence-summary.txt')
# refresh root current independently and parse customs/text around managed
S=Path(F['session']); ev=[]
for i,l in enumerate(S.open(),1):
 x=json.loads(l);x['_line']=i;ev.append(x)
# true errors by details code or error-prefix result
errs=[]
for d in F['errors']:
 det=d.get('details') or {}; code=det.get('code') if isinstance(det,dict) else None
 if code or re.match(r'^(INVALID_|MODEL_NOT|MANAGED_WORKSPACE|SUBAGENT_RPC|invalid_state)',d.get('result','')):errs.append(d)
# all bash from full calls
bash=[]
for d in json.load(open('/tmp/wt-analysis/reports/facts.json'))['managed_calls']:pass
# C root calls only subagent. use original facts plus filter tool bash
allcalls=[]
# recover from script globals unavailable; parse root
pending={}
def ctext(m):
 c=m.get('content',[]);return ''.join(x.get('text','') for x in c if isinstance(x,dict) and x.get('type')=='text') if isinstance(c,list) else str(c)
for i,x in enumerate(ev,1):
 if x.get('type')!='message':continue
 m=x.get('message',{})
 if m.get('role')=='assistant':
  for z in m.get('content',[]) if isinstance(m.get('content'),list) else []:
   if z.get('type')=='toolCall':
    d={'id':z.get('id'),'tool':z.get('name'),'args':z.get('arguments') or {},'line':x['_line'],'time':x.get('timestamp')};pending[d['id']]=d;allcalls.append(d)
 elif m.get('role')=='toolResult' and m.get('toolCallId') in pending:
  pending[m['toolCallId']]['result']=ctext(m);pending[m['toolCallId']]['details']=m.get('details');pending[m['toolCallId']]['result_line']=x['_line']
# classify bash workspace rescue only commands actually aimed at lifecycle/manual integration, not ordinary status
for d in allcalls:
 if d['tool']=='bash':
  cmd=(d['args'] or {}).get('command',''); d['cmd']=cmd
  d['rescue']=bool(re.search(r'(git -C .*?(fetch|checkout|add|commit)|git\s+(worktree|branch|checkout|fetch|add|commit)|\.git/info/exclude|ps\s+-|lsof)',cmd,re.I)) and d['line']>=568
  bash.append(d)
# child managed detailed
managed=[]
for ch in C['children']:
 if '/worktrees/' not in (ch.get('cwd') or ''):continue
 raws=[]
 for t in ch['toolCalls']:
  if t['name']!='bash':continue
  a=t.get('args') or {}; cmd=a.get('command','') if isinstance(a,dict) else ''
  if re.search(r'git\s+(worktree|branch)|git\s+-C\s+\S+\s+(worktree|branch)',cmd,re.I):raws.append({'line':t['line'],'command':cmd})
 managed.append({'cwd':ch['cwd'],'time':ch['time'],'path':ch['path'],'match':ch['match'],'raw_git_wt_branch':raws,'tool_counts':dict(collections.Counter(t['name'] for t in ch['toolCalls']))})
# error counts
cnt=collections.Counter()
for d in errs:
 r=d.get('result','');
 code=(d.get('details') or {}).get('code') if isinstance(d.get('details'),dict) else None
 if not code:code=r.split(':',1)[0]
 cnt[code]+=1
# dispatch invalid char sizes and retry grouping (taskid/title)
invalid=[]
for d in errs:
 if d['tool']=='subagent' and re.match(r'^(INVALID_|MODEL_NOT|SUBAGENT_RPC)',d.get('result','')):
  invalid.append({'line':d['line'],'time':d['time'],'task':d['args'].get('taskId') or d['args'].get('title'),'chars':len(json.dumps(d['args'],ensure_ascii=False,separators=(',',':'))),'result':d['result'],'args':d['args']})
# custom reminders
rem=[]
for x in ev:
 if x.get('type')=='custom_message' and x.get('customType')=='subagent-workspace-reminder':rem.append({'line':x['_line'],'time':x.get('timestamp'),'content':x.get('content'),'details':x.get('details')})
# selected pain messages: assistant text/thinking between first managed and end, paragraphs with heuristic
p=[]
for x in ev:
 if x['_line']<568 or x.get('type')!='message':continue
 m=x.get('message',{})
 if m.get('role')!='assistant':continue
 for z in m.get('content',[]) if isinstance(m.get('content'),list) else []:
  if z.get('type') not in ('text','thinking'):continue
  s=z.get('text') or z.get('thinking') or ''
  for para in re.split(r'\n\s*\n|(?<=。)\s*',s):
   if re.search(r'(奇怪|不对|卡住|失败|不能|无法|可能|似乎|猜|试|直接|手动|保留|preserv|release|dispose|worktree|workspace|token|队列|绕)',para,re.I):p.append({'line':x['_line'],'time':x.get('timestamp'),'kind':z.get('type'),'quote':para.strip()})
result={'capturedLineCount':len(ev),'lastLine':ev[-1],'errorCounts':cnt,'errors':errs,'invalidDispatches':invalid,'invalidChars':sum(x['chars'] for x in invalid if x['result'].startswith(('INVALID_CONTRACT','INVALID_PATH'))),'reminders':rem,'bash':bash,'bashRescueCount':sum(x['rescue'] for x in bash),'managedChildren':managed,'pains':p}
# json separate
Path('/tmp/wt-analysis/reports/evidence-summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,default=dict))
with OUT.open('w') as f:
 f.write(f"captured={len(ev)} last={ev[-1].get('timestamp')}\nerrors={dict(cnt)} invalidChars={result['invalidChars']} bash={len(bash)} rescue={result['bashRescueCount']}\n\nERRORS\n")
 for d in errs:f.write(f"L{d['line']} {d['time']} {d['tool']} chars={len(json.dumps(d['args'],ensure_ascii=False))} task={d['args'].get('taskId') or d['args'].get('title')}\n{d['result']}\n")
 f.write('\nREMINDERS\n');
 for r in rem:f.write(f"L{r['line']} {r['time']} {r['content']}\n")
 f.write('\nBASH\n')
 for d in bash:f.write(f"L{d['line']} {d['time']} rescue={d['rescue']}\n{d['cmd']}\n=>{d.get('result','')}\n---\n")
 f.write('\nMANAGED CHILDREN\n'+json.dumps(managed,ensure_ascii=False,indent=2)+'\n')
 f.write('\nPAINS\n')
 for q in p:f.write(f"L{q['line']} {q['time']} {q['kind']}: {q['quote']}\n")
print(OUT)
