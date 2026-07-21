import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBasicMemoryExtension } from "../../scripts/lib/basic-memory-extension.mjs";

export default function basicMemory(pi: ExtensionAPI) {
  createBasicMemoryExtension(pi);
}
