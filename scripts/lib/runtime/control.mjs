function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function stopAgent(pid, { graceMs = 5000 } = {}) {
  if (typeof pid !== "number" || pid <= 0) throw new Error("Invalid pid");

  if (!pidExists(pid)) return "already_dead";

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") return "already_dead";
    throw err;
  }

  // Wait for graceful exit
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return "stopped";
    await sleep(50);
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (err.code === "ESRCH") return "stopped";
    throw err;
  }

  return "killed";
}

export async function interruptAgent(pid) {
  if (typeof pid !== "number" || pid <= 0) throw new Error("Invalid pid");

  if (!pidExists(pid)) return;

  try {
    process.kill(pid, "SIGINT");
  } catch (err) {
    if (err.code === "ESRCH") return;
    throw err;
  }
}
