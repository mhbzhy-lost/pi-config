import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

type ExecFile = (file: string, args: string[]) => Promise<{ stdout: Buffer | string }>;

const execFileWithBuffer = promisify(execFileCallback);

async function defaultExecFile(file: string, args: string[]) {
  return execFileWithBuffer(file, args, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
  });
}

function unavailableError(cause?: unknown) {
  const error = new Error("Process birth identity is unavailable");
  error.code = "PROCESS_BIRTH_IDENTITY_UNAVAILABLE";
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function assertProcessBirthOutput(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  const english = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\S[^\r\n]*(?:\r?\n)?$/;
  const localized = /^\S+\s+\S+\/\s*\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\S[^\r\n]*(?:\r?\n)?$/;
  if (!english.test(text) && !localized.test(text)) {
    const error = new Error("Process birth identity ps output is malformed");
    error.code = "PROCESS_BIRTH_IDENTITY_OUTPUT_INVALID";
    throw error;
  }
}

export async function captureProcessBirthIdentity(
  pid: number,
  { execFile = defaultExecFile }: { execFile?: ExecFile } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    const error = new Error("Process birth identity PID must be a positive safe integer");
    error.code = "PROCESS_BIRTH_IDENTITY_INVALID";
    throw error;
  }

  let stdout: Buffer | string;
  try {
    ({ stdout } = await execFile("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="]));
  } catch (cause) {
    throw unavailableError(cause);
  }

  const bytes = Buffer.isBuffer(stdout)
    ? stdout
    : typeof stdout === "string"
      ? Buffer.from(stdout, "utf8")
      : undefined;
  if (!bytes || bytes.length === 0 || bytes.toString("utf8").trim().length === 0) {
    throw unavailableError();
  }
  assertProcessBirthOutput(bytes);

  return createHash("sha256").update(bytes).digest("hex");
}

export async function processBirthIdentityMatches(pid: number, birthIdentity: string, options: { execFile?: ExecFile } = {}) {
  if (typeof birthIdentity !== "string" || !/^[a-f0-9]{64}$/.test(birthIdentity)) return false;
  try { return (await captureProcessBirthIdentity(pid, options)) === birthIdentity; } catch { return false; }
}
