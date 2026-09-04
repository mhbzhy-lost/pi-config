import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSecurityGatesExtension } from "../../src/security-gates/extension.ts";

export default function securityGates(pi: ExtensionAPI) {
  createSecurityGatesExtension(pi);
}
