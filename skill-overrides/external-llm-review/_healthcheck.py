#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv", "pyyaml"]
# ///
"""Health check for all providers — minimal "say hello" request."""

import asyncio
import sys
from pathlib import Path
from dotenv import load_dotenv
from _config import get_provider
import httpx

SKILL_DIR = Path(__file__).resolve().parent
PROVIDERS = ["idealab-anthropic", "idealab-openai", "bailian", "deepseek"]

load_dotenv(SKILL_DIR / ".env")


async def check(provider_name: str) -> tuple[str, bool, str]:
    try:
        provider = get_provider(provider_name)
    except Exception as exc:
        return provider_name, False, f"config load failed: {exc}"

    messages = [{"role": "user", "content": "Say 'OK' and nothing else."}]
    spec = {"temperature": 0.0, "max_tokens": 20, "timeout": 30.0}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            content = await provider.send_chat(client, messages, spec)
        return provider_name, True, content.strip()[:80]
    except httpx.HTTPStatusError as exc:
        try:
            await exc.response.aread()
            body = exc.response.text[:200]
        except Exception:
            body = ""
        return provider_name, False, f"{exc.response.status_code} {body}"
    except Exception as exc:
        return provider_name, False, f"{type(exc).__name__}: {exc}"


async def main():
    results = await asyncio.gather(*[check(p) for p in PROVIDERS])
    all_ok = True
    for name, ok, detail in results:
        status = "OK" if ok else "FAIL"
        if not ok:
            all_ok = False
        print(f"  [{status}] {name}: {detail}")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
