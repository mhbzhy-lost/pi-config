import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();

export const piHostRoot = join(globalNodeModules, "@earendil-works/pi-coding-agent");
export const piHostJitiUrl = pathToFileURL(join(piHostRoot, "node_modules/jiti/lib/jiti.mjs")).href;
export const piHostModuleUrl = pathToFileURL(join(piHostRoot, "dist/index.js")).href;
export const piHostAliases = Object.freeze({
  "@earendil-works/pi-ai/compat": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  "@earendil-works/pi-tui": join(piHostRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  "@earendil-works/pi-coding-agent": join(piHostRoot, "dist/index.js"),
  "@earendil-works/pi-ai": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-agent-core": join(piHostRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
});
