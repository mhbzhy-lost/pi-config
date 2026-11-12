import { installSessionOwnerExtension, type ExtensionAPI } from "./extension.ts";

export default function sessionOwnerExtension(pi: ExtensionAPI): void {
  installSessionOwnerExtension(pi);
}
