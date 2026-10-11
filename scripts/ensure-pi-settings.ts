#!/usr/bin/env node
import { ensureSettings } from "../src/pi-settings/index.ts";

export type { EnsureOptions } from "../src/pi-settings/index.ts";
export { ensureSettings } from "../src/pi-settings/index.ts";

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const check = process.argv.includes("--check");
  ensureSettings({ check }).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
