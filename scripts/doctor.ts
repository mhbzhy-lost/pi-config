#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkSettings } from "../src/pi-settings/index.ts";

const root = resolve(import.meta.dirname, "..");
const issues: string[] = [];
try {
  const manifest = JSON.parse(await readFile(join(root, "node_modules/pi-subagents/package.json"), "utf8"));
  if (manifest.version !== "0.84.0") issues.push(`pi-subagents: expected 0.84.0, got ${manifest.version}`);
} catch (error) { issues.push(`pi-subagents: ${String(error)}`); }
for (const [name, expected] of [
  ["pi-agent-core", "1.5.0"], ["pi-ai", "1.5.0"],
  ["pi-coding-agent", "1.5.0"], ["pi-tui", "1.5.0"],
] as const) {
  try {
    const manifest = JSON.parse(await readFile(join(root, "node_modules/@earendil-works", name, "package.json"), "utf8"));
    if (manifest.version !== expected) issues.push(`${name}: expected ${expected}, got ${manifest.version}`);
  } catch (error) { issues.push(`${name}: ${String(error)}`); }
}
try {
  const settings = JSON.parse(await readFile(join(root, "pi/settings.json"), "utf8"));
  issues.push(...await checkSettings({ settings, target: join(root, "pi/settings.json") }));
} catch (error) { issues.push(`settings: ${String(error)}`); }
try { await access(join(root, "pi/npm/node_modules/typebox/package.json")); }
catch { issues.push("scheduler TypeBox dependency is missing"); }
if (issues.length) {
  for (const issue of issues) console.error(`[error] ${issue}`);
  process.exitCode = 1;
} else console.log("[ok] Pi configuration and dependencies");
