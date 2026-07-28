import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { getArtifactsDir } from "../../npm/node_modules/pi-subagents/src/shared/artifacts.ts";
import { readFleetTranscript, renderFleetTranscript } from "../../npm/node_modules/pi-subagents/src/tui/fleet-transcript.ts";

const MAX_STATUS_BYTES = 2 * 1024 * 1024;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBrowserRunStatus(asyncDir: string): unknown | undefined {
  const statusPath = path.join(asyncDir, "status.json");
  let fd: number | undefined;
  try {
    const pathStat = fs.lstatSync(statusPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return undefined;

    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(statusPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size > MAX_STATUS_BYTES) return undefined;

    const buffer = Buffer.allocUnsafe(stat.size + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const status: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    return isRecord(status) ? status : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function browserTrustedRoots(options: {
  asyncDir: string;
  runCwd: string;
  parentCwd: string;
  parentSessionFile: string | null;
  artifactDirPreference: "project" | "session" | "temp";
}): string[] {
  return [...new Set([
    path.resolve(options.asyncDir),
    path.resolve(getArtifactsDir(options.parentSessionFile, options.runCwd, options.artifactDirPreference)),
    path.resolve(getArtifactsDir(options.parentSessionFile, options.parentCwd, options.artifactDirPreference)),
  ])];
}

export function renderBrowserTranscript(options: {
  transcriptPath: string;
  trustedRoots: string[];
  width: number;
  theme: ExtensionContext["ui"]["theme"];
  markdownTheme: MarkdownTheme;
  expandedTools?: boolean;
}): { lines: string[]; warning?: string } {
  const transcript = readFleetTranscript(options.transcriptPath, { trustedRoots: options.trustedRoots });
  return {
    lines: renderFleetTranscript(transcript, options.width, options.theme, options.markdownTheme, {
      expandedTools: options.expandedTools,
    }),
    ...(transcript.warning ? { warning: transcript.warning } : {}),
  };
}
