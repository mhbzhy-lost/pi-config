#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "python-dotenv", "pyyaml"]
# ///
"""Health check for all providers — minimal "say hello" request."""

import asyncio
import re
import sys
from pathlib import Path
from dotenv import load_dotenv
from _config import get_provider
import httpx

SKILL_DIR = Path(__file__).resolve().parent
PROVIDERS = ["idealab-anthropic", "idealab-openai"]

_SAFE_DIAGNOSTIC_VALUE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_SAFE_EXCEPTION_TYPE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _exception_type(exc: Exception) -> str:
    name = type(exc).__name__
    return name if _SAFE_EXCEPTION_TYPE.fullmatch(name) else "UnknownError"


def _http_error_detail(response) -> str:
    status_code = getattr(response, "status_code", None)
    status = str(status_code) if isinstance(status_code, int) and 100 <= status_code <= 599 else "unknown"
    parts = [f"HTTP {status}"]

    try:
        body = response.json()
        error = body.get("error") if isinstance(body, dict) else None
    except Exception:
        error = None

    if isinstance(error, dict):
        for field in ("code", "type", "param"):
            value = error.get(field)
            if isinstance(value, str) and _SAFE_DIAGNOSTIC_VALUE.fullmatch(value):
                parts.append(f"{field}={value}")

    return ": ".join((parts[0], " ".join(parts[1:]))) if len(parts) > 1 else parts[0]


async def check(provider_name: str) -> tuple[str, bool, str]:
    try:
        provider = get_provider(provider_name)
    except Exception as exc:
        return provider_name, False, f"config load failed: {_exception_type(exc)}"

    messages = [{"role": "user", "content": "Say 'OK' and nothing else."}]
    spec = {"temperature": 0.0, "max_tokens": 20, "timeout": 30.0}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            await provider.send_chat(client, messages, spec)
        return provider_name, True, "reachable"
    except httpx.HTTPStatusError as exc:
        return provider_name, False, _http_error_detail(exc.response)
    except Exception as exc:
        return provider_name, False, f"request failed: {_exception_type(exc)}"


async def main():
    load_dotenv(SKILL_DIR / ".env")
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
