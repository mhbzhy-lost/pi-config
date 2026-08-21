#!/usr/bin/env python3
"""
Exa MCP wrapper for pi skill.
Calls Exa's remote MCP endpoint for web search and content fetching.
"""

import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from types import MappingProxyType
from typing import Any

MCP_BASE_URL = "https://mcp.exa.ai/mcp"
MAX_RESPONSE_BYTES = 1 << 20
HEADERS = MappingProxyType({
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "exa-pi-skill/1.0",
})
LOCAL_DOTENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def _truncate_diagnostic(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text

    marker = "<redacted>"
    suffix = "..."
    truncated = text[: limit - len(suffix)]
    for prefix_length in range(len(marker) - 1, 1, -1):
        if truncated.endswith(marker[:prefix_length]):
            truncated = truncated[:-prefix_length]
            break
    return truncated + suffix


def _safe_diagnostic(value: object, api_key: str, limit: int = 500) -> str:
    try:
        text = " ".join(str(value).split())
    except Exception:
        return "<unrepresentable diagnostic>"
    if len(api_key) >= 8:
        text = text.replace(api_key, "<redacted>")
        encoded_key = urllib.parse.quote_plus(api_key)
        if encoded_key != api_key:
            text = text.replace(encoded_key, "<redacted>")
    text = re.sub(
        r"(?i)(exaApiKey=)[^&\s<>\"']+",
        r"\1<redacted>",
        text,
    )
    return _truncate_diagnostic(text, limit)


def _local_dotenv_api_key() -> str:
    try:
        with open(LOCAL_DOTENV_PATH, encoding="utf-8") as dotenv:
            for line in dotenv:
                entry = line.strip()
                if not entry or entry.startswith("#"):
                    continue
                match = re.match(r"(?:export\s+)?EXA_API_KEY\s*=\s*(.*)$", entry)
                if not match:
                    if re.match(r"(?:export\s+)?EXA_API_KEY\b", entry):
                        raise RuntimeError("Invalid EXA_API_KEY entry in local .env")
                    continue
                value = match.group(1).strip()
                if not value:
                    return ""
                if value[0] in ("'", '"'):
                    quote = value[0]
                    if len(value) < 2 or value[-1] != quote or value[1:-1].find(quote) >= 0:
                        raise RuntimeError("Invalid EXA_API_KEY entry in local .env")
                    value = value[1:-1]
                return value.strip()
    except FileNotFoundError:
        return ""
    except OSError:
        raise RuntimeError("Unable to read local .env") from None
    return ""


def _required_api_key() -> str:
    api_key = os.environ.get("EXA_API_KEY", "").strip()
    if not api_key:
        api_key = _local_dotenv_api_key()
    if not api_key:
        raise RuntimeError(
            "EXA_API_KEY is required; set it in the environment or local .env before using exa-search"
        )
    if len(api_key) > 256 or any(ord(char) < 32 or ord(char) == 127 for char in api_key):
        raise RuntimeError(
            "EXA_API_KEY must be at most 256 characters and contain no control characters"
        )
    return api_key


def _read_http_error_body(exc: urllib.error.HTTPError, limit: int = 2048) -> bytes:
    stream = exc.fp
    socket = getattr(
        getattr(getattr(stream, "fp", None), "raw", None), "_sock", None
    )
    if socket is None:
        # BytesIO is bounded in-memory test data. Unknown stream layouts are not read,
        # because no portable API can apply an independent timeout to them.
        return exc.read(limit) if isinstance(stream, io.BytesIO) else b""

    previous_timeout = socket.gettimeout()
    socket.settimeout(5)
    try:
        return exc.read(limit)
    finally:
        socket.settimeout(previous_timeout)


def _mcp_url(api_key: str) -> str:
    return f"{MCP_BASE_URL}?{urllib.parse.urlencode({'exaApiKey': api_key})}"


def mcp_call(method: str, params: dict[str, Any], req_id: int = 1) -> dict:
    """Make a JSON-RPC call to Exa MCP."""
    api_key = _required_api_key()
    mcp_url = _mcp_url(api_key)
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": req_id,
    }

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(mcp_url, data=data, headers=HEADERS, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            body_bytes = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(body_bytes) > MAX_RESPONSE_BYTES:
                raise RuntimeError(
                    f"Exa MCP response exceeds {MAX_RESPONSE_BYTES} bytes"
                )
            body = body_bytes.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            detail = _safe_diagnostic(
                _read_http_error_body(exc).decode("utf-8", errors="replace"), api_key
            )
        except Exception:
            detail = ""
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"Exa MCP request failed with HTTP {exc.code}{suffix}") from None
    except urllib.error.URLError as exc:
        detail = _safe_diagnostic(exc.reason, api_key)
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"Exa MCP request failed before receiving a response{suffix}") from None
    except Exception as exc:
        detail = _safe_diagnostic(exc, api_key)
        suffix = f": {detail}" if detail else f": {type(exc).__name__}"
        raise RuntimeError(f"Exa MCP request/response handling failed{suffix}") from None

    # MCP returns SSE format: "event: message\ndata: {...}"
    for line in body.split("\n"):
        if line.startswith("data: "):
            try:
                return json.loads(line[6:])
            except json.JSONDecodeError:
                detail = _safe_diagnostic(line[6:], api_key)
                raise RuntimeError(f"Exa MCP returned invalid JSON: {detail}") from None
    raise RuntimeError(f"Unexpected response: {_safe_diagnostic(body, api_key)}")


def search(query: str, num_results: int = 10) -> dict:
    """Search the web using Exa."""
    return mcp_call(
        "tools/call",
        {
            "name": "web_search_exa",
            "arguments": {"query": query, "numResults": num_results},
        },
    )


def fetch(urls: list[str], max_characters: int = 3000) -> dict:
    """Fetch full content from URLs."""
    return mcp_call(
        "tools/call",
        {
            "name": "web_fetch_exa",
            "arguments": {"urls": urls, "maxCharacters": max_characters},
        },
    )


def main():
    if len(sys.argv) < 2:
        print("Usage: exa.py <search|fetch> [args...]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: exa.py search <query> [num_results]", file=sys.stderr)
            sys.exit(1)
        query = sys.argv[2]
        num_results = int(sys.argv[3]) if len(sys.argv) > 3 else 10
        result = search(query, num_results)

    elif cmd == "fetch":
        if len(sys.argv) < 3:
            print("Usage: exa.py fetch <url1> [url2] ...", file=sys.stderr)
            sys.exit(1)
        urls = sys.argv[2:]
        result = fetch(urls)

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
