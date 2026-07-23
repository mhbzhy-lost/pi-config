---
name: browser-auth-session
description: Use when browser SSO, login cookies, authenticated sessions, localStorage/sessionStorage tokens, CSRF values, or expired web credentials must be acquired, refreshed, validated, or safely handed to another process or service.
---

# Browser Auth Session

## Overview

Acquire the smallest usable browser login state without exposing bearer credentials to the model, tool output, command arguments, logs, or unnecessary files.

**Core principle:** keep authentication inside the browser whenever possible. Export only what a named consumer demonstrably requires.

**REQUIRED SUB-SKILL:** Use `playwright` for browser lifecycle, interaction, and runtime tool names.

## Decision Order

1. **Browser can perform the operation:** use same-origin `fetch` or the browser request context. Return only sanitized business results. Do not extract credentials.
2. **A local process must consume auth:** transfer directly from the browser context to a one-shot loopback receiver.
3. **A tool requires a cookie jar/file:** use a private temporary directory (`0700`) and file (`0600`), pass only its path, then delete it.
4. **Another machine/service needs auth:** write directly to an approved secret store with short expiry and restricted access. Never relay raw credentials through chat, clipboard, shell arguments, ordinary environment variables, or logs.

## Workflow

### 1. Establish the authenticated session

Start headless with an approved persistent profile when one exists; do not create a clean isolated context merely to probe authentication. Test a known read-only endpoint first. A status `200` is insufficient: reject login HTML, SSO redirects, consent pages, unexpected origins/content types, and business redirect codes.

If user interaction is required, stop the exact browser instance before starting a headed instance with the same approved profile. Ask the user to log in inside the browser; never request or automate passwords, MFA codes, recovery codes, or security keys. Do not copy whole profiles.

### 2. Minimize auth material

Declare exact target origins before extraction. For cookies, call `context.cookies([originA, originB])`, then let the consumer enforce domain/path/expiry and an optional cookie-name allowlist. Do not dump the browser cookie database or use `storageState()` as a shortcut.

Inspect `localStorage` or `sessionStorage` only when a real request proves cookie-only auth is insufficient. Read allowlisted keys from the exact origin. Prefer replaying the request in-browser when CSRF, device binding, or generated headers are involved.

### 3. Transfer in memory

Preferred loopback receiver contract:

- bind only `127.0.0.1` on an unused port;
- accept one request on one path, with a short timeout and body-size cap;
- disable request logging and never echo credential values;
- independently filter origins/names and validate counts/expiry;
- immediately call the named read-only endpoint or write to the approved secret store;
- return only booleans, counts, status codes, and non-sensitive identifiers, then exit.

Browser-side pattern:

```javascript
async (page) => {
  const origins = ["https://service.example.com/"];
  const cookies = await page.context().cookies(origins);
  const response = await page.request.post(
    "http://127.0.0.1:18040/consume-once",
    { data: { cookies } },
  );
  const result = await response.json();
  return {
    accepted: result.accepted === true,
    cookieCount: result.cookie_count,
    downstreamStatus: result.downstream_http_status,
  };
}
```

The code string contains no credential values. Cookies move browser-to-consumer and never appear in the tool result or model context.

### 4. Validate before real work

Require a read-only identity/status/data request against the exact downstream path. Verify expected origin, response shape, account/tenant when available, and adequate expiry. Classify `401/403`, redirects, login content under `200`, business redirect codes, CSRF failure, and token/device binding separately. Do not broaden scope or retry credentials repeatedly without evidence.

### 5. Clean up

Stop the owned browser instance and receiver, close child processes, remove temporary files and Playwright artifacts that may contain authenticated pages, and verify listener ports are closed. If credentials reached output, arguments, traces, HAR, screenshots, source control, or an unauthorized process, treat them as compromised and revoke/rotate them.

## Common Mistakes

| Mistake | Correct action |
|---|---|
| Always creating an isolated profile | Reuse an approved persistent session; isolate only when required |
| Returning cookies from browser code | POST them directly to the one-shot consumer |
| Trusting HTTP `200` | Check final origin, content type, body shape, and business status |
| Exporting all cookies/storage | Declare exact origins and allowlisted names/keys |
| Writing a cookie jar by default | Prefer browser execution or loopback memory transfer |
| Using network dumps/HAR during login | Disable credential-bearing evidence collection |
| Leaving browser/receiver running | Stop exact instances and verify cleanup |

## Completion Evidence

Report only: authentication mode, allowlisted origins, credential counts/types, downstream status, validation result, cleanup result, and residual risks. Never report credential values, full headers, storage contents, or signed URLs.
