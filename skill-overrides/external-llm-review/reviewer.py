# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv", "pyyaml"]
# ///
"""External LLM cross-model code reviewer.

Two backends:
  - idealab-anthropic  Anthropic Messages API via httpx with claude-cli UA spoofing
  - idealab-openai     Idealab OpenAI-compatible Qwen streaming API

Reads .env from this skill directory.

Usage:
    python reviewer.py <BASE_SHA> <HEAD_SHA> \
        [--provider idealab-anthropic|idealab-openai] [--worktree PATH] [--spec FILE]
        [--max-diff N] [--review-depth standard|exhaustive] [--review-round 1|2]
        [--max-issues N] [--max-output-tokens N] [--api-timeout-seconds N]

Sandbox warning: this script POSTs source diffs to an external endpoint. Run only
when that endpoint is authorized for the project's compliance posture. See SKILL.md.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import os
import subprocess
import sys
from dataclasses import dataclass
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlparse

from _config import get_provider

import httpx
from dotenv import load_dotenv

_REVIEW_DEPTHS = ("standard", "exhaustive")
_REVIEW_ROUNDS = (1, 2)
_REDACTED = "[redacted]"
ANTHROPIC_USER_AGENT = "claude-cli/2.1.156 (external, sdk-cli)"
_SENSITIVE_BODY_PATTERNS = (
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s\"',}]+"),
    re.compile(r"(?i)(bearer\s+)[^\s\"',}]+"),
    re.compile(r"(?i)(\"(?:api[_-]?key|token|access[_-]?token|secret)\"\s*:\s*\")[^\"]+(\")"),
)
_SAFE_API_DIAGNOSTIC = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_SAFE_EXCEPTION_TYPE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
DEFAULT_REQUEST_TIMEOUT_SECONDS = 600.0


_REVIEW_SYSTEM_PROMPT = """你是一名资深代码评审者。被评审代码可能涉及多种语言、框架与外部依赖。

评审重点（同族模型常漏，请尤其关注）：
1. 库版本兼容 / API deprecation：使用了已废弃的 API、版本不匹配、import 路径漂移
2. async 卫生：所有阻塞 subprocess / 同步 IO 必须放到 worker thread；await 前不要持有 mutable shared state
3. 输入边界与路径安全：所有用户/外部数据构成的路径都要校验防穿越
4. 错误传播一致：失败路径要么显式抛出有意义的异常，要么落到错误字段；不要 silent swallow
5. 子进程 / 网络错误诊断：stderr / response body 要保留到错误信息里，便于排查
6. 安全 / 数据泄露：敏感字段（凭据 / 用户输入）不要进日志或异常 message

评审方式：
- 不要只报告 top 3。先系统性扫描候选风险，再合并同类项，最后按严重度输出。
- 同类问题应归并为一条模式级 issue，并列出受影响文件/路径。
- 如果某个检查维度未发现问题，必须在 Checklist Coverage 中说明已检查。

输出格式（严格遵守）：

### Strengths
[简洁列出代码做得好的地方]

### Issues

#### Critical (Must Fix)
[运行时 bug / 数据丢失 / 安全 / 接口误用，每条带 file:line 说明]

#### Important (Should Fix)
[架构 / 错误处理 / 缺失边界，每条带 file:line]

#### Minor (Nice to Have)
[风格 / 微优化]

### Checklist Coverage
[列出已检查但未发现问题的维度；若 diff 不适用，也说明 N/A]

### Assessment

**Ready to merge?** Yes | No | With fixes
**Reasoning:** 一两句话说明判断依据。
"""


def build_review_protocol(
    *,
    review_depth: str,
    review_round: int,
    max_issues: int,
) -> str:
    if review_depth not in _REVIEW_DEPTHS:
        raise ValueError(f"unsupported review depth: {review_depth}")
    if review_round not in _REVIEW_ROUNDS:
        raise ValueError(f"review_round must be 1 or 2, got {review_round}")

    shared = f"""## Review Protocol

- 最多报告 {max_issues} 个问题；不要只报告 top 3。
- 先枚举候选风险，再合并重复/同模式问题，最后按 Critical / Important / Minor 分类。
- 同一模式影响多个文件时，归并为一条 issue，并列出代表性 file:line 与受影响范围。
- 对每条 Critical / Important 给出可验证证据：file:line、触发条件、为什么现有测试/逻辑挡不住。
- 必须输出 Checklist Coverage，列出已检查但未发现问题的维度；不适用项写 N/A。

逐项检查清单：
1. 实现是否真正满足 spec / bug-analysis 的根因与影响范围
2. 入口参数、help、dry-run 是否会误触发网络/写文件/远端副作用
3. 临时文件、trap、exec、cleanup、stdin/stdout/stderr 处理是否可靠
4. shell 兼容性：bash/zsh 特殊变量、set -euo pipefail、mktemp、glob、TTY/非 TTY
5. 子进程 / 网络错误是否保留 stderr / response body / 可诊断上下文
6. 幂等性、重复执行、部分失败、回滚/备份是否安全
7. 输入边界、路径穿越、敏感信息泄露、权限边界是否合理
8. 并发/异步/缓存/状态共享是否引入竞态或陈旧状态
9. 新增测试是否覆盖根因路径和影响范围，而不是只覆盖表面失败
"""

    if review_depth == "standard":
        depth_note = "- 本轮是 standard review：优先报告证据明确、影响实际运行的缺陷。"
    else:
        depth_note = "- 本轮是 exhaustive review：尽量在单次报告中暴露完整问题面，不要留到后续轮次再补充。"

    if review_round == 1:
        round_note = """- 第一轮：做完整横向扫描，目标是在本轮暴露主要问题面。
- 不要因为已找到几个问题就停止；继续扫完整个 diff 和检查清单。"""
    else:
        round_note = """- 第二轮：只验证上一轮已修复项、修复引入的新 diff、以及仍然直接阻断合并的 Critical/Important。
- 不要扩展到无关历史问题；除非它会被本轮改动实际触发或构成 Critical 风险。"""

    return "\n".join([shared.rstrip(), depth_note, round_note]).strip()


def build_review_user_prompt(
    *,
    base_sha: str,
    head_sha: str,
    diff: str,
    truncated: bool,
    review_depth: str,
    review_round: int,
    max_issues: int,
) -> str:
    protocol = build_review_protocol(
        review_depth=review_depth,
        review_round=review_round,
        max_issues=max_issues,
    )
    return f"""{protocol}

## Git Diff ({base_sha[:7]}..{head_sha[:7]}{', truncated' if truncated else ''})

```diff
{diff}
```

请按系统提示要求的格式输出评审结果。
"""


def resolve_provider(args: argparse.Namespace, *, env: Mapping[str, str]) -> str:
    """Resolve which provider to use from args or env.

    Returns provider name (e.g. 'idealab-anthropic', 'idealab-openai').
    """
    provider = (getattr(args, "provider", None) or env.get("EXTERNAL_LLM_REVIEW_PROVIDER", "idealab-anthropic")).strip().lower()
    if provider not in ("idealab-anthropic", "idealab-openai"):
        raise ValueError(
            "EXTERNAL_LLM_REVIEW_PROVIDER/--provider must be one of "
            "('idealab-anthropic', 'idealab-openai'), got "
            f"{provider!r}"
        )
    return provider


def endpoint_host(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    if parsed.hostname:
        return parsed.hostname.lower()
    no_scheme = endpoint.split("://", 1)[-1]
    return no_scheme.split("/", 1)[0].split(":", 1)[0].lower()


def _join_prompt_blocks(blocks: list[str]) -> str:
    return "\n\n".join(block.strip() for block in blocks if block.strip())


def build_plain_user_prompt(
    *,
    user_prompt: str,
    spec_block: str,
) -> str:
    stable_blocks = [block for block in [spec_block] if block.strip()]
    return _join_prompt_blocks([*stable_blocks, user_prompt])


def build_chat_messages(
    *,
    user_prompt: str,
    spec_block: str,
) -> list[dict[str, object]]:
    """Build plain OpenAI Chat Completions messages."""
    return [
        {"role": "system", "content": _REVIEW_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": build_plain_user_prompt(
                user_prompt=user_prompt,
                spec_block=spec_block,
            ),
        },
    ]


def extract_openai_content(resp: object) -> str:
    choices = getattr(resp, "choices", None)
    if not choices:
        raise RuntimeError("chat completion returned empty choices")
    choice = choices[0]
    message = getattr(choice, "message", None)
    content = getattr(message, "content", None) or ""
    if content:
        return content

    # Qwen reasoning model: thinking budget consumed → reasoning_content has
    # the actual output, content is empty. Fall back to reasoning_content.
    reasoning_content = getattr(message, "reasoning_content", None) or ""
    if reasoning_content:
        return reasoning_content

    finish_reason = getattr(choice, "finish_reason", None)
    usage = getattr(resp, "usage", None)
    completion_tokens = getattr(usage, "completion_tokens", None) if usage else None
    details = getattr(usage, "completion_tokens_details", None) if usage else None
    reasoning_tokens = _usage_detail(details, "reasoning_tokens")
    reasoning_len = len(reasoning_content)
    raise RuntimeError(
        "chat completion returned empty content"
        f" finish_reason={finish_reason}"
        f" completion_tokens={completion_tokens}"
        f" reasoning_tokens={reasoning_tokens}"
        f" reasoning_content_len={reasoning_len}"
    )


async def extract_openai_stream_content(chunks) -> dict:
    """Parse a stream of OpenAI SSE chunk dicts into {content, reasoning_content, finish_reason, usage}.

    Incrementally accumulates delta.content and delta.reasoning_content
    as each chunk arrives (no upfront buffering). A chunk that is not a
    dict is tolerated with a stderr warning instead of terminating the
    stream, so a transient bad chunk doesn't abort a long review.

    The final usage is only trusted when finish_reason is set, guarding
    against mid-stream usage fields that may be incomplete.

    Accepts either an async or sync iterable of chunk dicts.
    """
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    finish_reason = None
    usage = None
    saw_any = False

    async for chunk in _ensure_async_iter(chunks):
        saw_any = True
        if not isinstance(chunk, dict):
            print(
                "[external-llm-review] WARN: dropping malformed SSE chunk",
                file=sys.stderr,
            )
            continue
        chunk_choices = chunk.get("choices") or []
        if not chunk_choices:
            if "usage" in chunk:
                usage = chunk["usage"]
            continue
        choice = chunk_choices[0]
        delta = choice.get("delta") or {}
        if delta.get("content"):
            content_parts.append(delta["content"])
        if delta.get("reasoning_content"):
            reasoning_parts.append(delta["reasoning_content"])
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
        if "usage" in chunk and chunk["usage"] and finish_reason is not None:
            usage = chunk["usage"]

    if not saw_any:
        raise RuntimeError("stream returned no chunks")

    return {
        "content": "".join(content_parts),
        "reasoning_content": "".join(reasoning_parts),
        "finish_reason": finish_reason,
        "usage": usage,
    }


async def _ensure_async_iter(obj):
    """Wrap a sync iterable as async so the caller can always use async for."""
    try:
        obj.__aiter__
        async for item in obj:
            yield item
    except AttributeError:
        for item in obj:
            yield item


async def parse_sse_lines(lines):
    """Yield parsed JSON objects from Server-Sent Events text lines (async).

    Implements the SSE state machine per spec:
    - `data:` lines accumulate into the current event buffer (joined with \\n).
    - A blank line terminates the event and flushes the buffer.
    - The sentinel `data: [DONE]` ends the stream immediately.
    - Other SSE fields (event/id/retry/comment `:`) are ignored.
    - A malformed JSON payload (after blank-line flush) is logged and skipped,
      so transient line-break errors don't abort the whole review.

    Accepts either an async or sync iterable of text lines.
    """
    buffer: list[str] = []
    async for raw in _ensure_async_iter(lines):
        line = raw.rstrip("\r\n")
        if line == "":
            if not buffer:
                continue
            payload = "\n".join(b[5:].lstrip(" ") for b in buffer)
            buffer = []
            if payload == "[DONE]":
                return
            if not payload:
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                print(
                    "[external-llm-review] WARN: skipping malformed SSE payload",
                    file=sys.stderr,
                )
        elif line.startswith("data:"):
            buffer.append(line)


def _usage_detail(details: object, name: str) -> object:
    if details is None:
        return None
    if isinstance(details, dict):
        return details.get(name)
    return getattr(details, name, None)


def build_anthropic_messages_payload(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
    max_tokens: int,
) -> dict:
    payload = {
        "model": model,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
    }
    if max_tokens > 0:
        payload["max_tokens"] = max_tokens
    return payload


def extract_anthropic_text(resp: object) -> str:
    content = getattr(resp, "content", None)
    if not content:
        raise RuntimeError("messages API returned empty content")
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if text:
                return text
    raise RuntimeError("messages API response had no text block")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def read_text_block(path: str, *, label: str, allowed_roots: list[Path]) -> str:
    resolved_path = Path(path).resolve()
    resolved_roots = [root.resolve() for root in allowed_roots]
    if not any(_is_relative_to(resolved_path, root) for root in resolved_roots):
        allowed = ", ".join(str(root) for root in resolved_roots)
        raise ValueError(f"{path} is outside allowed roots: {allowed}")
    return f"## {label}: {resolved_path}\n\n{resolved_path.read_text(encoding='utf-8')}\n"


def response_body_text(body: object) -> str:
    if isinstance(body, bytes):
        text = body.decode("utf-8", errors="replace")
    else:
        text = str(body)

    for pattern in _SENSITIVE_BODY_PATTERNS:
        text = pattern.sub(redact_sensitive_match, text)
    return text


def redact_sensitive_match(match: re.Match[str]) -> str:
    groups = match.groups()
    if len(groups) >= 2:
        return f"{groups[0]}{_REDACTED}{groups[-1]}"
    if groups:
        return f"{groups[0]}{_REDACTED}"
    return _REDACTED


def describe_api_exception(exc: Exception) -> str:
    parts = [safe_exception_type_name(exc)]
    response = getattr(exc, "response", None)
    if response is not None:
        status_code = getattr(response, "status_code", None)
        if isinstance(status_code, int) and not isinstance(status_code, bool) and 100 <= status_code <= 599:
            parts.append(f"status_code={status_code}")
    for field in ("code", "type", "param", "request_id"):
        value = getattr(exc, field, None)
        if isinstance(value, str) and _SAFE_API_DIAGNOSTIC.fullmatch(value):
            parts.append(f"{field}={value}")
    return " ".join(parts)


def safe_exception_type_name(exc: BaseException) -> str:
    name = type(exc).__name__
    if _SAFE_EXCEPTION_TYPE_NAME.fullmatch(name):
        return name
    return "UnknownError"



def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


class _AttrDict:
    """Wrap a dict so attribute access works. Used to adapt httpx JSON dicts to
    the same dot-access interface extract_* functions expect."""

    def __init__(self, data: dict):
        self._data = data

    def __getattr__(self, name: str):
        try:
            value = self._data[name]
        except KeyError:
            raise AttributeError(name) from None
        if isinstance(value, dict):
            return _AttrDict(value)
        return value

    @classmethod
    def from_messages(cls, data: dict) -> "_AttrDict":
        content = data.get("content") or []
        if isinstance(content, list):
            content = [item if not isinstance(item, dict) else item for item in content]
        return cls({"content": content})

    @classmethod
    def from_chat(cls, data: dict) -> "_AttrDict":
        choices = data.get("choices") or []
        wrapped = []
        for choice in choices:
            if not isinstance(choice, dict):
                wrapped.append(choice)
                continue
            message = choice.get("message", {})
            if isinstance(message, dict):
                message = _AttrDict(message)
            wrapped.append({**choice, "message": message})
        usage = data.get("usage")
        if isinstance(usage, dict):
            usage = _AttrDict(usage)
        return cls({"choices": wrapped, "usage": usage})


class SafeArgumentParser(argparse.ArgumentParser):
    """An argument parser that does not expose untrusted parse diagnostics."""

    def error(self, message: str) -> None:
        del message
        self.exit(2, "ERROR: invalid command line arguments\n")


async def main() -> int:
    try:
        parser = build_arg_parser()
        args = parser.parse_args()

        skill_dir = Path(__file__).resolve().parent
        load_dotenv(skill_dir / ".env")

        return await run_review(args=args, skill_dir=skill_dir)
    except Exception as exc:
        print(
            f"ERROR: unexpected failure: {safe_exception_type_name(exc)}",
            file=sys.stderr,
        )
        return 1


def build_arg_parser() -> argparse.ArgumentParser:
    parser = SafeArgumentParser()
    parser.add_argument("base_sha", help="git base commit (e.g. main, 76bddc5)")
    parser.add_argument("head_sha", help="git head commit (the changes to review)")
    parser.add_argument(
        "--provider",
        choices=("idealab-anthropic", "idealab-openai"),
        default=None,
        help="provider to use (default: EXTERNAL_LLM_REVIEW_PROVIDER or idealab-anthropic)",
    )
    parser.add_argument("--worktree", default=".", help="worktree path (default: cwd)")
    parser.add_argument("--spec", help="optional spec/requirements file path")
    parser.add_argument("--max-diff", type=int, default=80000,
                        help="char cap on diff sent to model (default 80000)")
    parser.add_argument(
        "--review-depth",
        choices=_REVIEW_DEPTHS,
        default=None,
        help="review depth (default: EXTERNAL_LLM_REVIEW_DEPTH or exhaustive)",
    )
    parser.add_argument(
        "--review-round",
        type=int,
        choices=_REVIEW_ROUNDS,
        default=1,
        help="review round for this diff; only 1 or 2 are supported",
    )
    parser.add_argument(
        "--max-issues",
        type=int,
        default=25,
        help="maximum number of issues the reviewer should report (default 25)",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=32768,
        help="maximum model output tokens (default 32768; set <=0 to omit)",
    )
    parser.add_argument(
        "--api-timeout-seconds",
        type=int,
        default=180,
        help=(
            "hard wall-clock timeout around the API call (default 180). "
            "Set <=0 to drop the wall-clock cap and fall back to the OpenAI "
            "SDK default (~600s)."
        ),
    )
    return parser


def build_git_diff_command(worktree: str, base_sha: str, head_sha: str) -> list[str]:
    diff_target = base_sha if head_sha == "WORKTREE" else f"{base_sha}..{head_sha}"
    return ["git", "-C", worktree, "diff", "--diff-filter=ACM", diff_target]


async def run_review(*, args: argparse.Namespace, skill_dir: Path) -> int:
    legacy_format = os.environ.get("EXTERNAL_LLM_API_FORMAT", "").strip()
    if legacy_format and legacy_format.lower() != "chat":
        print(
            "ERROR: EXTERNAL_LLM_API_FORMAT is no longer read by reviewer.py. "
            "Provider selection is now done via --provider or "
            "EXTERNAL_LLM_REVIEW_PROVIDER (one of: idealab-anthropic, idealab-openai). "
            "Please remove EXTERNAL_LLM_API_FORMAT from your .env file. "
            "See .env.example and providers/<name>.yaml.",
            file=sys.stderr,
        )
        return 1

    for legacy_var in ("EXTERNAL_LLM_CACHE_MODE", "EXTERNAL_LLM_CACHE_DIFF"):
        if os.environ.get(legacy_var, "").strip():
            print(
                f"WARN: {legacy_var} is set but no longer honored "
                "(qwen-explicit cache support has been removed). Remove it from "
                "your .env to silence this warning.",
                file=sys.stderr,
            )

    try:
        provider_name = resolve_provider(args, env=os.environ)
    except ValueError:
        print(
            "ERROR: --provider/EXTERNAL_LLM_REVIEW_PROVIDER must be one of "
            "('idealab-anthropic', 'idealab-openai')",
            file=sys.stderr,
        )
        return 1

    review_depth = (
        args.review_depth
        or os.environ.get("EXTERNAL_LLM_REVIEW_DEPTH", "exhaustive").strip().lower()
    )

    if review_depth not in _REVIEW_DEPTHS:
        print(
            "ERROR: EXTERNAL_LLM_REVIEW_DEPTH/--review-depth must be one of "
            f"{_REVIEW_DEPTHS}",
            file=sys.stderr,
        )
        return 1

    if args.max_issues < 1:
        print("ERROR: --max-issues must be >= 1", file=sys.stderr)
        return 1

    try:
        provider = get_provider(provider_name)
    except Exception as exc:
        print(
            f"ERROR: provider configuration failed: {safe_exception_type_name(exc)}",
            file=sys.stderr,
        )
        return 1

    try:
        # Exclude deletions (D) and renames (R) to avoid bloating diff with mass file removals
        diff = subprocess.check_output(
            build_git_diff_command(args.worktree, args.base_sha, args.head_sha),
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        print(
            f"ERROR: git diff failed: {safe_exception_type_name(exc)}",
            file=sys.stderr,
        )
        return 2

    if not diff.strip():
        print("ERROR: empty diff (range produces no changes)", file=sys.stderr)
        return 3

    truncated = False
    if len(diff) > args.max_diff:
        diff = diff[: args.max_diff]
        truncated = True

    allowed_context_roots = [Path(args.worktree), skill_dir]

    spec_block = ""
    if args.spec:
        try:
            spec_block = read_text_block(
                args.spec,
                label="Spec / Requirements",
                allowed_roots=allowed_context_roots,
            )
        except (OSError, ValueError) as exc:
            print(
                f"WARN: could not read --spec: {safe_exception_type_name(exc)}",
                file=sys.stderr,
            )

    user_prompt = build_review_user_prompt(
        base_sha=args.base_sha,
        head_sha=args.head_sha,
        diff=diff,
        truncated=truncated,
        review_depth=review_depth,
        review_round=args.review_round,
        max_issues=args.max_issues,
    )

    plain_prompt = build_plain_user_prompt(
        user_prompt=user_prompt,
        spec_block=spec_block,
    )

    messages = build_chat_messages(
        user_prompt=user_prompt,
        spec_block=spec_block,
    )

    print(
        f"[external-llm-review] provider={provider_name} model={provider.model}"
        f" endpoint_host={endpoint_host(provider.base_url)}"
        f" diff_chars={len(diff)}{' (truncated)' if truncated else ''}"
        f" review_depth={review_depth} review_round={args.review_round}"
        f" max_issues={args.max_issues}"
        f" api_timeout_seconds={args.api_timeout_seconds}",
        file=sys.stderr,
    )

    hard_timeout = args.api_timeout_seconds if args.api_timeout_seconds > 0 else None
    request_timeout = hard_timeout or DEFAULT_REQUEST_TIMEOUT_SECONDS
    spec = {
        "temperature": 0.2,
        "max_tokens": args.max_output_tokens,
        "timeout": request_timeout,
    }

    try:
        async with asyncio.timeout(hard_timeout):
            async with httpx.AsyncClient(timeout=request_timeout) as client:
                content = await provider.send_chat(client, messages, spec)
    except TimeoutError:
        print(
            f"ERROR: API request exceeded api_timeout_seconds={args.api_timeout_seconds}",
            file=sys.stderr,
        )
        return 4
    except Exception as exc:
        print(f"ERROR: API request failed: {describe_api_exception(exc)}", file=sys.stderr)
        return 4

    print(content)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
