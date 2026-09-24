#!/usr/bin/env python3
from pathlib import Path
import re,json,subprocess
root=Path('/Users/leshi.zhy/pi-config'); out=Path('/tmp/wt-analysis/reports')
plan_names=['2026-09-20-subagent-lifecycle-overall.md','2026-09-12-pi-0851-repository-merge-queue.md','2026-09-16-durable-fifo-resumed-child.md','2026-09-16-five-child-convergence.md','2026-09-20-subagent-orphan-recovery.md','2026-09-10-unified-delegation-workspace-harness.md']
D={}
for fn in plan_names:
 p=root/'docs/plans'/fn; ls=p.read_text(errors='replace').splitlines(); arr=[]
 for i,l in enumerate(ls,1):
  if re.match(r'^\s*-\s+\[[ xX]\]',l): arr.append((i,bool(re.search(r'\[[xX]\]',l)),l.strip()))
 D[fn]={'counts':(sum(x[1] for x in arr),len(arr)),'items':arr}
# selected docs explicitly requested plus likely exact variants
sel=['bug-force-cleanup-red-retains-post-proof-debt.md','bug-managed-worktree-reclaimable-head-cannot-be-safely-reanchored.md','2026-09-16-coordinator-sync-git-admission-blocking.md','2026-09-15-fifo-follower-admission-exit.md','2026-09-13-real-runtime-enqueue-disconnect.md','2026-09-17-premature-enqueue-freezes-base-authorized-head.md','2026-09-17-audit-queue-items-unsorted-settlement-misjudge.md','bug-recovered-binding-omits-root-terminal-proof.md','bug-coordinator-stale-state-root-bricks-repository.md','2026-09-13-coordinator-storage-repository-partition.md','2026-09-06-subagent-workspace-terminal-proof-adapter.md','2026-09-07-root-broker-terminal-proof-contract-split.md','2026-09-13-auto-integration-inspect-information-leak.md','2026-09-12-subagent-worktree-lifecycle-broken.md','bug-settlement-evidence-paths-can-be-duplicated-or-unbound.md','bug-durable-settled-rearms-consumed-plan-open-wake.md','bug-predecessor-proof-race-drops-revival-wake.md','bug-live-lifecycle-push-loses-post-proof-revival.md','bug-supervisor-mailbox-route-failure-reorders-queue.md','bug-audit-queue-scan-aborts-on-missing-partition.md','2026-09-14-auto-integration-recovery.md','2026-09-14-child-integration-auto-lifecycle.md','bug-worktree-release-blocked-by-unrelated-lsof-warning.md','bug-subagent-writepaths-rejects-glob-without-schema-hint.md','bug-subagent-dispatch-cannot-request-managed-worktree.md','bug-root-broker-response-schema-missing.md','bug-spawn-ledger-retry-cleanup-classification.md']
for fn in sel:
 p=root/'docs/bugs'/fn
 if not p.exists():
  # fuzzy candidates
  matches=list((root/'docs/bugs').glob('*'+fn.replace('.md','')+'*'))
  if matches:p=matches[0]
 if not p.exists(): D['BUG:'+fn]={'missing':True}; continue
 ls=p.read_text(errors='replace').splitlines(); ex=[]
 for i,l in enumerate(ls,1):
  if re.search(r'根因|结论|状态|修复|fixed|fix|test|测试|commit|提交|验证|仍|未|✅|❌|遗留|回归|regress',l,re.I): ex.append((i,l[:800]))
 D['BUG:'+p.name]={'path':str(p),'lines':len(ls),'excerpts':ex[:100]}
# relevant source current and HEAD line snapshots
files=['packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts','packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts','packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts','packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts','packages/pi-subagents-enhanced/src/subagent-dispatch/errors.ts','packages/pi-subagents-enhanced/src/subagent-dispatch/completion-reminder.ts','packages/pi-subagents-enhanced/src/subagent-dispatch/tool.ts','packages/pi-subagents-enhanced/src/workspace/service.ts','packages/pi-subagents-enhanced/src/workspace/git-worktree.ts']
D['source']={}
for fn in files:
 p=root/fn
 if p.exists():
  ls=p.read_text(errors='replace').splitlines(); hits=[]
  for i,l in enumerate(ls,1):
   if re.search(r'workflow|required|minItems|writePaths|cleanup-debt|legacyRelease|reconcile|stderr|remove|MODEL_NOT|SUBAGENT_RPC|queue|reminder|PI_CODING_WORKSPACE|unknown',l,re.I): hits.append((i,l[:500]))
  D['source'][fn]={'lines':len(ls),'hits':hits[:200]}
# field diff only, current status and head/current selected snippets generated in report manually
(out/'coverage_targets.json').write_text(json.dumps(D,ensure_ascii=False,indent=2))
print({k:v.get('counts') for k,v in D.items() if not k.startswith('BUG:') and k not in ('source',)})
