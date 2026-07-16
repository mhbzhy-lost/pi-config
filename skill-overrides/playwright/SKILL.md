---
name: playwright
description: Use when needing to interact with web pages - navigate, click, fill forms, take screenshots, extract page content, test web applications, or automate browser workflows.
---

# Playwright Browser Automation

Control a browser via Playwright MCP for web automation, testing, and content extraction.

## When to Use

- Navigate to URLs and interact with web pages (click, type, select)
- Fill and submit forms
- Take screenshots of web pages
- Extract page content via accessibility snapshots
- Test web applications end-to-end
- Automate multi-step browser workflows
- Monitor console messages or network requests

## Lifecycle

```bash
SCRIPT=~/pi-config/skill-overrides/playwright/playwright.py

# Start browser (headless recommended for automation)
python3 $SCRIPT start --headless

# Check status
python3 $SCRIPT status

# List available tools
python3 $SCRIPT tools

# Stop when done
python3 $SCRIPT stop
```

## Calling Tools

```bash
python3 $SCRIPT call <tool_name> '<json_args>'
```

## Common Workflows

### Navigate and snapshot

```bash
python3 $SCRIPT call browser_navigate '{"url": "https://example.com"}'
python3 $SCRIPT call browser_snapshot
```

### Click an element

Use `browser_snapshot` first to get element references (ref attributes), then:

```bash
python3 $SCRIPT call browser_click '{"element": "Submit button", "target": "e123"}'
```

### Type into a field

```bash
python3 $SCRIPT call browser_type '{"element": "Search input", "target": "e45", "text": "hello"}'
```

### Fill a form (multiple fields)

```bash
python3 $SCRIPT call browser_fill_form '{"fields": [{"name": "username", "type": "textbox", "target": "e10", "value": "user"}, {"name": "password", "type": "textbox", "target": "e11", "value": "pass"}]}'
```

### Take a screenshot

```bash
python3 $SCRIPT call browser_take_screenshot '{"filename": ".playwright-mcp/screenshot.png"}'
```

### Evaluate JavaScript

```bash
python3 $SCRIPT call browser_evaluate '{"function": "() => document.title"}'
```

### Wait for content

```bash
python3 $SCRIPT call browser_wait_for '{"text": "Loading complete"}'
```

### Press keyboard key

```bash
python3 $SCRIPT call browser_press_key '{"key": "Enter"}'
```

## Tool Reference

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to URL |
| `browser_snapshot` | Get accessibility tree (preferred over screenshot for understanding page) |
| `browser_click` | Click element by ref |
| `browser_type` | Type text into element |
| `browser_fill_form` | Fill multiple form fields |
| `browser_take_screenshot` | Save screenshot to file |
| `browser_evaluate` | Run JavaScript |
| `browser_press_key` | Press keyboard key |
| `browser_hover` | Hover over element |
| `browser_select_option` | Select dropdown option |
| `browser_wait_for` | Wait for text or timeout |
| `browser_find` | Search snapshot for text/regex |
| `browser_navigate_back` | Go back |
| `browser_console_messages` | Get console output |
| `browser_network_requests` | List network requests |
| `browser_close` | Close the page |
| `browser_resize` | Resize window |
| `browser_tabs` | Manage browser tabs |

## Best Practices

1. **Always start with `browser_navigate`** then `browser_snapshot` to understand the page
2. **Use snapshot refs** for element interactions - they are stable references from the accessibility tree
3. **Prefer snapshot over screenshot** for understanding page structure
4. **Use `browser_wait_for`** after actions that trigger page changes
5. **Stop the server** when done to free resources
