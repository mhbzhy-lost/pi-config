#!/usr/bin/env python3
"""Batch re-verification of the 20 runtime gaps on the new lifecycle baseline.
Read-only. Prints per-item key evidence with current worktree line numbers."""
import re, subprocess, os

ROOT = "/Users/leshi.zhy/pi-config"
PKG = "packages/pi-subagents-enhanced/src"
SD = f"{ROOT}/{PKG}/subagent-dispatch"
WS = f"{ROOT}/{PKG}/workspace"
CT = f"{ROOT}/{PKG}/contracts"
NEW = ["supervisor-control-plane.ts","supervisor-replay.ts","authority-contract.ts",
       "authority-store.ts","lifecycle-policy.ts","lifecycle-identity.ts",
       "replay-barrier.ts","durable-storage.ts","durable-contract.ts",
       "durable-event-outbox.ts","durable-run-registry.ts"]

def rd(p):
    with open(p, encoding="utf-8") as f: return f.read()

def lines(p): return rd(p).splitlines()

def find(p, pats, label):
    out = []
    ls = lines(p)
    for i, l in enumerate(ls, 1):
        for pat in pats:
            if re.search(pat, l):
                out.append((i, l.strip()[:150], pat))
    print(f"--- {label} :: {os.path.basename(p)} ({len(ls)} lines)")
    for i, l, pat in out[:12]:
        print(f"  {i}: {l}")
    if not out: print("  (NO MATCH)")
    return out

print("="*80); print("B1 orphan IR")
print("src/subagent-dispatch/ir.ts exists:", os.path.exists(f"{ROOT}/src/subagent-dispatch/ir.ts"))
find(f"{CT}/dispatch-ir.ts", [r"minItems"], "B1 dispatch-ir minItems")
find(f"{ROOT}/test/subagent-dispatch-validation-errors.test.mjs", [r"from .*subagent-dispatch/ir", r"writePaths is an explicit read-only"], "B1 test import orphan")
# production importers of orphan ir.ts
r = subprocess.run(["grep","-rn","subagent-dispatch/ir", ROOT+"/packages", ROOT+"/src", "--include=*.ts","-l"],capture_output=True,text=True)
print("  importers of subagent-dispatch/ir:", r.stdout.strip().replace("\n","  |  ") or "(none)")

print("="*80); print("B2 schema drift")
ext = f"{SD}/extension.ts"
find(ext, [r"root-level union", r"empty arguments", r"TYPED_SUBAGENT_PARAMETERS"], "B2 union comment + schema def")
# check required at root level of schema: lines between TYPED_SUBAGENT_PARAMETERS def start and first nested property
src = rd(ext)
m = re.search(r"export const TYPED_SUBAGENT_PARAMETERS[^=]*=\s*Object\.freeze\(\s*\{(.*?)\n  (?:\}\))", src, re.S)
seg = m.group(1) if m else ""
root_required = [l for l in seg.splitlines() if re.match(r"\s*required\s*:", l)]
print("  root-level `required:` inside schema object:", root_required or "NONE (still no required)")
find(ext, [r"^\s*required"], "B2 any required lines (incl nested)")

print("="*80); print("H3 workflow")
find(ext, [r"workflow"], "H3 ext schema workflow")
find(f"{CT}/dispatch-ir.ts", [r"workflow\.reason", r"forbidden when mode", r"reason is required", r"mode is tdd|reasonRequired|requiresReason"], "H3 dispatch-ir mode<->reason")
find(f"{SD}/prompt.ts", [r"Mode|Exemption"], "H3 prompt render")
# new files referencing workflow
for n in NEW + ["recovery-resume-orchestrator.ts"]:
    find(f"{SD}/{n}", [r"workflow"], f"H3 newfile workflow? {n}")

print("="*80); print("H9 preflight-as-RPC")
find(ext, [r"SUBAGENT_RPC_FAILED", r"rpcOperation", r"causeCode"], "H9 ext fallback")
find(f"{SD}/execution-contract.ts", [r"PI_CODING_WORKSPACE_DIR|state-root|workspace dir"], "H9 exec-contract state-root cwd")
find(f"{SD}/errors.ts", [r"unknown|causeCode"], "H9 errors causeCode")

print("="*80); print("M3 version heuristic")
find(ext, [r"version.*heuristic|looksLikeGeneric|taskId.*objective.*workflow|missing version"], "M3 heuristic")

print("="*80); print("B4 cleanup-debt exits")
find(f"{WS}/tool.ts", [r"action|reconcile|recover|inspect"], "B4 tool action union")
find(f"{SD}/execution-contract.ts", [r"PI_CODING_WORKSPACE_DIR"], "B4 exec-contract cwd reject (same as H9)")
find(f"{WS}/administration.ts", [r"planManagedWorkspaceCleanup|applyManagedWorkspaceCleanup"], "B4 admin exit")
find(f"{WS}/service.ts", [r"legacyRelease|cleanup-debt|cleanupDebt"], "B4 service release/debt")
# does recovery orchestrator mention workspace cleanup-debt?
find(f"{SD}/recovery-resume-orchestrator.ts", [r"cleanup-debt|cleanup_debt|workspace.*debt|debt.*workspace|dispose"], "B4 orchestrator mentions workspace debt?")
for n in NEW:
    find(f"{SD}/{n}", [r"cleanup-debt|cleanup_debt"], f"B4 newfile cleanup-debt? {n}")

print("="*80); print("B3 queue claim + proof settle")
find(f"{WS}/integration-queue.ts", [r"claimNext|admissionGeneration"], "B3 claimNext")
# new files referencing queue claim / terminal proof / settle
for n in NEW + ["recovery-resume-orchestrator.ts","recovery-resume-contract.ts"]:
    find(f"{SD}/{n}", [r"claimNext|admissionGeneration|terminal.?proof|terminalProof|settle"], f"B3 newfile queue/proof? {n}")
find(f"{SD}/coordinator-proof-outbox.ts", [r"settle|receipt"], "B3 coordinator-proof-outbox")

print("="*80); print("H5 completion reminder")
find(f"{WS}/completion-reminder.ts", [r"async-complete|lifecycleSessionId|cleanup-debt|queued"], "H5 reminder filter")
for n in NEW:
    find(f"{SD}/{n}", [r"reminder|completion"], f"H5 newfile reminder? {n}")

print("="*80); print("H1 git stderr")
find(f"{WS}/git-worktree.ts", [r"stderr|failed to .*(remove|add)|catch"], "H1 stderr extraction")

print("="*80); print("H2 removeUntrackedRuntimeMetadata")
find(f"{WS}/git-worktree.ts", [r"removeUntrackedRuntimeMetadata"], "H2 timing")
find(f"{WS}/service.ts", [r"removeUntrackedRuntimeMetadata"], "H2 service call")

print("="*80); print("H6 queue inspect")
find(f"{WS}/tool.ts", [r"inspectQueue|queue-inspect|inspect"], "H6 inspect in tool")

print("="*80); print("H7 paused cancel")
for n in NEW + ["recovery-resume-orchestrator.ts","recovery-resume-contract.ts"]:
    find(f"{SD}/{n}", [r"paused|cancel"], f"H7 newfile paused/cancel? {n}")

print("="*80); print("H8 model candidates")
find(f"{SD}/model-selection.ts", [r"ModelSelectionError|requested|candidates"], "H8")

print("="*80); print("M1 submodule")
find(f"{WS}/git-worktree.ts", [r"submodule|init|update --init|recursive"], "M1 git recursion")
find(f"{WS}/contract.ts", [r"submodule|writePaths|glob"], "M1 contract types")

print("="*80); print("M2 INVALID_PATH")
find(f"{CT}/dispatch-ir.ts", [r"INVALID_PATH"], "M2 messages")

print("="*80); print("M4 ledger labels")
find(f"{WS}/ledger.ts", [r"cleanup-debt|reserved|disposing"], "M4 ledger states")
find(f"{WS}/service.ts", [r"awaiting-disposition|integrated|discarded"], "M4 service labels")

print("="*80); print("M5 rpc retry/idempotency")
find(f"{SD}/rpc-client.ts", [r"retry|idempot|attempt"], "M5 rpc-client")
for n in ["supervisor-control-plane.ts","replay-barrier.ts","supervisor-replay.ts"]:
    find(f"{SD}/{n}", [r"spawn|receipt"], f"M5 newfile spawn coverage? {n}")

print("="*80); print("M7 incremental persistence")
for n in NEW:
    find(f"{SD}/{n}", [r"artifact|incremental|flush|checkpoint"], f"M7 newfile artifacts? {n}")
