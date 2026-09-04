import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBasicMemoryExtension } from "../../src/basic-memory/extension.ts";

export default function basicMemory(pi: ExtensionAPI) {
  createBasicMemoryExtension(pi);
}
