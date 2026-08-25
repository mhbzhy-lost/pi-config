import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiCodingAgentRoot } from "./pi-runtime.mjs";

export function resolvePiHostPaths(options = {}) {
  const piHostRoot = resolvePiCodingAgentRoot(options);
  const piHostAliases = Object.freeze({
    "@earendil-works/pi-ai/compat": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-tui": join(piHostRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    "@earendil-works/pi-coding-agent": join(piHostRoot, "dist/index.js"),
    "@earendil-works/pi-ai": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    "@earendil-works/pi-agent-core": join(piHostRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
  });
  return {
    piHostRoot,
    piHostJitiUrl: pathToFileURL(join(piHostRoot, "node_modules/jiti/lib/jiti.mjs")).href,
    piHostModuleUrl: pathToFileURL(join(piHostRoot, "dist/index.js")).href,
    piHostAliases,
  };
}

const defaultPiHostPaths = resolvePiHostPaths();
export const { piHostRoot, piHostJitiUrl, piHostModuleUrl, piHostAliases } = defaultPiHostPaths;
