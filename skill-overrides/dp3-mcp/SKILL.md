---
name: dp3-mcp
description: Use when querying TIGA DP3 Event or Monitor metadata and data, investigating dp3-event-data-search responses, or inspecting DP3 schemas through the tiga-ssot-dp3 TMCP server.
compatibility: Requires the external tmcp Skill and its configured um CLI.
metadata:
  external-skill: tmcp
---

# DP3 MCP

## Overview

Use the bundled one-shot CLI for DP3 reads. The wrapper retains no cross-command state. Transport lifecycle belongs to `um tmcp client`; do not add a daemon or connection pool.

**REQUIRED EXTERNAL SKILL:** Load and follow `tmcp` before the first command. Installation, `um whoami`, login, Token setup, tenant selection, `doctor`, and authentication failures belong exclusively to the `tmcp` Skill. Never copy credentials, inspect Token caches, pass authentication headers, or invent a fallback login flow here.

## Lifecycle Boundary

The wrapper execs one `um tmcp client` process and never reuses state. Current `um` closes on normal completion. Some upstream errors exit before protocol-level close, so remote cleanup may wait for timeout; do not promise deterministic close on failures.

## CLI

Set `SKILL_DIR` to the absolute directory containing this `SKILL.md`:

```bash
SKILL_DIR="/absolute/path/to/dp3-mcp"
CLI="$SKILL_DIR/scripts/dp3-mcp"

bash "$CLI" list
bash "$CLI" describe dp3-event-data-search
bash "$CLI" call dp3-event-data-search /absolute/path/to/request.json
```

The default environment is `pre`. Select another registry environment only when the user or task requires it:

```bash
bash "$CLI" --env daily list
bash "$CLI" --env prod describe dp3-monitor-data-search
```

Always run `describe` before the first call to a tool in the session. Until its output is available, do not predict input field names such as `id` or `eventId`, and do not draft a request body. Build arguments from the returned `inputSchema`, write them to an absolute JSON file with no credentials, then use `call`. Do not pass inline JSON, custom headers, endpoints, stdio commands, or transport overrides.

## Data Boundaries

- Treat tools as read-only; include pagination and time ranges in every call.
- Use the smallest useful time window and page size.
- The CLI forwards raw stdout into the current model context; it has no response sanitizer.
- Use schema projections to exclude `userId`, `utdid`, device identifiers, IP/location, session data, and signed URLs. If exclusion is impossible, do not call from Pi; use an approved non-model consumer.
- Do not persist or quote unknown response fields.
- `{"class":"com.alibaba.motu.commons.Result","success":true}` without `data` is an incomplete provider response, not an empty result set.
- `dp3-event-data-sql` cannot query historical DP2 `wireless_mcap` views; do not use it as an automatic fallback.

## Common Mistakes

| Mistake | Required action |
|---|---|
| `um` login or Token fails | Stop and follow the external `tmcp` Skill |
| Tool arguments are uncertain | Run `describe`; do not guess fields |
| A call returns a success-only wrapper | Report the missing `data`; do not synthesize records |
| Multiple calls seem related | Pass complete arguments each time; do not create persistent MCP state |
