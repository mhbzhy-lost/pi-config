import { randomUUID } from "node:crypto";
import { chmodSync, constants, lstatSync, openSync, closeSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeCwd, classifyPiLaunch, loadPublicSessionManager, resolveLaunchTarget } from "../src/session-owner/contract.ts";
import { createRegistryStore, prepareLaunch } from "../src/session-owner/registry.ts";

type Decision = "blocked" | "pass" | "pin-session" | "bypass";

function privateFile(directory: string, name: string, value: string | Buffer): void {
  const path = resolve(directory, name);
  const fd = openSync(path, (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)), 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function decisionDirectory(path: string): string {
  const directory = resolve(path);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("decision directory must be a 0700 directory");
  return directory;
}

function argumentValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

async function prepare(options: { pid: number; cwd: string; stdinTty: boolean; stdoutTty: boolean; decisionDir: string; piBinary: string; argv: string[] }): Promise<void> {
  const directory = decisionDirectory(options.decisionDir);
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1") {
    privateFile(directory, "action", "bypass\n");
    return;
  }
  const ownerId = randomUUID();
  let action: Decision = "blocked";
  let sessionPath: string | null = null;
  let continueArgIndex = -1;
  try {
    const intent = classifyPiLaunch(options.argv, { stdinTty: options.stdinTty, stdoutTty: options.stdoutTty });
    continueArgIndex = intent.continueArgIndex ?? -1;
    const cwd = canonicalizeCwd(options.cwd);
    if (!isAbsolute(options.piBinary)) throw new Error("Pi binary must be an absolute path");
    if (intent.kind === "resume" && (!options.stdinTty || !options.stdoutTty)) throw new Error("resume picker requires a TTY");
    if (intent.kind === "ephemeral" || intent.kind === "non-interactive") action = "bypass";
    else {
      const result = await prepareLaunch({
        store: createRegistryStore(process.env.PI_SESSION_OWNER_REGISTRY), pid: options.pid, ownerId,
        startedAt: new Date().toISOString(), resolveReservation: async () => {
          const requiresDiscovery = intent.kind === "session-id" || intent.kind === "fork";
          const manager = requiresDiscovery ? await loadPublicSessionManager({ piBinary: options.piBinary }) : undefined;
          if (requiresDiscovery && !manager) throw new Error("official Pi package is unavailable");
          const target = await resolveLaunchTarget({ argv: options.argv, cwd, intent, sessionManager: manager });
          if (target.kind === "unavailable") throw new Error("target discovery is unavailable");
          if (target.kind === "absent") return { kind: "new", rejectSelecting: true };
          if (intent.kind === "continue" && target.reservation.kind === "session") sessionPath = target.reservation.sessionFile;
          return target.reservation;
        },
      });
      if (result.decision === "allow") action = intent.kind === "continue" && sessionPath !== null ? "pin-session" : "pass";
    }
  } catch {
    action = "blocked";
  }
  privateFile(directory, "action", `${action}\n`);
  if (action !== "bypass") {
    privateFile(directory, "owner-id", `${ownerId}\n`);
    privateFile(directory, "continue-arg-index", `${continueArgIndex}\n`);
    if (action === "pin-session" && sessionPath !== null) privateFile(directory, "session-path", Buffer.concat([Buffer.from(sessionPath), Buffer.from([0])]));
  }
}

function usage(): never { throw new Error("expected prepare --pid PID --cwd CWD --stdin-tty 0|1 --stdout-tty 0|1 --decision-dir DIR -- PI_ARGS"); }

const values = process.argv.slice(2);
if (values.shift() !== "prepare") usage();
const separator = values.indexOf("--");
if (separator < 0) usage();
const flags = values.slice(0, separator);
const argv = values.slice(separator + 1);
const pid = Number(argumentValue(flags, "--pid"));
const cwd = argumentValue(flags, "--cwd");
const stdinTty = argumentValue(flags, "--stdin-tty");
const stdoutTty = argumentValue(flags, "--stdout-tty");
const decisionDir = argumentValue(flags, "--decision-dir");
const piBinary = argumentValue(flags, "--pi-binary") ?? process.env.PI_REAL_BIN ?? "";
if (!Number.isSafeInteger(pid) || pid < 1 || cwd === null || decisionDir === null || !["0", "1"].includes(stdinTty ?? "") || !["0", "1"].includes(stdoutTty ?? "")) usage();
await prepare({ pid, cwd, stdinTty: stdinTty === "1", stdoutTty: stdoutTty === "1", decisionDir, piBinary, argv });
