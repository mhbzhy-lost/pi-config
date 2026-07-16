#!/usr/bin/env python3
"""
Pi session cache hit rate statistics.

Usage:
  cache-stats.py [--days N] [--session ID] [--provider NAME] [--per-session]
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from argparse import ArgumentParser


def find_sessions_dir():
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi" / "agent")
    candidates = [
        Path(agent_dir).parent / "var" / "sessions",
        Path(agent_dir) / "sessions",
    ]
    for d in candidates:
        if d.is_dir():
            return d
    return None


def parse_session_file(path, provider_filter=None):
    turns = []
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
                msg = entry.get("message", {})
                if msg.get("role") != "assistant":
                    continue
                provider = msg.get("provider", "")
                model = msg.get("model", "")
                usage = msg.get("usage", {})
                if not usage:
                    continue
                if provider_filter and provider != provider_filter:
                    continue

                turns.append({
                    "provider": provider,
                    "model": model,
                    "input": usage.get("input", 0),
                    "cacheRead": usage.get("cacheRead", 0),
                    "cacheWrite": usage.get("cacheWrite", 0),
                    "output": usage.get("output", 0),
                    "reasoning": usage.get("reasoning", 0),
                })
            except (json.JSONDecodeError, KeyError):
                continue
    return turns


def aggregate(turns):
    stats = {}
    for t in turns:
        key = f"{t['provider']}/{t['model']}"
        if key not in stats:
            stats[key] = {"turns": 0, "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
        s = stats[key]
        s["turns"] += 1
        s["input"] += t["input"]
        s["cacheRead"] += t["cacheRead"]
        s["cacheWrite"] += t["cacheWrite"]
        s["output"] += t["output"]
    return stats


def hit_rate(s):
    total = s["input"] + s["cacheRead"] + s["cacheWrite"]
    if total <= 0:
        return None
    return s["cacheRead"] / total


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def print_stats(stats, title="Cache Statistics"):
    print(f"\n{title}")
    print("=" * len(title))
    print()
    print(f"{'provider/model':<45} {'turns':>5} {'input':>8} {'cached':>8} {'write':>8} {'hit%':>7}")
    print("-" * 84)

    for key in sorted(stats.keys()):
        s = stats[key]
        hr = hit_rate(s)
        hr_str = f"{hr * 100:.1f}%" if hr is not None else "n/a"
        print(
            f"{key:<45} "
            f"{s['turns']:>5} "
            f"{format_tokens(s['input']):>8} "
            f"{format_tokens(s['cacheRead']):>8} "
            f"{format_tokens(s['cacheWrite']):>8} "
            f"{hr_str:>7}"
        )

    # Totals
    total_input = sum(s["input"] for s in stats.values())
    total_read = sum(s["cacheRead"] for s in stats.values())
    total_write = sum(s["cacheWrite"] for s in stats.values())
    total_turns = sum(s["turns"] for s in stats.values())
    total_all = total_input + total_read + total_write
    total_hr = f"{total_read / total_all * 100:.1f}%" if total_all > 0 else "n/a"

    print("-" * 84)
    print(
        f"{'TOTAL':<45} "
        f"{total_turns:>5} "
        f"{format_tokens(total_input):>8} "
        f"{format_tokens(total_read):>8} "
        f"{format_tokens(total_write):>8} "
        f"{total_hr:>7}"
    )
    print()


def main():
    parser = ArgumentParser(description="Pi session cache hit rate statistics")
    parser.add_argument("--days", type=int, default=1, help="Look back N days (default: 1)")
    parser.add_argument("--session", type=str, help="Filter to specific session ID (partial match)")
    parser.add_argument("--provider", type=str, help="Filter to specific provider name")
    parser.add_argument("--per-session", action="store_true", help="Show per-session breakdown")
    args = parser.parse_args()

    sessions_dir = find_sessions_dir()
    if not sessions_dir:
        print("Error: cannot find sessions directory", file=sys.stderr)
        sys.exit(1)

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    session_files = sorted(sessions_dir.glob("*.jsonl"))

    # Filter by time
    filtered = []
    for f in session_files:
        try:
            ts_str = f.stem.split("_")[0]
            ts = datetime.fromisoformat(ts_str.replace("T", "T").replace("-", "-"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts >= cutoff:
                filtered.append(f)
        except (ValueError, IndexError):
            stat = f.stat()
            if datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc) >= cutoff:
                filtered.append(f)

    # Filter by session ID
    if args.session:
        filtered = [f for f in filtered if args.session in f.stem]

    if not filtered:
        print(f"No sessions found in the last {args.days} day(s)")
        sys.exit(0)

    all_turns = []
    per_session_data = {}

    for f in filtered:
        turns = parse_session_file(f, provider_filter=args.provider)
        all_turns.extend(turns)
        if args.per_session and turns:
            per_session_data[f.stem] = turns

    if not all_turns:
        print(f"No matching turns found in {len(filtered)} session(s)")
        sys.exit(0)

    # Aggregate stats
    stats = aggregate(all_turns)
    title = f"Cache Statistics (last {args.days} day(s), {len(filtered)} sessions)"
    print_stats(stats, title)

    # Per-session breakdown
    if args.per_session:
        for session_id, turns in sorted(per_session_data.items()):
            session_stats = aggregate(turns)
            print_stats(session_stats, f"Session: {session_id[:40]}...")


if __name__ == "__main__":
    main()
