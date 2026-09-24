#!/usr/bin/env python3
"""批量重放：从 child/主 session JSONL 恢复 9 份调查报告与 10 个提取脚本。

用法: python3 recover_all.py [--reports] [--scripts]
按 session 文件中的出现顺序重放 write/edit/apply_patch/bash-heredoc。
每恢复出一份文件立即写入输出目录。
"""
import json, os, re, glob, sys

HOME = os.path.expanduser("~")
SESS = os.path.join(HOME, "pi-config/var/sessions")
PARENT = "2026-09-21T11-58-07-128Z_01a0c3d4-a118-743f-83c9-97587cbfe21f"
PDIR = os.path.join(SESS, PARENT)
MAIN = PDIR + ".jsonl"
OUT = "/Users/leshi.zhy/pi-config/docs/investigations/2026-09-22-managed-worktree-merge-queue-practice"
SCPT = os.path.join(OUT, "_scripts")

def child(cid):
    full = glob.glob(os.path.join(PDIR, cid + "*", "run-0", "session.jsonl"))
    assert full, f"child session not found for prefix {cid}"
    return full[0]

# (目标文件名, 权威 session 文件列表, 主 agent 记录的参考值)
REPORTS = [
    ("00-INTEGRATED-runtime-gap-report.md", [MAIN], "20.5K 初版+edit 追加"),
    ("A-session-forensics.md",              [child("1b3bf0ed")], "42.6K"),
    ("B-dispatch-contract-rootcause.md",    [child("255d91b7")], "42.2K"),
    ("C-workspace-mergequeue-rootcause.md", [child("0bbce36c")], "33.9K"),
    ("D-error-prevalence.md",               [child("cd8af2da")], "14.3K"),
    ("E-coverage-mapping.md",               [child("ea54837a")], "≈28K / 137 行"),
    ("F-rebaseline-delta.md",               [child("0899302e")], "138 行"),
    ("G-residuals-confirmation.md",         [child("eb81920d")], "227 行"),
]

SCRIPTS = [
    ("prevalence_scan.py",    child("cd8af2da")),
    ("coverage_extract.py",   child("ea54837a")),
    ("coverage_targets.py",   child("ea54837a")),
    ("rebaseline_check.py",   child("0899302e")),
    ("analyze_session.py",    child("1b3bf0ed")),
    ("map_children.py",       child("1b3bf0ed")),
    ("summarize_evidence.py", child("1b3bf0ed")),
    ("filter_artifacts.py",   child("1b3bf0ed")),
    ("extract_contexts.py",   child("1b3bf0ed")),
    ("validate_report.py",    child("1b3bf0ed")),
]

ALL_SESSIONS = [MAIN] + sorted(glob.glob(os.path.join(PDIR, "*", "run-*", "session.jsonl")))

def apply_edits(text, edits):
    """逐条 edit：精确子串替换 -> strip 后正则转义匹配 -> 记 FAIL 并继续。"""
    fails = 0
    for e in edits or []:
        old, new = e.get("oldText"), e.get("newText")
        if old is None or new is None:
            continue
        if old in text:
            text = text.replace(old, new, 1)
        else:
            m = re.search(re.escape(old.strip()), text)
            if m:
                text = text[:m.start()] + new.strip() + text[m.end():]
            else:
                fails += 1
    return text, fails

def apply_patch_text(text, patch):
    for blk in re.split(r'\*\*\* (?=Update File|Add File|Delete File)', patch):
        removes = [l[2:] for l in blk.split("\n") if l.startswith("- ")]
        adds    = [l[2:] for l in blk.split("\n") if l.startswith("+ ")]
        for r, a in zip(removes, adds):
            if r and r in text:
                text = text.replace(r, a, 1)
    return text

HEREDOC_RE = re.compile(r"cat\s*(>>?)\s*(\S+)\s*<<-\s*'?\w+'?[^\n]*\n(.*?)\n\w*[ \t]*$", re.S)

def extract_bash_writes(cmd, base):
    out = []
    for m in re.finditer(r"cat\s*(>>?)\s*(\S+)\s*<<\s*'?(\w+)'?\n(.*?)\n\3", cmd, re.S):
        mode, path, _d, body = m.group(1), m.group(2), m.group(3), m.group(4)
        if base in path:
            out.append((mode, body + "\n"))
    return out

def load_call_outcomes(sf):
    """第一遍：收集全文件 toolCallId -> 是否成功（isError）。无结果的调用视为未执行。"""
    ok = {}
    with open(sf, errors="replace") as fh:
        for ln in fh:
            if '"toolResult"' not in ln:
                continue
            try:
                e = json.loads(ln)
            except Exception:
                continue
            m = e.get("message") or {}
            if m.get("role") != "toolResult":
                continue
            ok[m.get("toolCallId")] = bool(m.get("isError", False))
    return ok

def iter_calls(sf, base):
    """第二遍：产出 (toolCallId, name, arguments)，仅限提及 base 的行。"""
    with open(sf, errors="replace") as fh:
        for ln in fh:
            if base not in ln:
                continue
            try:
                e = json.loads(ln)
            except Exception:
                continue
            if e.get("type") != "message":
                continue
            m = e.get("message") or {}
            if m.get("role") != "assistant":
                continue
            for c in (m.get("content") or []):
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    yield c.get("id"), c.get("name"), (c.get("arguments") or {})

def replay(session_files, base):
    """按给定 session 文件顺序重放对 base 的全部【成功执行】的写入。"""
    text, ops, failed = None, [], 0
    for sf in session_files:
        if not os.path.exists(sf):
            continue
        outcomes = load_call_outcomes(sf)
        for cid, name, a in iter_calls(sf, base):
            if cid not in outcomes or outcomes[cid]:
                ops.append("rejected:" + (name or "?"))  # 参数未被实际执行
                continue
            p = str(a.get("path", ""))
            if name == "write" and base in p:
                text = a.get("content", ""); ops.append("write")
            elif name == "edit" and base in p:
                if text is None: text = ""
                text, f = apply_edits(text, a.get("edits"))
                ops.append("edit" if f == 0 else f"edit(FAIL:{f})")
                failed += f
            elif name == "apply_patch" and base in str(a.get("patch", "")):
                if text is None: text = ""
                text = apply_patch_text(text, a.get("patch", "")); ops.append("patch")
            elif name == "bash":
                for mode, body in extract_bash_writes(str(a.get("command", "")), base):
                    if text is None: text = ""
                    text = (text + body) if mode == ">>" else body
                    ops.append("bash" + mode)
    return text, ops, failed

def compress_ops(ops):
    out = []
    for o in ops:
        if out and out[-1][0] == o:
            out[-1][1] += 1
        else:
            out.append([o, 1])
    return " ".join(f"{o}x{n}" if n > 1 else o for o, n in out)

def stats(text):
    if text is None:
        return None
    h1 = len(re.findall(r"(?m)^# ", text))
    h2 = len(re.findall(r"(?m)^## ", text))
    h3 = len(re.findall(r"(?m)^### ", text))
    return dict(chars=len(text), lines=text.count("\n") + (0 if text.endswith("\n") else 1),
                h1=h1, h2=h2, h3=h3, tofill=text.count("待填"))

def cross_scan(base):
    """扫描全部 session，报告哪些 session 含有对该文件的【成功】写操作（含 heredoc）。"""
    hits = {}
    for sf in ALL_SESSIONS:
        n = 0
        outcomes = load_call_outcomes(sf)
        for cid, name, a in iter_calls(sf, base):
            if cid not in outcomes or outcomes[cid]:
                continue
            p = str(a.get("path", ""))
            if name == "write" and base in p: n += 1
            elif name == "edit" and base in p: n += 1
            elif name == "apply_patch" and base in str(a.get("patch", "")): n += 1
            elif name == "bash" and extract_bash_writes(str(a.get("command", "")), base): n += 1
        if n:
            tag = "MAIN" if sf == MAIN else os.path.basename(os.path.dirname(os.path.dirname(sf)))[:8]
            hits[tag] = n
    return hits

def find_odd_writes(base):
    """检测非常规写入方式：bash 提及目标文件名但不匹配 cat-heredoc。"""
    odd = []
    for sf in ALL_SESSIONS:
        outcomes = load_call_outcomes(sf)
        for cid, name, a in iter_calls(sf, base):
            if name != "bash":
                continue
            if cid in outcomes and outcomes[cid]:
                continue
            cmd = str(a.get("command", ""))
            if base in cmd and not extract_bash_writes(cmd, base) and re.search(
                    r"(>\s*\S*" + re.escape(base) + r"|tee\s|python3?\s+-c|sed\s+-i|cp\s+\S+\s+\S*" + re.escape(base) + r")", cmd):
                tag = "MAIN" if sf == MAIN else os.path.basename(os.path.dirname(os.path.dirname(sf)))[:8]
                odd.append(f"{tag}: {cmd[:160]!r}")
    return odd

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--all"
    if mode in ("--all", "--reports"):
        for base, srcs, ref in REPORTS:
            text, ops, failed = replay(srcs, base)
            st = stats(text)
            if text is not None:
                with open(os.path.join(OUT, base), "w") as f:
                    f.write(text)
            hits = cross_scan(base)
            odd = find_odd_writes(base)
            print(f"### {base}")
            print(f"  参考值: {ref}")
            print(f"  操作序列: {compress_ops(ops)}")
            print(f"  edit-FAIL: {failed}")
            print(f"  统计: {st}")
            print(f"  实际写入者分布(全 session 扫描): {hits}")
            print(f"  非常规写入检测: {odd if odd else '无'}")
            print()
    if mode in ("--all", "--scripts"):
        for base, src in SCRIPTS:
            text, ops, failed = replay([src], base)
            if text is not None and len(text) > 50:
                with open(os.path.join(SCPT, base), "w") as f:
                    f.write(text)
            st = stats(text)
            print(f"### {base}")
            print(f"  操作序列: {compress_ops(ops)}  edit-FAIL: {failed}")
            print(f"  统计: {st if st else '未找到'}")
            print()

if __name__ == "__main__":
    main()
