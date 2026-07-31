import { execFile } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const START_TIME_TOLERANCE_MS = 5_000;

async function groupAlive(pgid) {
  const { stdout } = await run("ps", ["-axo", "pgid="]);
  return stdout.split("\n").some((line) => Number(line.trim()) === pgid);
}

function signalGroup(pgid, name) {
  try {
    process.kill(-pgid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function recordedProcess(pid) {
  let stdout;
  try {
    ({ stdout } = await run("ps", ["-ww", "-p", String(pid), "-o", "pid=,pgid=,lstart=,command="], {
      env: { ...process.env, LC_ALL: "C" },
    }));
  } catch (error) {
    if (error?.code === 1 && String(error?.stdout ?? "").trim() === "") return undefined;
    throw error;
  }
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    startedAt: Date.parse(match[3]),
    command: match[4],
  };
}

async function waitForGroupExit(pgid, timeoutMs, isGroupAlive = groupAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isGroupAlive(pgid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !(await isGroupAlive(pgid));
}

function matchesRunIdentity(process, status, handle, expectedCommandPath) {
  const expectedStartedAt = new Date(status.startedAt).getTime();
  return process &&
    process.pid === status.pid &&
    process.pgid === status.pid &&
    Number.isFinite(process.startedAt) &&
    Number.isFinite(expectedStartedAt) &&
    Math.abs(process.startedAt - expectedStartedAt) <= START_TIME_TOLERANCE_MS &&
    process.command.includes(expectedCommandPath) &&
    process.command.includes(handle.runId);
}

export async function processesReferencing(...paths) {
  const { stdout } = await run("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !paths.some((path) => match[2].includes(path))) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

export async function terminateDetachedRun(handle, {
  expectedCommandPath,
  timeoutMs = 2_000,
  inspectProcess = recordedProcess,
  isGroupAlive = groupAlive,
  signalProcessGroup = signalGroup,
} = {}) {
  if (!handle?.runId || !handle?.asyncDir) return;
  let status;
  try {
    status = JSON.parse(await readFile(join(handle.asyncDir, "status.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (status.runId !== handle.runId || !Number.isInteger(status.pid) || status.pid <= 1 || !expectedCommandPath || !status.startedAt) {
    throw new Error("Detached Plan run identity is incomplete or does not match its handle");
  }

  const process = await inspectProcess(status.pid);
  if (!process) return;
  if (!matchesRunIdentity(process, status, handle, expectedCommandPath)) {
    throw new Error("Detached Plan run process identity does not match status or runtime");
  }

  signalProcessGroup(process.pgid, "SIGTERM");
  if (await waitForGroupExit(process.pgid, timeoutMs, isGroupAlive)) return;
  const leaderAfterTerm = await inspectProcess(status.pid);
  if (!leaderAfterTerm) {
    throw new Error("Detached Plan run leader is unavailable before SIGKILL");
  }
  if (!matchesRunIdentity(leaderAfterTerm, status, handle, expectedCommandPath)) {
    throw new Error("Detached Plan run process identity changed before SIGKILL");
  }
  signalProcessGroup(process.pgid, "SIGKILL");
  if (!(await waitForGroupExit(process.pgid, timeoutMs, isGroupAlive))) {
    throw new Error(`Detached Plan process group did not exit: ${process.pgid}`);
  }
}

export async function terminateDetachedRunsUnder(root, { timeoutMs = 2_000 } = {}) {
  const handles = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.name === "async-subagent-runs") {
        let runs;
        try {
          runs = await readdir(child, { withFileTypes: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          continue;
        }
        for (const run of runs) {
          if (!run.isDirectory() || run.isSymbolicLink()) continue;
          handles.push({ runId: run.name, asyncDir: join(child, run.name) });
        }
      } else {
        await visit(child);
      }
    }
  };

  await visit(root);
  const errors = [];
  for (const handle of handles) {
    try {
      await terminateDetachedRun(handle, { expectedCommandPath: root, timeoutMs });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Detached Plan run identity cleanup failed");
}

export async function finalizeHarnessCleanup({ fixture, passed, preserve, primaryError, cleanupErrors = [], removeFixture, diagnostic }) {
  const errors = [...cleanupErrors];
  if (passed && !preserve && errors.length === 0) {
    try {
      await removeFixture();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!passed || preserve || errors.length > 0) {
    diagnostic?.(`preserved=${errors.find((error) => error?.preservedFixture)?.preservedFixture ?? fixture}`);
  }
  if (errors.length) {
    throw new AggregateError(primaryError ? [primaryError, ...errors] : errors, "Harness cleanup failed");
  }
}

export async function removeFixtureWithEvidence(fixture, { removeFixture, archivePath = `${fixture}.cleanup-evidence.tar` } = {}) {
  await run("tar", ["-cf", archivePath, "-C", dirname(fixture), basename(fixture)]);
  try {
    await removeFixture();
  } catch (error) {
    error.preservedFixture = archivePath;
    throw error;
  }
  try {
    await unlink(archivePath);
  } catch (error) {
    error.preservedFixture = archivePath;
    throw error;
  }
}
