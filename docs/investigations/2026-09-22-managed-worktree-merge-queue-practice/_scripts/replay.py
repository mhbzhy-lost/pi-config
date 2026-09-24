"""按时间顺序重放 write/edit/apply_patch/bash-heredoc，从 child session JSONL 重建报告文件。"""
import json, os, re, sys, glob

def apply_edits(text, edits):
    for e in edits or []:
        old, new = e.get("oldText"), e.get("newText")
        if old is None or new is None: continue
        if old in text:
            text = text.replace(old, new, 1)
        else:
            # 容忍首尾空白差异
            m = re.search(re.escape(old.strip()), text)
            if m: text = text[:m.start()] + new.strip() + text[m.end():]
            else: return text, False
    return text, True

def apply_patch_text(text, patch):
    # 仅处理 Update File 的 @@ 块：按 - / + 行重建
    ok = True
    for blk in re.split(r'\*\*\* (?=Update File|Add File|Delete File)', patch):
        removes = [l[2:] for l in blk.split("\n") if l.startswith("- ") or l == "-"]
        adds    = [l[2:] if l.startswith("+ ") else "" for l in blk.split("\n") if l.startswith("+")]
        if not removes and not adds: continue
        # 逐条 remove→add 配对替换（apply_patch 的模糊匹配在此简化为精确子串）
        for r, a in zip([x for x in blk.split("\n") if x.startswith("-")],
                        [x for x in blk.split("\n") if x.startswith("+")]):
            rb = r[1:].strip(); ab = a[1:]
            if rb and rb in text: text = text.replace(rb, ab.rstrip(), 1)
    return text, ok

def extract_bash_writes(cmd, target_basename):
    """从 bash 命令中提取 cat > / cat >> heredoc 写入"""
    out = []
    for m in re.finditer(r"cat\s*(>>?)\s*(\S+)\s*<<\s*'?(\w+)'?\n(.*?)\n\3", cmd, re.S):
        mode, path, _delim, body = m.group(1), m.group(2), m.group(3), m.group(4)
        if target_basename in path: out.append((mode, body + "\n"))
    return out

def replay(session_file, target_path):
    base = os.path.basename(target_path)
    text = None; ops = []; failed = 0
    for ln in open(session_file, errors="replace"):
        if base not in ln: continue
        try: e = json.loads(ln)
        except: continue
        if e.get("type") != "message": continue
        m = e["message"]
        if m.get("role") != "assistant": continue
        for c in (m.get("content") or []):
            if not isinstance(c, dict) or c.get("type") != "toolCall": continue
            name = c.get("name"); a = c.get("arguments") or {}
            p = str(a.get("path", ""))
            if name == "write" and base in p:
                text = a.get("content", ""); ops.append("write")
            elif name == "edit" and base in p:
                if text is None: text = ""
                text, ok = apply_edits(text, a.get("edits")); ops.append("edit" if ok else "edit-FAIL")
                if not ok: failed += 1
            elif name == "apply_patch" and base in str(a.get("patch", "")):
                if text is None: text = ""
                text, _ = apply_patch_text(text, a.get("patch", "")); ops.append("patch")
            elif name == "bash":
                for mode, body in extract_bash_writes(str(a.get("command", "")), base):
                    if text is None: text = ""
                    text = (text + body) if mode == ">>" else body
                    ops.append("bash" + mode)
    return text, ops, failed

if __name__ == "__main__":
    S = os.path.expanduser("~/pi-config/var/sessions/2026-09-21T11-58-07-128Z_01a0c3d4-a118-743f-83c9-97587cbfe21f")
    target = sys.argv[1]
    for d in sorted(glob.glob(os.path.join(S, "*", "run-*", "session.jsonl"))):
        text, ops, failed = replay(d, target)
        if text and len(text) > 200:
            out = os.path.join("/tmp/recover", os.path.basename(target))
            open(out, "w").write(text)
            print(f"  来源 {os.path.basename(os.path.dirname(os.path.dirname(d)))[:8]}")
            print(f"  操作序列: {' '.join(ops)}")
            print(f"  重放失败次数: {failed}")
            print(f"  重建结果: {len(text)} 字符 / {text.count(chr(10))+1} 行 -> {out}")
            break
    else:
        print("  未找到")
