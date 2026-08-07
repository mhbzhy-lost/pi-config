#!/usr/bin/env python3
"""Fake MCP server used by playwright.py tests.

Reads JSON-RPC line protocol from stdin, replies with a minimal response for
each request, and exits when stdin closes.  Injected into the daemon under
test via the PI_PLAYWRIGHT_MCP_CMD environment variable so tests never touch
npx or the network.
"""

import json
import sys


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = req.get("id")
        if req_id is None:
            continue  # notification (e.g. notifications/initialized)

        if req.get("method") == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "serverInfo": {"name": "fake-mcp", "version": "0.0.0"},
                },
            }
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": "ok"}]},
            }

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
