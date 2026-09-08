import { installSessionOwnerExtension, type ExtensionAPI } from "../../src/session-owner/extension.ts";

export default function sessionOwnerExtension(pi: ExtensionAPI): void {
  installSessionOwnerExtension(pi);
}
