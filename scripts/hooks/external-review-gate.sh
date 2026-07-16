#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash): 异源 review 自动执行 gate。
# 拦截 git push，自动执行 reviewer.py，两轮策略状态机驱动。
# 通过时透明放行；有问题时 deny + review 全文回填到对话 context。
set -uo pipefail

export PI_CONFIG_HOME="${PI_CONFIG_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Marker 存目标仓库 .git/ 下，不污染 claude-config 仓
GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || GIT_TOP="$(pwd)"
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || GIT_DIR=".git"
# Resolve relative --git-dir against GIT_TOP (needed for submodules where --git-dir returns relative path)
case "$GIT_DIR" in /*) ;; *) GIT_DIR="${GIT_TOP}/${GIT_DIR}" ;; esac
export MARKER_DIR="${GIT_DIR}/review-markers"
export REVIEWER_PY="${PI_CONFIG_HOME}/skill-overrides/external-llm-review/reviewer.py"
export REVIEWER_ENV="${PI_CONFIG_HOME}/skill-overrides/external-llm-review/.env"

python3 -c '
import calendar, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

MARKER_DIR = Path(os.environ["MARKER_DIR"])
REVIEWER_PY = os.environ["REVIEWER_PY"]
REVIEWER_ENV = os.environ["REVIEWER_ENV"]
PI_CONFIG_HOME = os.environ["PI_CONFIG_HOME"]

SKIP_ENV = "EXTERNAL_REVIEW_SKIP"
SKIP_VALUES = {"1", "true", "yes", "on"}
NON_CODE_EXTS = {".md", ".json", ".txt", ".yml", ".yaml", ".toml", ".csv", ".lock", ".gitignore"}
MAX_EXEMPT_LINES = 10
MARKER_TTL_HOURS = 24

# Pattern to detect "no issues" responses in a review section body
_NEGATIVE = re.compile(
    r"^(none\.?|n/?a|no\s+(\w+\s+)?issues(\s+found)?|nothing\s+to\s+report"
    r"|✅|无)",
    re.IGNORECASE,
)


def parse_section(review_text: str, header_keyword: str) -> bool:
    """Return True if a markdown header section contains real issues."""
    pattern = rf"#{{1,4}}\s*{re.escape(header_keyword)}.*?\n(.+?)(?=\n#{{1,4}}\s|\Z)"
    m = re.search(pattern, review_text, re.DOTALL | re.IGNORECASE)
    if not m:
        return False
    body = m.group(1).strip()
    first_line = next((line.strip() for line in body.splitlines() if line.strip()), "")
    normalized_first = re.sub(r"^[-*+]\s*", "", first_line).strip()
    normalized_first = normalized_first.strip("*_` \t")
    if not body or _NEGATIVE.match(normalized_first):
        return False
    return True


def allow():
    log("allow")
    sys.exit(0)


def deny(reason: str):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, ensure_ascii=False))
    sys.exit(0)


def silent(reason: str = "unknown"):
    log(f"skip: {reason}")
    sys.exit(0)


def log(msg: str):
    print(f"[external-review-gate] {msg}", file=sys.stderr)


# --- Parse stdin ---
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except Exception:
    silent("json parse error")

if payload.get("tool_name") not in ("Bash", "run_shell_command", "exec_command", "functions.exec_command"):
    silent("not a bash tool")

tool_input = payload.get("tool_input") or {}
params = tool_input.get("parameters") or tool_input
cmd = (
    params.get("command", "")
    or params.get("cmd", "")
    or tool_input.get("command", "")
    or tool_input.get("cmd", "")
    or ""
)

# Only match git push (not git push-related subcommands)
# Also matches: git -C /path push, git --no-pager push, etc.
# Exclude quoted strings (echo "git push") and comments (# git push)
_cmd_stripped = re.sub(r"([\x22\x27]).*?\1", "", cmd)  # strip quoted strings
_cmd_stripped = re.sub(r"#.*$", "", _cmd_stripped, flags=re.MULTILINE)
if not re.search(r"(^|[;&|]\s*)(\S+=\S+\s+)*git\s+(?:-\S+\s+\S+\s+)*push(\s|$)", _cmd_stripped):
    silent("not git push")

# --- Escape hatch ---
for key in ("env", "environment"):
    env_dict = params.get(key) or tool_input.get(key)
    if isinstance(env_dict, dict) and str(env_dict.get(SKIP_ENV, "")).strip().lower() in SKIP_VALUES:
        log("escape hatch: allow (structured env)")
        allow()

_skip_m = re.search(rf"{SKIP_ENV}=(\S+)\s+git\s+push", cmd)
if _skip_m and _skip_m.group(1).strip().lower() in SKIP_VALUES:
    log("escape hatch: allow (command prefix)")
    allow()

# --- Infer effective git dir (submodule-aware) ---
# Hook CWD = project root, not Bash tool CWD. If main repo has 0 commits
# ahead but a submodule has pending pushes, use that submodule.
_git_prefix = ["git"]
try:
    _hook_git_top = subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"],
        text=True, stderr=subprocess.DEVNULL).strip()
except Exception:
    _hook_git_top = os.getcwd()

# Parse command for explicit cd prefix: "cd /path && git push"
_cd_match = re.search(r"cd\s+([^\s;&|]+)\s*[;&|]", cmd)
_gitC_match = re.search(r"git\s+-C\s+([^\s]+)\s+push", cmd)
_tool_workdir = ""
for _container in (params, tool_input):
    if not isinstance(_container, dict):
        continue
    _candidate = _container.get("workdir") or _container.get("cwd") or ""
    if isinstance(_candidate, str) and _candidate.strip():
        _tool_workdir = _candidate.strip()
        break

if _cd_match and os.path.isdir(os.path.abspath(_cd_match.group(1))):
    _effective = os.path.abspath(_cd_match.group(1))
    _git_prefix = ["git", "-C", _effective]
    os.chdir(_effective)
    log(f"effective dir from cd: {_effective}")
elif _gitC_match and os.path.isdir(os.path.abspath(_gitC_match.group(1))):
    _effective = os.path.abspath(_gitC_match.group(1))
    _git_prefix = ["git", "-C", _effective]
    os.chdir(_effective)
    log(f"effective dir from -C: {_effective}")
elif _tool_workdir and os.path.isdir(os.path.abspath(_tool_workdir)):
    _effective = os.path.abspath(_tool_workdir)
    _git_prefix = ["git", "-C", _effective]
    os.chdir(_effective)
    log(f"effective dir from tool workdir: {_effective}")
else:
    # Check if main repo has 0 commits but a submodule has pending pushes
    _gitmodules = Path(_hook_git_top) / ".gitmodules"
    if _gitmodules.is_file():
        try:
            _main_ahead = subprocess.check_output(
                ["git", "rev-list", "origin/main..HEAD", "--count"],
                text=True, stderr=subprocess.PIPE).strip()
        except subprocess.CalledProcessError as e:
            log(f"rev-list main failed: {e.stderr.strip() if e.stderr else e}")
            _main_ahead = "999"
        except Exception:
            _main_ahead = "999"
        if _main_ahead == "0":
            for _line in _gitmodules.read_text().splitlines():
                _stripped = _line.strip()
                if not _stripped.startswith("path") or "=" not in _stripped:
                    continue
                _sp = _stripped.split("=", 1)[1].strip()
                _sub_abs = os.path.join(_hook_git_top, _sp)
                if not os.path.exists(os.path.join(_sub_abs, ".git")):
                    continue
                try:
                    _sub_ahead = subprocess.check_output(
                        ["git", "-C", _sub_abs, "rev-list", "@{u}..HEAD", "--count"],
                        text=True, stderr=subprocess.PIPE).strip()
                except subprocess.CalledProcessError as e:
                    log(f"submodule {_sp} rev-list failed: {e.stderr.strip() if e.stderr else e}")
                    continue
                except Exception:
                    continue
                if _sub_ahead != "0":
                    _git_prefix = ["git", "-C", _sub_abs]
                    os.chdir(_sub_abs)
                    log(f"detected submodule push: {_sub_abs} ({_sub_ahead} ahead)")
                    break

# Update MARKER_DIR to match effective repo
_eff_top = subprocess.check_output(
    _git_prefix + ["rev-parse", "--show-toplevel"],
    text=True, stderr=subprocess.DEVNULL).strip() if _git_prefix != ["git"] else _hook_git_top
# Use --git-dir for submodule compatibility (.git may be a file, not a directory)
try:
    _gitdir_proc = subprocess.run(
        _git_prefix + ["rev-parse", "--git-dir"],
        text=True, capture_output=True,
    )
    if _gitdir_proc.returncode != 0:
        log(f"WARN: git rev-parse --git-dir exited {_gitdir_proc.returncode}: {_gitdir_proc.stderr.strip()}")
        raise RuntimeError("git-dir failed")
    _eff_git_dir = _gitdir_proc.stdout.strip()
    # --git-dir returns path relative to CWD when invoked outside repo; anchor to _eff_top
    if not os.path.isabs(_eff_git_dir):
        _eff_git_dir = os.path.normpath(os.path.join(_eff_top, _eff_git_dir))
    MARKER_DIR = Path(_eff_git_dir) / "review-markers"
except Exception as _exc:
    # Fallback: .git may be a gitlink file (submodule) — read its `gitdir: ...` line
    _eff_git = os.path.join(_eff_top, ".git")
    if os.path.isfile(_eff_git):
        try:
            with open(_eff_git, encoding="utf-8") as _f:
                _content = _f.read().strip()
            if _content.startswith("gitdir:"):
                _rel = _content[len("gitdir:"):].strip()
                _eff_git_dir = (
                    _rel if os.path.isabs(_rel)
                    else os.path.normpath(os.path.join(_eff_top, _rel))
                )
                MARKER_DIR = Path(_eff_git_dir) / "review-markers"
                log(f"WARN: git-dir lookup failed ({_exc}); used gitlink -> {MARKER_DIR}")
            else:
                log(f"WARN: git-dir failed + .git gitlink unreadable ({_exc}); marker write disabled")
                MARKER_DIR = None
        except OSError as _read_exc:
            log(f"WARN: git-dir + gitlink read failed ({_read_exc}); marker write disabled")
            MARKER_DIR = None
    else:
        log(f"WARN: git-dir failed ({_exc}) and .git not found; marker write disabled")
        MARKER_DIR = None

# --- Determine base ref ---
try:
    base_ref = subprocess.check_output(
        _git_prefix + ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
except Exception:
    try:
        base_ref = subprocess.check_output(
            _git_prefix + ["rev-parse", "--abbrev-ref", "origin/HEAD"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        base_ref = "origin/main"

review_range = f"{base_ref}..HEAD"

# --- Check if there are commits to push ---
try:
    ahead = subprocess.check_output(
        _git_prefix + ["rev-list", review_range, "--count"],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
    if ahead == "0":
        silent("nothing to push")  # nothing to push, let git handle it
except Exception:
    silent("git error")

# --- Check recent test failure marker ---
# This used to be surfaced by a turn-level Stop hook. That fires too often for
# "large task is done"; git push is the actual end-of-task boundary. Only use a
# real session key; PPID-based fallback is predictable in /tmp and can be abused
# by another local process to force false denies.
session_key = os.environ.get("CLAUDE_SESSION_KEY")
if session_key and re.fullmatch(r"[A-Za-z0-9_-]+", session_key):
    for marker_prefix in ("/tmp/.claude-last-test-exit-", "/tmp/.qwen-last-test-exit-"):
        marker_path = Path(f"{marker_prefix}{session_key}")
        try:
            if marker_path.is_file() and marker_path.read_text().strip() == "1":
                deny(
                    "🚫 禁止 git push。最近一次测试执行失败。\n"
                    "请先按 systematic-debugging 流程完成根因分析，修复后重新运行验证命令，"
                    "确认输出通过再 push。"
                )
        except OSError as exc:
            log(f"last test marker check failed for {marker_path}: {exc}")
elif session_key:
    log("skip last test marker check: invalid CLAUDE_SESSION_KEY")

# --- Check .env exists (reviewer.py needs credentials) ---
if not Path(REVIEWER_ENV).is_file():
    log("no .env configured, degraded allow")
    allow()

# --- Get diff stats for exemption ---
try:
    # Exclude deletions (D) and renames (R) to avoid bloating with mass file removals
    diff_stat = subprocess.check_output(
        _git_prefix + ["diff", "--diff-filter=ACM", "--stat", review_range],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
    diff_numstat = subprocess.check_output(
        _git_prefix + ["diff", "--diff-filter=ACM", "--numstat", review_range],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
except Exception:
    log("git diff failed, degraded allow")
    allow()

# Exemption: diff < 10 lines total (binary files skip exemption)
changed_file_count = 0
if diff_numstat:
    total_lines = 0
    all_non_code = True
    has_binary = False
    for line in diff_numstat.strip().split("\n"):
        parts = line.split("\t")
        if len(parts) >= 3:
            changed_file_count += 1
            if parts[0] == "-":
                has_binary = True
            else:
                try:
                    total_lines += int(parts[0]) + int(parts[1])
                except ValueError:
                    has_binary = True
                    continue
                ext = os.path.splitext(parts[2])[1].lower()
                if ext not in NON_CODE_EXTS:
                    all_non_code = False

    if not has_binary:
        if total_lines < MAX_EXEMPT_LINES:
            log(f"exempt: diff only {total_lines} lines")
            allow()

        if all_non_code:
            log("exempt: all files are non-code")
            allow()


def review_context_block() -> str:
    return (
        f"Review range: {review_range}\n"
        f"Review repo: {_eff_top}\n"
        f"Review file count: {changed_file_count}"
    )


def log_review_context():
    for _line in review_context_block().splitlines():
        log(_line)


log_review_context()

# --- Compute diff hash ---
try:
    # Exclude deletions (D) and renames (R) to match reviewer.py behavior
    diff_content = subprocess.check_output(
        _git_prefix + ["diff", "--diff-filter=ACM", review_range],
        text=True, stderr=subprocess.DEVNULL
    )
    diff_hash = hashlib.sha256(diff_content.encode()).hexdigest()[:16]
except Exception:
    log("cannot compute diff hash, degraded allow")
    allow()

# --- Repo slug ---
try:
    remote_url = subprocess.check_output(
        _git_prefix + ["remote", "get-url", "origin"],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
    slug = re.sub(r"[^\w-]", "_", remote_url.split("/")[-1].replace(".git", ""))
except Exception:
    slug = "unknown"

# --- Read marker (skip if MARKER_DIR could not be resolved) ---
if MARKER_DIR is not None:
    try:
        MARKER_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as _exc:
        log(f"WARN: cannot create MARKER_DIR {MARKER_DIR}: {_exc}; marker write disabled")
        MARKER_DIR = None
marker_path = (MARKER_DIR / f"{slug}.json") if MARKER_DIR is not None else None
marker = None
marker = None
if marker_path is not None and marker_path.is_file():
    try:
        marker = json.loads(marker_path.read_text())
        # Check TTL
        ts = marker.get("timestamp", "")
        if ts:
            age_hours = (time.time() - calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))) / 3600
            if age_hours > MARKER_TTL_HOURS:
                marker = None
                log("marker expired")
    except Exception:
        marker = None

# --- State machine ---
def _marker_should_deny(m):
    """Check if a marker indicates the push should be denied."""
    # New format: explicit booleans
    if "has_critical" in m or "has_important" in m:
        return bool(m.get("has_critical")) or bool(m.get("has_important"))
    # Legacy format: assessment string
    a = m.get("assessment", "")
    if "Ready" in a:
        return False
    if "With fixes" in a or "No" in a:
        return True
    # Unknown legacy → re-run rather than guess
    return None  # sentinel: means "re-run"


def _marker_round(m):
    try:
        return int(m.get("round", 0))
    except Exception:
        return 0


def _delete_marker_after_budget():
    if marker_path is None:
        log("no marker to delete (MARKER_DIR could not be resolved)")
        return
    try:
        marker_path.unlink()
        log(f"review budget exhausted; removed marker {marker_path}")
    except FileNotFoundError:
        pass
    except Exception as exc:
        log(f"failed to remove review marker after budget exhausted: {exc}")


def determine_action():
    """Returns (action, round) where action is allow/deny/run and round is 1 or 2."""
    if marker is None:
        return ("run", 1)

    marker_round = _marker_round(marker)
    should_deny = _marker_should_deny(marker)

    # Review budget is capped at two rounds. After round 2 has reported issues,
    # the next push attempt is allowed and the marker is cleared so future pushes
    # start a fresh review cycle.
    if marker_round >= 2 and should_deny is True:
        return ("allow_after_max_rounds", 0)

    if marker.get("diff_hash") == diff_hash:
        if should_deny is True:
            return ("deny_fix_first", 0)
        if should_deny is False:
            return ("allow", 0)
        # Unknown (legacy marker with unparseable assessment) → re-run
        return ("run", 1)

    # diff_hash changed — decide round based on previous result
    prev_denied = _marker_should_deny(marker)
    if marker.get("round") == 1 and prev_denied is True:
        return ("run", 2)

    # Any other case (round 2 old diff, or previous allow with new changes)
    return ("run", 1)


action, review_round = determine_action()

if action == "allow":
    log("marker valid, allow push")
    allow()

if action == "allow_after_max_rounds":
    _delete_marker_after_budget()
    allow()

if action == "deny_fix_first":
    # Check if working tree has changes — developer may have fixed but not committed
    try:
        _staged = subprocess.check_output(
            _git_prefix + ["diff", "--cached", "--stat"],
            text=True, stderr=subprocess.DEVNULL).strip()
        _unstaged = subprocess.check_output(
            _git_prefix + ["diff", "--stat"],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        _staged = ""
        _unstaged = ""

    if _staged or _unstaged:
        _changes = ""
        if _staged:
            _changes += "  staged: " + _staged.split("\n")[-1] + "\n"
        if _unstaged:
            _changes += "  unstaged: " + _unstaged.split("\n")[-1] + "\n"
        deny(
            "🚫 禁止 push。异源 Review 发现的问题疑似已修复但尚未 commit。\n"
            f"{review_context_block()}\n"
            "请先 commit 修复内容后再次 push。\n"
            f"检测到未提交的变更：\n{_changes}"
        )
    else:
        deny(
            "🚫 禁止 push。异源 Review 发现的问题尚未修复。\n"
            f"{review_context_block()}\n"
            "请先修复这些问题并 commit 后再次 push。"
        )

# action == "run"
log(f"executing review round {review_round}...")

# --- Run reviewer.py (try anthropic first, fall back to api on failure) ---
head_sha = subprocess.check_output(_git_prefix + ["rev-parse", "HEAD"], text=True).strip()


def run_reviewer(provider: str) -> "subprocess.CompletedProcess[str] | None":
    try:
        timeout_s = int(os.environ.get("EXTERNAL_REVIEW_TIMEOUT_SECONDS", "540"))
    except ValueError:
        timeout_s = 540
    cmd = [
        "uv",
        "run",
        "--no-project",
        "--with",
        "httpx",
        "--with",
        "python-dotenv",
        "--with",
        "pyyaml",
        "python",
        REVIEWER_PY,
        base_ref,
        "HEAD",
        "--provider",
        provider,
        "--review-depth",
        "exhaustive",
        "--review-round",
        str(review_round),
        "--max-issues",
        "25",
    ]
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        log(f"{provider} provider timed out after {timeout_s}s")
        return None
    except Exception as exc:
        log(f"{provider} provider failed to start: {exc}")
        return None


# Try providers in order: idealab-anthropic → bailian → idealab-openai
# Fall through on timeout/failure/exception
# Collect ALL failures (stderr) for final diagnostic if all providers fail
_PROVIDER_CHAIN = ["idealab-anthropic", "bailian", "idealab-openai"]
result = None
used_provider = None
_collected_failures = []  # list of (provider_name, reason, stderr_snippet)
for _p in _PROVIDER_CHAIN:
    _r = run_reviewer(_p)
    if _r is None:
        log(f"{_p} provider timed out or crashed, trying next")
        _collected_failures.append((_p, "timeout/crash", ""))
        continue
    if _r.returncode != 0:
        log(f"{_p} provider failed (rc={_r.returncode}), trying next")
        _collected_failures.append((_p, f"rc={_r.returncode}", (_r.stderr or "")[:500]))
        continue
    result = _r
    used_provider = _p
    break

if result is None:
    # All providers failed: emit collected stderr (capped) so user can diagnose
    log("degraded allow (all providers failed). Collected stderr:")
    _total = 0
    for _pn, _reason, _se in _collected_failures:
        _snip = (_se or "").strip()[:800]
        log(f"  [{_pn}] reason={_reason}")
        if _snip:
            log(f"  [{_pn}] {_snip}")
        _total += len(_snip)
        if _total > 4000:
            log("  [... truncated ...]")
            break
    allow()

review_output = result.stdout.strip()
if not review_output:
    log(f"{used_provider or 'unknown'} provider produced empty output, degraded allow")
    allow()
log(f"review completed via {used_provider}")

# --- Parse review sections deterministically ---
has_critical = parse_section(review_output, "Critical")
has_important = parse_section(review_output, "Important")
has_minor = parse_section(review_output, "Minor")
should_deny = has_critical or has_important

# --- Write marker (skip if marker_path is None) ---
if marker_path is None:
    log("skipping marker write (MARKER_DIR could not be resolved earlier)")
else:
    new_marker = {
        "round": review_round,
        "diff_hash": diff_hash,
        "has_critical": has_critical,
        "has_important": has_important,
        "has_minor": has_minor,
        "base_ref": base_ref,
        "head_sha": head_sha,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        marker_path.write_text(json.dumps(new_marker, indent=2, ensure_ascii=False) + "\n")
        decision_str = "deny" if should_deny else "pass"
        log(f"marker written: round={review_round} decision={decision_str} "
            f"critical={has_critical} important={has_important} minor={has_minor}")
    except Exception as exc:
        log(f"failed to write marker: {exc}")

# --- Decision ---
if not should_deny:
    log("review passed (no Critical/Important), allow push")
    allow()
else:
    digest = (
        "## 综合判断 4 步（必须执行）\n"
        "1. 逐条比对：列出 (A)双方都抓到 (B)只外源抓到 (C)只同族抓到\n"
        "2. 对(B)做 threat-model 校验：外源常见误报——本机 CLI 输入当不可信、"
        "单 task 阻塞标 Critical、误读累积 diff、只看 diff 没看完整源码\n"
        "3. 对(C)做同族盲点反思：是否涉及训练偏好（生态版本兼容、库 API 名）\n"
        "4. 综合产出 fix dispatch：双方认可 + 任一方有真实 evidence 的项打包修复\n"
        "严重度由证据决定，不由谁说了算。\n\n"
    )
    header = (
        "🚫 禁止 push。异源 Review 发现需要修复的问题。\n\n"
        f"{review_context_block()}\n\n"
        f"{digest}"
        "---\n\n"
    )
    deny(header + review_output)
' <<< "$(cat)"
