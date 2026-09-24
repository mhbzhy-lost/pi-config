#!/usr/bin/env python3
"""只读解析指定 session、managed workspace 与相关 child artifacts；只写 reports。"""
from pathlib import Path
import json, re, os, datetime, collections
SESSION=Path('/Users/leshi.zhy/pi-config/var/sessions/2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8.jsonl')
ROOT=Path('/Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0')
ART=Path('/Users/leshi.zhy/new-api-account-pool/.pi-subagents/artifacts')
OUT=Path('/tmp/wt-analysis/reports')

def text_content(msg):
    out=[]
    for c in msg.get('content',[]) if isinstance(msg.get('content'),list) else []:
        if c.get('type') in ('text','thinking'):
            out.append({'kind':c.get('type'),'text':c.get('text','') or c.get('thinking','')})
    return out

events=[]; calls={}; ordered_calls=[]; assistant_text=[]
with SESSION.open() as f:
    for ln,line in enumerate(f,1):
        x=json.loads(line); x['_line']=ln; events.append(x)
        if x.get('type')=='message':
            m=x.get('message',{})
            if m.get('role')=='assistant':
                for z in text_content(m): assistant_text.append({'line':ln,'time':x.get('timestamp'),'kind':z['kind'],'text':z['text']})
                for c in m.get('content',[]) if isinstance(m.get('content'),list) else []:
                    if c.get('type')=='toolCall':
                        d={'id':c.get('id'),'tool':c.get('name'),'args':c.get('arguments'),'line':ln,'time':x.get('timestamp'),'result':None,'result_line':None,'result_time':None,'details':None}
                        calls[d['id']]=d; ordered_calls.append(d)
            elif m.get('role')=='toolResult':
                cid=m.get('toolCallId'); d=calls.get(cid)
                raw=''.join(c.get('text','') for c in m.get('content',[]) if c.get('type')=='text') if isinstance(m.get('content'),list) else str(m.get('content',''))
                if d: d.update(result=raw,result_line=ln,result_time=x.get('timestamp'),details=m.get('details'),isError=m.get('isError'))
# worktree region and all errors
region=[]
for i,d in enumerate(ordered_calls,1):
    d['number']=i
    a=d.get('args') or {}
    if (d['tool']=='subagent' and isinstance(a,dict) and ((a.get('execution') or {}).get('worktree') is True or a.get('worktree') is True)) or d['tool']=='subagent_worktree':
        region.append(d)
errors=[d for d in ordered_calls if d.get('result') and re.search(r'INVALID_|MODEL_NOT|MANAGED_WORKSPACE|SUBAGENT_RPC|invalid_state',d['result'])]
# Relevant text pain candidates after first worktree dispatch
first=min([d['line'] for d in region] or [10**9])
pain_re=re.compile(r'(?i)(奇怪|不对|失败|卡|猜|尝试|试试|绕过|没法|无法|不能|似乎|可能|preserv|release|dispose|worktree|workspace|queue|token|stale|重试|retry|manual|手动|直接|raw git|脏|dirty|清理|cleanup|救|麻烦|困惑)')
pains=[x for x in assistant_text if x['line']>=first and pain_re.search(x['text'])]
# raw bash calls after first worktree: classify conservatively
bash=[]
for d in ordered_calls:
    if d['tool']=='bash' and d['line']>=first:
        cmd=(d.get('args') or {}).get('command','') if isinstance(d.get('args'),dict) else ''
        rescue=bool(re.search(r'git\s+(worktree|branch|status|rev-parse|show-ref|log)|\.git/worktrees|ps\s|lsof|find .*worktree',cmd,re.I))
        bash.append({**d,'command':cmd,'workspace_rescue':rescue})
# records / queue / terminal proof, omitting owner token intentionally
records=[]
for p in sorted((ROOT/'records').glob('*.json')):
    x=json.load(p.open()); records.append({'file':str(p),'workspaceId':x.get('workspaceId'),'state':x.get('state'),'path':x.get('path'),'run':x.get('run'),'disposition':x.get('disposition'),'cleanupDebt':x.get('cleanupDebt'),'integrationIntent':x.get('integrationIntent'),'integrationReceipt':x.get('integrationReceipt'),'integrationHistory':x.get('integrationHistory'),'createdAt':x.get('createdAt'),'updatedAt':x.get('updatedAt'),'revision':x.get('revision'),'actionChallenge':x.get('actionChallenge'),'pendingAction':x.get('pendingAction')})
queue=[]
for p in sorted((ROOT/'integration-queue').glob('*.json')):
    queue.append({'file':str(p),'data':json.load(p.open())})
proof=json.load((ROOT/'terminal-proof-outbox'/'terminal-proofs.json').open())
# worktree directory factual listing and process cwd links (read-only /proc-like lsof avoided; ps command separately in shell validation)
worktrees=[]
for p in sorted((ROOT/'worktrees').iterdir()):
    worktrees.append({'name':p.name,'path':str(p),'exists':p.exists(),'git_file':(p/'.git').exists(),'entries':[q.name for q in list(p.iterdir())[:30]]})
# relevant child artifacts based on run ids in managed records plus all artifacts mtime >= session first managed time (~2026-09-21)
runids={r.get('run',{}).get('runId') for r in records if r.get('run')}; runids.discard(None)
children=[]
for rid in sorted(runids):
    files=sorted(ART.glob(rid+'_*'))
    item={'runId':rid,'files':[]}
    for p in files:
        item['files'].append({'path':str(p),'size':p.stat().st_size,'mtime':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat()})
        if p.name.endswith('_meta.json'):
            try:item['meta']=json.load(p.open())
            except Exception as e:item['meta_error']=str(e)
    children.append(item)
summary={'session':str(SESSION),'event_count':len(events),'first_managed_line':first,'managed_calls':region,'errors':errors,'pains':pains,'bash_after_managed':bash,'records':records,'queue':queue,'terminal_proof':proof,'worktrees':worktrees,'children':children}
(OUT/'facts.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
# Human compact dump
with (OUT/'facts.txt').open('w',encoding='utf-8') as f:
    f.write(f'events={len(events)} first_managed=L{first}\n\nMANAGED CALLS\n')
    for d in region:
        f.write(f"CALL#{d['number']} L{d['line']} {d['time']} {d['tool']}\nARGS {json.dumps(d['args'],ensure_ascii=False)}\nRESULT L{d['result_line']} {d['result']}\n\n")
    f.write('\nERRORS\n')
    for d in errors:f.write(f"CALL#{d['number']} L{d['line']} {d['time']} {d['tool']} => {d['result']}\n")
    f.write('\nPAINS\n')
    for x in pains:f.write(f"L{x['line']} {x['time']} {x['kind']}: {x['text']}\n---\n")
    f.write('\nBASH\n')
    for d in bash:f.write(f"CALL#{d['number']} L{d['line']} {d['time']} rescue={d['workspace_rescue']}\n{d['command']}\n=> {d['result']}\n---\n")
print(OUT/'facts.json')
