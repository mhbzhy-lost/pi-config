import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { readFleetTranscript, renderFleetTranscript } from "../compat/pi-subagents-0.71.ts";

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
  // Display trust roots are local projection policy; artifact authority remains
  // with the root broker/workspace service (contract §2.6, §2.7).
  const roots = [path.resolve(options.asyncDir), path.resolve(options.runCwd), path.resolve(options.parentCwd)];
  if (options.artifactDirPreference === "session" && options.parentSessionFile) roots.push(path.dirname(path.resolve(options.parentSessionFile)));
  if (options.artifactDirPreference === "temp") roots.push(path.resolve(process.env.TMPDIR ?? "/tmp"));
  return [...new Set(roots)];
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
