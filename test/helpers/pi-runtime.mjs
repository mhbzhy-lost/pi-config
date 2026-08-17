import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const defaultGlobalRoot = () => execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();

export function resolvePiCodingAgentRoot({
  env = process.env,
  readGlobalNodeModules = defaultGlobalRoot,
} = {}) {
  const explicit = env.PI_TEST_CODING_AGENT_ROOT?.trim();
  if (explicit) return explicit;
  return join(readGlobalNodeModules(), "@earendil-works", "pi-coding-agent");
}

export async function loadPiTestRuntime(importMetaUrl, options = {}) {
  const root = resolvePiCodingAgentRoot(options);
  const paths = {
    codingAgent: join(root, "dist", "index.js"),
    piTui: join(root, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    piAi: join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    piAiCompat: join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
    piAgentCore: join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
    jiti: join(root, "node_modules", "jiti", "lib", "jiti.mjs"),
  };
  const { createJiti } = await import(pathToFileURL(paths.jiti).href);
  const jiti = createJiti(importMetaUrl, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": paths.codingAgent,
      "@earendil-works/pi-tui": paths.piTui,
      "@earendil-works/pi-ai": paths.piAi,
      "@earendil-works/pi-ai/compat": paths.piAiCompat,
      "@earendil-works/pi-agent-core": paths.piAgentCore,
    },
  });
  return {
    root,
    paths,
    jiti,
    codingAgent: await import(pathToFileURL(paths.codingAgent).href),
    piTui: await jiti.import("@earendil-works/pi-tui"),
  };
}
