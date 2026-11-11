import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent,
  CustomMessageComponent, CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
  buildContextEntries, parseSessionEntries, sessionEntryToContextMessages, getMarkdownTheme,
  createBashToolDefinition, createReadToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

// Reuse the same public message/tool components as Pi's main conversation.
// The session path comes only from the selected run's successful status RPC.
export class NativeConversation {
  private fingerprint = "";
  private content = new Container();
  private readonly tui: TUI;
  private cwd = "";
  private model = "no-model";
  private thinking = "off";

  constructor(tui: TUI) { this.tui = tui; }

  async refresh(sessionFile: string): Promise<void> {
    const file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("子会话文件不可读或超过 64 MiB");
      const fingerprint = `${sessionFile}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (fingerprint === this.fingerprint) return;
      // Read a fixed-size, read-only snapshot; never open a writable SessionManager.
      const buffer = Buffer.alloc(stat.size);
      let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
        if (!bytesRead) throw new Error("读取过程中子会话文件发生变化");
        position += bytesRead;
      }
      const entries = parseSessionEntries(buffer.toString("utf8"));
      const header = entries.find(entry => entry.type === "session");
      if (!header || header.type !== "session") throw new Error("缺少子会话 header");
      this.cwd = header.cwd;
      const messages = buildContextEntries(entries.filter((entry): entry is SessionEntry => entry.type !== "session"))
        .flatMap(sessionEntryToContextMessages);
      const assistant = messages.find(message => message.role === "assistant");
      if (assistant?.role === "assistant") {
        this.model = `${assistant.provider}/${assistant.model}`;
        this.thinking = assistant.thinkingLevel ?? "off";
      }
      const container = new Container();
      const pending = new Map<string, ToolExecutionComponent>();
      const theme = getMarkdownTheme();
      const tools = new Map([
        createBashToolDefinition(header.cwd), createReadToolDefinition(header.cwd), createEditToolDefinition(header.cwd),
        createWriteToolDefinition(header.cwd), createGrepToolDefinition(header.cwd), createFindToolDefinition(header.cwd), createLsToolDefinition(header.cwd),
      ].map(tool => [tool.name, tool]));
      for (const message of messages) {
        if (message.role === "user") {
          const text = typeof message.content === "string" ? message.content
            : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
          container.addChild(new UserMessageComponent(text, theme));
        } else if (message.role === "assistant") {
          container.addChild(new AssistantMessageComponent(message, true, theme));
          for (const part of message.content) {
            if (part.type !== "toolCall") continue;
            const tool = new ToolExecutionComponent(part.name, part.id, part.arguments,
              { showImages: false }, tools.get(part.name), this.tui, header.cwd);
            tool.markExecutionStarted();
            tool.setArgsComplete();
            container.addChild(tool);
            pending.set(part.id, tool);
          }
        } else if (message.role === "toolResult") {
          pending.get(message.toolCallId)?.updateResult(message);
          pending.delete(message.toolCallId);
        } else if (message.role === "custom" && message.display) {
          container.addChild(new CustomMessageComponent(message, undefined, theme));
        } else if (message.role === "compactionSummary") {
          container.addChild(new CompactionSummaryMessageComponent(message, theme));
        } else if (message.role === "branchSummary") {
          container.addChild(new BranchSummaryMessageComponent(message, theme));
        }
      }
      this.content = container;
      this.fingerprint = fingerprint;
    } finally { await file.close(); }
  }

  render(width: number): string[] { return this.content.render(width); }
  getCwd(): string { return this.cwd; }
  getModel(): string { return this.model; }
  getThinking(): string { return this.thinking; }
  invalidate(): void { this.content.invalidate(); this.fingerprint = ""; }
}
