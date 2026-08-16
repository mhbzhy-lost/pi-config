import { existsSync, openSync, closeSync, writeFileSync } from "node:fs";

const [marker, started, finish] = process.argv.slice(2);
if (!marker || !started || !finish) throw Error("marker, started and finish paths are required");
const fd = openSync(marker, "wx", 0o600);
try { writeFileSync(fd, "started"); } finally { closeSync(fd); }
const startedFd = openSync(started, "wx", 0o600);
try { writeFileSync(startedFd, "started"); } finally { closeSync(startedFd); }
const deadline = Date.now() + 30_000;
while (!existsSync(finish)) {
  if (Date.now() >= deadline) process.exit(124);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
