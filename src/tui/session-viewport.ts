import { CustomEditor } from "@earendil-works/pi-coding-agent";

export class ReadOnlyBrowserEditor extends CustomEditor {
  override render(_width: number): string[] { return []; }
  override handleInput(_data: string): void {}
}
