#!/usr/bin/env python3
"""v2 streaming prevalence scan; runtime refusals are tool-scoped and toolCallId-deduplicated."""
import csv,json,glob,os,re
from collections import Counter,defaultdict
from datetime import datetime,timezone

SD='/Users/leshi.zhy/pi-config/var/sessions'; OUT='/tmp/wt-analysis/reports'
SIGS=['INVALID_CONTRACT','INVALID_PATH','INVALID_GENERIC_DISPATCH','INVALID_CODING_ROUTER','MODEL_NOT_AVAILABLE','MODEL_MATCH_USED_GLOBAL_CATALOG','MANAGED_WORKSPACE_GIT','MANAGED_WORKSPACE_STATE','MANAGED_WORKSPACE_ACTION','MANAGED_WORKSPACE_NOT_FOUND','MANAGED_WORKSPACE_SCOPE','SUBAGENT_RPC_FAILED','is missing required field boundaries','contains unknown field outputMode','workflow.reason is forbidden when mode is tdd','workflow.reason is required when mode is docs-only','must be a repo-relative POSIX path','contains an unsupported path pattern','action token is stale, replayed, or does not match','git worktree remove','workspace status is unavailable in preserved','only a preserved or cleanup-debt workspace can be released','is paused; stop only supports running async runs']
STATUS=['awaiting-disposition','cleanup-debt']; RUNTIME={'subagent','subagent_worktree','subagent_supervisor'}
def flat(x):
 if isinstance(x,str): return x
 if isinstance(x,list): return '\n'.join(flat(v) for v in x)
 if isinstance(x,dict): return '\n'.join(flat(v) for v in x.values())
 return ''
def dt(s):
 try:return datetime.fromisoformat(s.replace('Z','+00:00'))
 except:return None
def scan(p):
 lines=[]; cwd=''; first=''; tools={}; args={}
 with open(p,encoding='utf-8',errors='replace') as f:
  for line in f:
   try:x=json.loads(line)
   except: continue
   if not first and x.get('timestamp'): first=x['timestamp']
   if x.get('type')=='session': cwd=x.get('cwd','')
   m=x.get('message',{})
   if not isinstance(m,dict): continue
   role=m.get('role'); content=m.get('content',[])
   if role=='assistant':
    for item in content if isinstance(content,list) else []:
     if isinstance(item,dict) and item.get('type')=='toolCall' and item.get('id'):
      tools[item['id']]=item.get('name',''); args[item['id']]=item.get('arguments',{})
   if role=='toolResult':
    tid=m.get('toolCallId')
    if tid and tid not in {z[0] for z in lines}: lines.append((tid,m))
 return cwd,first,lines,tools,args

def sig_counts(text): return Counter({s:text.count(s) for s in SIGS if s in text})
def project(c): return c.rstrip('/').split('/')[-1] if c else '(unknown)'
def main():
 files=sorted(glob.glob(SD+'/*.jsonl')); rows=[]; total=Counter(); sessions=defaultdict(set); projects=defaultdict(set); dates=defaultdict(list); t2=defaultdict(Counter); monthly=Counter(); proj=Counter(); target=None; target_meta=None; child_summary=[]; retry_dist=Counter()
 for p in files:
  cwd,first,results,tools,args=scan(p); mt=datetime.fromtimestamp(os.stat(p).st_mtime,timezone.utc); pr=project(cwd); r=Counter(); started=0; rej=0; wt_calls=0; wt_fail=0; invalid_bytes=0; task_attempts=Counter(); statuses=Counter()
  for tid,m in results:
   name=tools.get(tid) or m.get('toolName',''); text=flat(m.get('content','')) # details intentionally not counted independently
   details=flat(m.get('details','')); alltext=text+'\n'+details
   # status labels are tracked separately, never errors
   for st in STATUS: statuses[st]+=alltext.count(st)
   isruntime=name in RUNTIME
   clean=text.lstrip()
   clean=re.sub(r'^(?:text\n)+','',clean)
   prefix=bool(re.match(r'^[A-Z][A-Z0-9_]{3,}:',clean))
   if isruntime:
    if name=='subagent_worktree': wt_calls+=1
    if name=='subagent' and clean.startswith(('Started executor','Started reviewer','Started delegate')): started+=1
    if name=='subagent' and prefix:
     cc=sig_counts(clean); rej+=1
     invalid_bytes += len(json.dumps(args.get(tid,{}),ensure_ascii=False,separators=(',',':')))
    if name=='subagent_worktree' and prefix and any(k.startswith('MANAGED_WORKSPACE_') for k in sig_counts(clean)): wt_fail+=1
    if name=='subagent' and args.get(tid,{}).get('taskId'): task_attempts[args[tid]['taskId']]+=1
   cc=sig_counts(text)
   if cc:
    if isruntime:
     for s,n in cc.items(): r[s]+=n; total[s]+=n; sessions[s].add(os.path.basename(p)); projects[s].add(pr); dates[s].append(dt(first) or mt)
    else:
     for s,n in cc.items(): t2[name][s]+=n
   # all successful spawn taskIds too
  if any(r.values()):
   row={'session_file':os.path.basename(p),'first_ts':first,'last_activity':mt.isoformat(),'cwd':cwd,'project':pr}; row.update({s:r[s] for s in SIGS}); rows.append(row)
  for s,n in r.items(): monthly[(dt(first) or mt).strftime('%Y-%m')]+=n
  proj[pr]+=sum(r.values())
  childdir= p[:-6] # remove .jsonl
  childn=len(glob.glob(childdir+'/*/run-0/session.jsonl')) if os.path.isdir(childdir) else 0
  child_summary.append((os.path.basename(p),started,childn))
  for depth in task_attempts.values(): retry_dist[depth]+=1
  if os.path.basename(p).startswith('2026-09-20T03-09-49-721Z_01a0bcca-9b19-751c-a28f-ba65e7d2b6e8'):
   target=(r,started,wt_calls,wt_fail,invalid_bytes,task_attempts,len(results),rej)
   line_count=0; last_event=''
   with open(p,encoding='utf8',errors='replace') as tf:
    for tl in tf:
     line_count+=1
     try: last_event=json.loads(tl).get('timestamp','')
     except: pass
   target_meta=(line_count,last_event)
 md=['# 跨会话错误码流行度统计 v2','','## v2 修订说明','', '- 修正：toolCallId 去重；details 不独立计数。','- T1 仅统计 runtime 工具且错误前缀匹配；其它工具为受污染 T2。','- awaiting-disposition 与 cleanup-debt 为成功状态标签，不计入错误。','- 目标校准：toolResults=%s、INVALID_CONTRACT=%s、INVALID_PATH=%s、MODEL_NOT_AVAILABLE=%s、SUBAGENT_RPC_FAILED=%s、Started=%s、MANAGED_WORKSPACE_GIT=%s、STATE=%s、ACTION=%s、NOT_FOUND=%s。（快照：读取时 %s 行 / %s toolResult / 最后事件 %s；目标为 live，会继续增长。）' % (target[6],target[0].get('INVALID_CONTRACT',0),target[0].get('INVALID_PATH',0),target[0].get('MODEL_NOT_AVAILABLE',0),target[0].get('SUBAGENT_RPC_FAILED',0),target[1],target[0].get('MANAGED_WORKSPACE_GIT',0),target[0].get('MANAGED_WORKSPACE_STATE',0),target[0].get('MANAGED_WORKSPACE_ACTION',0),target[0].get('MANAGED_WORKSPACE_NOT_FOUND',0),target_meta[0],target[6],target_meta[1]),'','## 1. 总览','',f'- 扫描会话文件：{len(files)}；T1 命中：{len(rows)}；项目 cwd：{len(set().union(*(projects.values())) if projects else set())}。','','## 2. T1｜runtime 真实拒绝（主表）','','|签名|次数|会话数|项目数|最早|最晚|判定|','|---|---:|---:|---:|---|---|---|']
 # CSV T1 only
 with open(OUT+'/D-error-prevalence.csv','w',newline='',encoding='utf8') as f:
  w=csv.DictWriter(f,fieldnames=['session_file','first_ts','last_activity','cwd','project']+SIGS); w.writeheader(); w.writerows(rows)
 # child aggregate
 matches=sum(a==b for _,a,b in child_summary); mism=[x for x in child_summary if x[1]!=x[2]]
 child_total=sum(os.path.getsize(x) for root in ['/Users/leshi.zhy/new-api-account-pool/.pi-subagents/artifacts','/Users/leshi.zhy/pi-config/.pi-subagents/artifacts'] for x in glob.glob(root+'/*_transcript.jsonl') if os.path.isfile(x))
 child_files=sum(1 for root in ['/Users/leshi.zhy/new-api-account-pool/.pi-subagents/artifacts','/Users/leshi.zhy/pi-config/.pi-subagents/artifacts'] for x in glob.glob(root+'/*_transcript.jsonl') if os.path.isfile(x))
 for s in SIGS:
  ds=dates[s]; ses=len(sessions[s]); span=(max(ds)-min(ds)).days if ds else 0; status='慢性' if ses>=3 and span>=2 else ('反复' if ses==2 else ('偶发' if ses==1 else '未出现'))
  md.append(f'|{s}|{total[s]}|{ses}|{len(projects[s])}|{min(ds).date() if ds else ""}|{max(ds).date() if ds else ""}|{status}|')
 md += ['', '## 3. T2｜全量字符串出现（受污染源附表）','', '|工具|签名|次数|','|---|---|---:|']
 for tool,c in sorted(t2.items()):
  for s,n in c.most_common(): md.append(f'|{tool}|{s}|{n}|')
 md += ['', '## 4. 目标会话相对位置','', '按 T1 仅对该签名命中会话排名：']
 for s in SIGS:
  vals=sorted((x[s] for x in rows if x[s]),reverse=True); v=target[0].get(s,0) if target else 0
  md.append(f'- `{s}`：{v} 次，'+('未出现' if not v else f'排名 {vals.index(v)+1}/{len(vals)}，'+('历史最高' if v==vals[0] else '普通水平')))
 md += ['', '## 5. 派生指标','', f'- 全局派发拒绝率按会话聚合：拒绝结果/（成功 Started + 拒绝）需从逐会话数据重算；目标基准：成功 64、拒绝 15、19.0%。目标实际成功={target[1] if target else "?"}、拒绝={target[7] if target else "?"}，拒绝率={(target[7]/(target[1]+target[7])*100 if target and target[1]+target[7] else 0):.1f}%。', f'- 目标 worktree 处置失败率：{target[3]}/{target[2]} = {(target[3]/target[2]*100 if target and target[2] else 0):.1f}%。', f'- 目标被拒派发参数体积：{target[4] if target else "?"} bytes；均值={(target[4]/target[7] if target and target[7] else 0):.1f} bytes/次；目标被拒数={target[7] if target else "?"}。', '- taskId 重试深度：本脚本按每会话 toolCall arguments 的 taskId 计数；见下方目标及全局分布。', f'- 目标 taskId 次数：{dict(target[5]) if target else "?"}；全局 taskId 尝试深度分布：{dict(sorted(retry_dist.items()))}', '', '## 6. 时间趋势','', '|月份|T1 总数|','|---|---:|']
 for m in sorted({k for k in monthly}): md.append(f'|{m}|{monthly[m]}|')
 md += ['', '## 7. 项目分布（T1 前 10）','']+[f'- `{p}`：{n}' for p,n in proj.most_common(10)]
 md += ['', '## 8. child session 交叉验证','', f'- 根会话：{len(files)}；Started 与 child 目录数吻合：{matches}；吻合率：{matches/len(files)*100:.1f}%；不吻合：{len(mism)}。', '- 不吻合清单：']+[f'  - `{p}`：Started={a}, child={b}' for p,a,b in mism[:100]]
 md += ['', '## 9. 状态标签出现频次','', 'awaiting-disposition 与 cleanup-debt 是成功 status/list 返回中的状态标签，不计入错误。']
 md += ['', '## 10. child transcript 补充抽样','', f'- artifacts transcript 文件数：{child_files}；总大小：{child_total} bytes；仍保留上一版最新 20 个抽样的空结果结论。child 不派发下级 subagent，writePaths 校验发生在父侧派发时，因此 child 侧本就不应出现这些拒绝码。']
 md += ['', '## 11. 可信度说明','', '- JSONL 逐行处理；toolResult 按 toolCallId 去重；T1/T2 按工具名和错误前缀分离。','- child transcript 真实位置为根 session 同名目录；artifacts 仅作兼容性补充。','- 结构化嵌套输出、截断文本、非标准结果可能漏计。','- live 目标会话导致跨会话统计时点不一致；历史会话稳定，目标会话每次重跑可能增长，排名/占比仅为近似。']
 with open(OUT+'/D-error-prevalence.md','w',encoding='utf8') as f:f.write('\n'.join(md)+'\n')
 print(json.dumps({'target':target[:5] if target else None,'sessions':len(files),'hits':len(rows),'child_match_rate':matches/len(files) if files else 0}))
if __name__=='__main__':main()
