import { readFileSync } from "node:fs";

export const guidance = readFileSync(new URL("./docs/guide.md", import.meta.url), "utf8").trim();
