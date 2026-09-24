#!/usr/bin/env python3
"""重放 cd8af2da session 中对 prevalence_scan.py 的内联 python 变异
（python3 - <<'PY' 形式的 read/replace/write），按实际执行成功与否门控。

用法: python3 apply_inline_mutations.py <session.jsonl> <script-basename> <working-copy>
"""
import json, os, re, sys

sf, base, work = sys.argv[1], sys.argv[2], sys.argv[3]
ORIG = "/tmp/wt-analysis/reports/" + base

outcomes = {}
results_text = {}
for ln in open(sf, errors="replace"):
    if '"toolResult"' not in ln:
        continue
    e = json.loads(ln)
    m = e.get("message") or {}
    if m.get("role") == "toolResult":
        outcomes[m.get("toolCallId")] = bool(m.get("isError", False))
        results_text[m.get("toolCallId")] = " ".join(
            c.get("text", "") for c in (m.get("content") or []) if isinstance(c, dict))

# 提取所有【成功执行】且引用脚本路径的 bash heredoc python 变异
n = 0
for ln in open(sf, errors="replace"):
    if base not in ln or "python3" not in ln:
        continue
    e = json.loads(ln)
    m = e.get("message") or {}
    if m.get("role") != "assistant":
        continue
    for c in (m.get("content") or []):
        if not (isinstance(c, dict) and c.get("type") == "toolCall" and c.get("name") == "bash"):
            continue
        cid = c.get("id")
        if cid not in outcomes:
            continue  # 无 result = 从未执行
        cmd = str((c.get("arguments") or {}).get("command", ""))
        if ORIG not in cmd:
            continue
        # 变异体自身的成败：heredoc 是独立进程，与 bash 尾部命令退出码无关。
        # 判定：result 文本含 <stdin> traceback 则该次变异未生效（未写回）。
        rt = results_text.get(cid, "")
        if "File \"<stdin>\"" in rt:
            print(f"  [跳过 L 级] 变异体自身失败(<stdin> traceback): {rt[:120]!r}")
            continue
        for mm in re.finditer(r"<<'(\w+)'\n(.*?)\n\1", cmd, re.S):
            body = mm.group(2)
            if "open(p" not in body and "open(" + repr(ORIG) not in body:
                continue
            n += 1
            before = os.path.getsize(work)
            mutated = body.replace(ORIG, work)
            # 沉默替换检测：若 body 引用的目标子串已不存在，str.replace 会静默空转
            try:
                exec(mutated, {"__name__": "__mutation__"})
            except Exception as ex:
                print(f"  变异#{n} EXEC-FAIL: {type(ex).__name__}: {ex}")
                print(f"    body[0:200]={body[:200]!r}")
                continue
            after = os.path.getsize(work)
            print(f"  变异#{n}: {before}B -> {after}B  ({body[:60]!r}...)")
print(f"共应用内联变异 {n} 处，最终 {work} = {os.path.getsize(work)}B")
