import { createRootBrokerClient } from "../../scripts/lib/subagent-dispatch/root-broker-client.ts";

const RETRY_DEADLINE_MS = 5_000;
const RETRY_DELAY_MS = 25;

type Options = {
  env?: NodeJS.ProcessEnv;
  createClient?: typeof createRootBrokerClient;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  pid?: number;
};

export default function rootSessionOwner(pi: any) {
  pi.on("session_start", async () => installRootSessionOwner(pi));
}

export async function installRootSessionOwner(pi: any, options: Options = {}) {
  const env = options.env ?? process.env;
  const rootSessionId = env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const callerRunId = env.PI_SUBAGENT_RUN_ID;
  if (!rootSessionId || !callerRunId) throw new Error("Root ownership requires PI_SUBAGENT_RUN_ID and PI_SUBAGENT_ORCHESTRATOR_SESSION_ID");
  const createClient = options.createClient ?? createRootBrokerClient;
  const client = createClient({ rootSessionId, callerRunId });
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const kill = options.kill ?? process.kill;
  const pid = options.pid ?? process.pid;
  const deadline = clock() + RETRY_DEADLINE_MS;
  let subscription: any;
  let terminating = false;

  const terminate = async () => {
    if (terminating) return;
    terminating = true;
    await Promise.resolve(pi.sendMessage?.({
      customType: "pi-root-session-closing-v1",
      content: "Root session closed; this child must terminate.",
      details: { rootSessionId, runId: callerRunId },
    })).catch(() => {});
    kill(pid, "SIGTERM");
  };

  for (;;) {
    try {
      subscription = await client.subscribe((push: any) => { if (push.type === "root.closing") void terminate(); });
      break;
    } catch (error: any) {
      if (error?.code !== "GRANT_NOT_READY" || clock() >= deadline) {
        client.dispose();
        throw error;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  subscription.closed.catch(() => { if (!terminating) void terminate(); });
  return Object.freeze({
    client,
    subscription,
    dispose() {
      subscription.dispose();
      client.dispose();
    },
  });
}
