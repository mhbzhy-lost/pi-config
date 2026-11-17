#!/usr/bin/env node
/**
 * pi-relay 新主机交互式接入薄 CLI：实现见 src/pi-relay/join.ts。
 * 用法：在要接入的 Mac 上运行 node scripts/pi-relay-join.ts（需交互式终端）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJoin } from "../src/pi-relay/join.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await runJoin(root);