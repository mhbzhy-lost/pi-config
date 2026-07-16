#!/usr/bin/env python3
"""
Exa MCP wrapper for pi skill.
Calls Exa's remote MCP endpoint for web search and content fetching.
"""

import json
import sys
import urllib.request
from typing import Any

MCP_URL = "https://mcp.exa.ai/mcp"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def mcp_call(method: str, params: dict[str, Any], req_id: int = 1) -> dict:
    """Make a JSON-RPC call to Exa MCP."""
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": req_id,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(MCP_URL, data=data, headers=HEADERS, method="POST")

    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        # MCP returns SSE format: "event: message\ndata: {...}"
        for line in body.split("\n"):
            if line.startswith("data: "):
                return json.loads(line[6:])
    raise RuntimeError(f"Unexpected response: {body}")


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
