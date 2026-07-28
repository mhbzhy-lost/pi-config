---
name: crash-mcp
description: Use when querying Motu Crash metadata, instances, stacks, aggregates, or trends through the tiga-ssot-crash TMCP server, without starting the crash fixing workflow.
compatibility: Requires the external tmcp Skill and its configured um CLI.
metadata:
  external-skill: tmcp
---

# Crash MCP

## Overview

Use the bundled one-shot CLI for read-only Crash evidence queries. The wrapper retains no cross-command state. Transport lifecycle belongs to `um tmcp client`; do not add a daemon or connection pool.

**REQUIRED EXTERNAL SKILL:** Load and follow `tmcp` before the first command. Installation, `um whoami`, login, Token setup, tenant selection, `doctor`, and authentication failures belong exclusively to the `tmcp` Skill. Never copy credentials, inspect Token caches, pass authentication headers, or fall back to browser Cookie extraction.

For real iOS crash fixes, use `crash-analyzer-usage`; never substitute this query CLI for its state machine.

## Lifecycle Boundary

The wrapper execs one `um tmcp client` process and never reuses state. Current `um` closes on normal completion. Some upstream errors exit before protocol-level close, so remote cleanup may wait for timeout; do not promise deterministic close on failures.

## CLI

Set `SKILL_DIR` to the absolute directory containing this `SKILL.md`:

```bash
SKILL_DIR="/absolute/path/to/crash-mcp"
CLI="$SKILL_DIR/scripts/crash-mcp"

bash "$CLI" list
bash "$CLI" describe motu_querySimpleReportRecordPage
bash "$CLI" call motu_querySimpleReportRecordPage /absolute/path/to/request.json
```

The default environment is `pre`. Use another registry environment only when the user or task requires it:

```bash
bash "$CLI" --env daily list
bash "$CLI" --env prod describe motu_queryReportClusterTrend
```

Run `list` because the server catalog may evolve, then run `describe` before the first call to a tool in the session. Build arguments only from the returned `inputSchema`, write them to an absolute JSON file with no credentials, and use `call`. Do not pass inline JSON, custom headers, endpoints, stdio commands, or transport overrides.

## Evidence Boundaries

- Require a real Crash locator; never fabricate IDs, URLs, apps, or time windows.
- Keep calls read-only; do not start AIMI, modify code, submit a fix, or publish.
- The CLI forwards raw stdout into the current model context; it has no response sanitizer.
- Use schema projections to exclude PII, authentication material, and signed URLs. If exclusion is impossible, do not call that tool from Pi; use an approved non-model consumer.
- A success-only response without the documented payload is incomplete, not an empty dataset.
- Get tool names and schemas from `list/describe`, not historical notes.

## Common Mistakes

| Mistake | Required action |
|---|---|
| `um` login or Token fails | Stop and follow the external `tmcp` Skill |
| Tool or input fields are uncertain | Run `list` and `describe`; do not guess |
| User asks to fix a crash | Switch to `crash-analyzer-usage` and preserve its reviews |
| Sensitive fields appear unexpectedly | Stop; do not persist or quote them. Treat the call as a policy failure |
| Multiple queries seem related | Send complete arguments each time; do not create persistent MCP state |
