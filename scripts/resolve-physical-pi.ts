#!/usr/bin/env node
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const root = realpathSync(process.env.PI_HOST_ROOT ?? resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.5.2") {
  throw new Error("physical Pi Host identity or version mismatch");
}
const entry = realpathSync(join(root, "dist/cli.js"));
accessSync(entry, constants.R_OK);
process.stdout.write(`${entry}\n`);
