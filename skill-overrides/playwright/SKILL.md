---
name: playwright
description: Use when needing to interact with web pages - navigate, click, fill forms, take screenshots, extract content, or automate browser workflows. Also use when seeing errors like "Server not running" or "No running instances" from playwright.py.
---

# Playwright Browser Automation

## Overview

Control a browser via a local Playwright MCP wrapper script. The script manages a persistent browser instance and proxies commands through a Unix socket.

**Core principle:** `start` → interact via `call` → `stop`. Always `browser_snapshot` before interacting with elements (provides stable `ref` targets).

## When to Use

- Automate browser interaction: navigate, click, type, select, screenshot
- Extract page content or verify web application state
- Fill and submit forms
- Monitor console messages or network requests

## Lifecycle

```bash
SCRIPT=~/pi-config/skill-overrides/playwright/playwright.py

python3 $SCRIPT start --headless     # Launch browser (always use --headless unless user login needed)
python3 $SCRIPT call <tool> '<json>' # Interact
python3 $SCRIPT stop                 # Clean up
```

Multi-instance: `instances`, `stopall`, `--instance <name>` for disambiguation.

## Core Pattern

```bash
# 1. Navigate
python3 $SCRIPT call browser_navigate '{"url": "https://example.com"}'

# 2. Snapshot to get element refs
python3 $SCRIPT call browser_snapshot

# 3. Interact using refs from snapshot (e.g. target "e123")
python3 $SCRIPT call browser_click '{"element": "Submit", "target": "e123"}'
python3 $SCRIPT call browser_type '{"element": "Search", "target": "e45", "text": "query"}'
```

## Quick Reference

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to URL |
| `browser_snapshot` | Accessibility tree with refs (preferred for understanding page) |
| `browser_click` | Click element by ref |
| `browser_type` | Type into element |
| `browser_fill_form` | Fill multiple fields: `{"fields": [{"name": "...", "type": "textbox", "target": "eN", "value": "..."}]}` |
| `browser_take_screenshot` | Save screenshot: `{"filename": "path.png"}` |
| `browser_evaluate` | Run JS: `{"function": "() => document.title"}` |
| `browser_press_key` | Keyboard key: `{"key": "Enter"}` |
| `browser_hover` | Hover element |
| `browser_select_option` | Dropdown selection |
| `browser_wait_for` | Wait for text: `{"text": "Loading complete"}` |
| `browser_find` | Search snapshot for text/regex |
| `browser_navigate_back` | Go back |
| `browser_console_messages` | Console output |
| `browser_network_requests` | Network requests |
| `browser_close` | Close page |
| `browser_resize` | Resize window |
| `browser_tabs` | Manage tabs |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Calling `browser_click`/`browser_type` without snapshot | Always `browser_snapshot` first to get ref targets |
| Using headed mode unnecessarily | Default to `--headless`; only use headed when user must manually login |
| Forgetting to `stop` after use | Always stop to free resources |
| Guessing element refs | Refs come from snapshot output only; re-snapshot after page changes |
| Snapshotting immediately after navigation/click | Use `browser_wait_for` before re-snapshot on slow pages |
