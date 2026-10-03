#!/usr/bin/env node
// 集成测试门禁 runner：自动枚举 test/*.integration.mjs，减去下方显式排除表后
// 运行 node --test。设计动机（docs/upgrades 2026-09-30 悬空审计，var/upgrade/orphaned-integration-audit.md）：
// *.integration.mjs 不在 npm test 的 test/**/*.test.mjs glob 内（用户原则：长耗时操作
// 属集成测试，不进主 glob），未被任何 script 显式点名的文件等于悬空——曾经导致
// model-selection 等文件基线带红数日无人发现。本 runner 让新集成文件自动纳入门禁，
// 排除项必须显式登记并带原因（PENDING-DIAGNOSIS / PENDING-ADJUDICATION 等）。
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");

// 显式排除表：每项必须带登记原因；解除排除时删除条目即可。
const EXCLUDED_INTEGRATION_FILES = new Map([
]);

/** 纯选择逻辑：integration 文件全集 − 显式排除表，排序输出（供单测消费）。 */
export function selectIntegrationFiles(allFiles, excluded) {
  const excludeSet = new Set(excluded.keys());
  return allFiles
    .filter((name) => name.endsWith(".integration.mjs") && !excludeSet.has(name))
    .sort();
}

async function main() {
  const names = await readdir(testDir);
  const selected = selectIntegrationFiles(names, EXCLUDED_INTEGRATION_FILES);

  if (EXCLUDED_INTEGRATION_FILES.size > 0) {
    console.log(`[integration-gate] excluded (${EXCLUDED_INTEGRATION_FILES.size}):`);
    for (const [name, reason] of EXCLUDED_INTEGRATION_FILES) {
      console.log(`  - ${name}\n    ${reason}`);
    }
  }
  console.log(`[integration-gate] running ${selected.length} integration files...`);

  const files = selected.map((name) => join("test", name));
  // 串行执行：集成测试共享真实资源（git 仓库、broker authority、/tmp 固定目录），
  // 并发跑会制造跨文件竞争（首跑实证：grants ENOENT 竞争）。
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" },
  });
  child.on("close", (code) => process.exit(code ?? 1));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`.replace(/\/([A-Z]:)/, "$1")) {
  await main();
}
