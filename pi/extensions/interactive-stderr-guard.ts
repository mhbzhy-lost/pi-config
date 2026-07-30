import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createRotatingStderrSink,
  installInteractiveStderrGuard,
} from "./lib/interactive-stderr-guard.ts";

interface GuardDependencies {
  resolveLogPath(): string;
  createSink(options: { logPath: string }): (chunk: Buffer) => void;
  install(options: { writeLog(chunk: Buffer): void }): () => void;
  scheduleRelease(release: () => void): void;
}

export function resolveInteractiveStderrLogPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configuredDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredDir || join(home, ".pi", "agent");
  return join(agentDir, "logs", "interactive-stderr.log");
}

const defaultDependencies: GuardDependencies = {
  resolveLogPath: () => resolveInteractiveStderrLogPath(),
  createSink: (options) => createRotatingStderrSink(options),
  install: (options) => installInteractiveStderrGuard(options),
  scheduleRelease(release) {
    const timer = setTimeout(release, 1000);
    timer.unref?.();
  },
};

export function registerInteractiveStderrGuard(
  pi: ExtensionAPI,
  dependencies: GuardDependencies = defaultDependencies,
): void {
  let release: (() => void) | undefined;

  const releaseCurrent = () => {
    release?.();
    release = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    releaseCurrent();
    if (ctx.mode !== "tui") return;

    const writeLog = dependencies.createSink({ logPath: dependencies.resolveLogPath() });
    release = dependencies.install({ writeLog });
  });

  pi.on("session_shutdown", () => {
    const staleRelease = release;
    release = undefined;
    if (staleRelease) dependencies.scheduleRelease(staleRelease);
  });
}

export default registerInteractiveStderrGuard;
