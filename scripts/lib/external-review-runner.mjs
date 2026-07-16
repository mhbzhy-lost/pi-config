import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

function redact(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:x-api-key|api[_-]?key|token|secret|authorization)\s*[:=]\s*["']?)([^\s,"'};]+)/gi, "$1[redacted]")
    .replace(/("(?:x-api-key|api[_-]?key|token|secret|authorization)"\s*:\s*")[^"]*/gi, '$1[redacted]');
}

function boundedBuffer(limit) {
  let value = "";
  return {
    append(chunk) {
      if (Buffer.byteLength(value) >= limit) return;
      const remaining = limit - Buffer.byteLength(value);
      value += Buffer.from(chunk).subarray(0, remaining).toString();
    },
    value() {
      return redact(value);
    },
  };
}

async function writeLog(logPath, text) {
  if (!logPath) return;
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${redact(text)}\n`);
}

export async function runExternalReview({
  hookPath,
  command,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  logPath,
  env = process.env,
}) {
  const stdout = boundedBuffer(maxBufferBytes);
  const stderr = boundedBuffer(maxBufferBytes);
  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      const child = spawn("bash", [hookPath], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        finish({ timedOut, code: null });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => stdout.append(chunk));
      child.stderr.on("data", (chunk) => stderr.append(chunk));
      child.on("error", (error) => finish({ timedOut, code: null, error }));
      child.on("close", (code) => finish({ timedOut, code }));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
    });
    const message = stderr.value();
    await writeLog(logPath, `[external-review-gate] code=${result.code} timedOut=${result.timedOut} error=${result.error ? redact(String(result.error)) : ""} stderr=${message}`);
    if (result.timedOut) return { block: false, available: false, findings: [], reason: "external review timeout; fail-open", stderr: message, timedOut: true };
    if (result.code !== 0) return { block: false, available: false, findings: [], reason: "external review failed; fail-open", stderr: message, timedOut: false };
    let payload;
    try {
      payload = JSON.parse(stdout.value());
    } catch {
      return { block: false, available: false, findings: [], reason: "external review produced no decision; fail-open", stderr: message, timedOut: false };
    }
    const decision = payload.hookSpecificOutput;
    if (decision?.permissionDecision === "deny") {
      const reason = redact(decision.permissionDecisionReason || "external review denied push");
      return { block: true, available: true, findings: [{ severity: "Critical", message: reason }], reason, stderr: message, timedOut: false };
    }
    return { block: false, available: true, findings: [], reason: "external review allowed", stderr: message, timedOut: false };
  } catch (error) {
    const message = redact(String(error));
    await writeLog(logPath, `[external-review-gate] spawn error=${message}`);
    return { block: false, available: false, findings: [], reason: "external review unavailable; fail-open", stderr: message, timedOut: false };
  }
}
