import { openSync, closeSync, writeFileSync } from "node:fs";

const marker = process.argv[2];
if (!marker) throw Error("marker is required");
const fd = openSync(marker, "wx", 0o600);
try { writeFileSync(fd, "started"); } finally { closeSync(fd); }
