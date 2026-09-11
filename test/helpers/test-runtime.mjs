import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Allocate one isolated root for a test and remove it on every test outcome. */
export async function createTestRuntime(t, prefix = "pi-test-runtime-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = (name) => join(root, name);
  return {
    root,
    path,
    agentDir: path("agent"),
    sessionDir: path("sessions"),
    registryDir: path("registry"),
    workspaceDir: path("workspaces"),
    goalDir: path("goals"),
    cwd: path("cwd"),
    env(extra = {}) {
      return {
        ...extra,
        PI_CODING_AGENT_DIR: path("agent"),
        PI_CODING_AGENT_SESSION_DIR: path("sessions"),
        PI_SESSION_OWNER_REGISTRY: path("registry"),
        PI_CODING_WORKSPACE_DIR: path("workspaces"),
        PI_CODING_GOAL_DIR: path("goals"),
      };
    },
  };
}
