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

  return createHash("sha256").update(bytes).digest("hex");
}
