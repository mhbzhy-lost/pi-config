#!/usr/bin/env node
import { ensureSettings, ensureGitCleanFilter } from "../src/pi-settings/index.ts";

export type { EnsureOptions } from "../src/pi-settings/index.ts";
export { ensureSettings } from "../src/pi-settings/index.ts";

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const check = process.argv.includes("--check");
  // 规整共享 settings 时一并幂等配置 git clean filter，阻止运行时字段进入提交。
  if (!check) ensureGitCleanFilter();
  ensureSettings({ check }).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
