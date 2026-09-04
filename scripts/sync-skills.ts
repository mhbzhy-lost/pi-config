#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, symlink, unlink, lstat, readlink } from "node:fs/promises";
import { discoverManagedSkills } from "../src/skill-whitelist/skill.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = join(homedir(), ".agents", "skills");

async function main() {
  await mkdir(targetDir, { recursive: true });
  const desired = await discoverManagedSkills(repoRoot);
  let created = 0;
  let unchanged = 0;
  let updated = 0;

  for (const [name, sourcePath] of desired) {
    const linkPath = join(targetDir, name);
    let existing;
    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) {
        console.warn(`skip: ${linkPath} exists and is not a symlink`);
        continue;
      }
      existing = await readlink(linkPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (existing === sourcePath) {
      unchanged++;
      continue;
    }
    if (existing !== undefined) {
      await unlink(linkPath);
      updated++;
    } else {
      created++;
    }
    await symlink(sourcePath, linkPath);
  }

  // Report stale symlinks that point into this repository but have no discovered source.
  const desiredNames = new Set(desired.keys());
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (desiredNames.has(entry.name)) continue;
      const entryPath = join(targetDir, entry.name);
      const stats = await lstat(entryPath);
      if (!stats.isSymbolicLink()) continue;
      const target = await readlink(entryPath);
      if (target.startsWith(repoRoot + "/")) {
        console.warn(`stale: ${entry.name} → ${target} (source no longer exists)`);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
      console.warn(`warning: stale-link scan failed: ${error.message}`);
    }
  }

  console.log(`sync complete: ${created} created, ${updated} updated, ${unchanged} unchanged`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
