import { join } from "node:path";
import { createOpenAIProxyExtension, loadOpenAIProxyConfig } from "./index.ts";

export default async function openAIProxyExtension(pi: any) {
  const configPath = join(import.meta.dirname, "..", "..", "pi", "openai-proxy.json");
  const config = loadOpenAIProxyConfig(configPath, { onError: (message) => console.warn(`[pi extension] ${message}`) });
  await createOpenAIProxyExtension(pi, config);
}
