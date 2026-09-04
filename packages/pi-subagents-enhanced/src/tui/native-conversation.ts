import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  parseSkillBlock,
  SessionManager,
  sessionEntryToContextMessages,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type MarkdownTheme } from "@earendil-works/pi-tui";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

type RenderOptions = {
  sessionFile: string;
  trustedRoots: string[];
  width: number;
  cwd: string;
  markdownTheme: MarkdownTheme;
  ui: { requestRender(): void };
  expandedTools: boolean;
  hideThinking: boolean;
  outputPad: number;
};

export type NativeConversationResult = {
  lines: string[];
  fingerprint?: string;
  warning?: string;
};

type Dependencies = {
  openSession?: typeof SessionManager.open;
  onSnapshot?: () => void;
  afterOpen?: () => void;
  onToolResult?: (item: any) => void;
  resolveToolRenderer?: (name: string) => any;
};

type CheckedFile = {
  fd: number;
  realPath: string;
  fingerprint: string;
  size: number;
};

type CachedSession = {
  fingerprint: string;
  items: unknown[];
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function customEntryMessage(entry: any) {
  const content = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? "");
  return { role: "custom", customType: entry.customType, content, display: true, timestamp: entry.timestamp };
}

export class NativeChildConversationRenderer {
  private readonly openSession: typeof SessionManager.open;
  private readonly onSnapshot?: () => void;
  private readonly afterOpen?: () => void;
  private readonly onToolResult?: (item: any) => void;
  private readonly resolveToolRenderer?: (name: string) => any;
  private readonly sessions = new Map<string, CachedSession>();
  private readonly rendered = new Map<string, NativeConversationResult>();
  private readonly themeIds = new WeakMap<object, number>();
  private readonly renderVariants = new Map<string, string[]>();
  private nextThemeId = 1;

  constructor(dependencies: Dependencies = {}) {
    this.openSession = dependencies.openSession ?? SessionManager.open;
    this.onSnapshot = dependencies.onSnapshot;
    this.afterOpen = dependencies.afterOpen;
    this.onToolResult = dependencies.onToolResult;
    this.resolveToolRenderer = dependencies.resolveToolRenderer;
  }

  invalidate(): void {
    this.sessions.clear();
    this.rendered.clear();
    this.renderVariants.clear();
  }

  render(options: RenderOptions): NativeConversationResult {
    let checked: CheckedFile;
    try {
      checked = this.checkPath(options.sessionFile, options.trustedRoots);
    } catch (error) {
      return { lines: [], warning: error instanceof Error ? error.message : "Unable to read child session" };
    }

    try {
      const themeId = this.themeIdentity(options.markdownTheme);
      const key = [checked.realPath, checked.fingerprint, options.width, options.cwd, options.expandedTools, options.hideThinking, options.outputPad, themeId].join("\0");
      const cached = this.rendered.get(key);
      if (cached) return cached;

      let session = this.sessions.get(checked.realPath);
      if (!session || session.fingerprint !== checked.fingerprint) {
        for (const renderedKey of this.renderVariants.get(checked.realPath) ?? []) this.rendered.delete(renderedKey);
        this.renderVariants.delete(checked.realPath);
        const snapshot = this.materializeSnapshot(checked);
        try {
          const manager = this.openSession(snapshot);
          const items = manager.buildContextEntries().flatMap((entry: any) =>
            entry.type === "custom" ? [entry] : sessionEntryToContextMessages(entry),
          );
          session = { fingerprint: checked.fingerprint, items };
          this.sessions.set(checked.realPath, session);
        } finally {
          fs.rmSync(path.dirname(snapshot), { recursive: true, force: true });
        }
      }
      const result = { lines: this.renderItems(session.items, options), fingerprint: checked.fingerprint };
      this.rendered.set(key, result);
      const variants = this.renderVariants.get(checked.realPath) ?? [];
      variants.push(key);
      while (variants.length > 16) this.rendered.delete(variants.shift()!);
      this.renderVariants.set(checked.realPath, variants);
      return result;
    } catch {
      return { lines: [], warning: "Unable to load child session" };
    } finally {
      fs.closeSync(checked.fd);
    }
  }

  private checkPath(sessionFile: string, trustedRoots: string[]): CheckedFile {
    const fd = fs.openSync(sessionFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      this.afterOpen?.();
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("Child session must be a regular file");
      if (stat.size > MAX_SESSION_BYTES) throw new Error("Child session exceeds 64 MiB limit");
      const realPath = fs.realpathSync(sessionFile);
      const pathStat = fs.lstatSync(realPath);
      if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) throw new Error("Child session changed while opening");
      const realRoots = trustedRoots.flatMap((root) => {
        try { return [fs.realpathSync(root)]; } catch { return []; }
      });
      if (!realRoots.some((root) => isInside(root, realPath))) throw new Error("Child session is outside trusted roots");
      return { fd, realPath, fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, size: stat.size };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private materializeSnapshot(checked: CheckedFile): string {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), "native-child-session-"));
    try {
      const snapshot = path.join(directory, "session.jsonl");
      const output = fs.openSync(snapshot, "wx", 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < checked.size) {
          const read = fs.readSync(checked.fd, buffer, 0, Math.min(buffer.length, checked.size - position), position);
          if (read === 0) throw new Error("Child session changed while reading");
          fs.writeSync(output, buffer, 0, read);
          position += read;
        }
      } finally { fs.closeSync(output); }
      this.onSnapshot?.();
      return snapshot;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private themeIdentity(theme: MarkdownTheme): string {
    if (typeof theme === "object" && theme !== null) {
      let id = this.themeIds.get(theme);
      if (!id) { id = this.nextThemeId++; this.themeIds.set(theme, id); }
      return String(id);
    }
    return String(theme);
  }

  private renderItems(items: unknown[], options: RenderOptions): string[] {
    const container = new Container();
    const pendingTools = new Map<string, InstanceType<typeof ToolExecutionComponent>>();
    for (const item of items as any[]) {
      if (item.type === "custom") {
        const custom = new CustomMessageComponent(customEntryMessage(item), undefined, options.markdownTheme, options.outputPad);
        custom.setExpanded(options.expandedTools);
        container.addChild(custom);
        continue;
      }
      switch (item.role) {
        case "user": {
          const text = typeof item.content === "string" ? item.content : item.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
          if (!text) break;
          if (container.children.length) container.addChild(new Spacer(1));
          const skill = parseSkillBlock(text);
          if (skill) {
            const component = new SkillInvocationMessageComponent(skill, options.markdownTheme);
            component.setExpanded(options.expandedTools);
            container.addChild(component);
            if (skill.userMessage) {
              container.addChild(new Spacer(1));
              container.addChild(new UserMessageComponent(skill.userMessage, options.markdownTheme, options.outputPad));
            }
          } else {
            container.addChild(new UserMessageComponent(text, options.markdownTheme, options.outputPad));
          }
          break;
        }
        case "assistant": {
          container.addChild(new AssistantMessageComponent(item, options.hideThinking, options.markdownTheme, "Thinking...", options.outputPad));
          for (const content of item.content) {
            if (content.type !== "toolCall") continue;
            const tool = new ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false }, this.resolveToolRenderer?.(content.name), options.ui as any, options.cwd);
            tool.setExpanded(options.expandedTools);
            tool.markExecutionStarted();
            tool.setArgsComplete();
            container.addChild(tool);
            pendingTools.set(content.id, tool);
          }
          if (item.stopReason === "aborted" || item.stopReason === "error") {
            for (const [toolCallId, tool] of pendingTools) {
              tool.updateResult({ type: "toolResult", toolCallId, toolName: "", content: [{ type: "text", text: "Tool execution interrupted" }], isError: true });
              this.onToolResult?.({ toolCallId, isError: true, content: "Tool execution interrupted" });
              pendingTools.delete(toolCallId);
            }
          }
          break;
        }
        case "toolResult": {
          const tool = pendingTools.get(item.toolCallId);
          tool?.updateResult(item);
          if (tool) this.onToolResult?.(item);
          pendingTools.delete(item.toolCallId);
          break;
        }
        case "bashExecution": {
          const bash = new BashExecutionComponent(item.command, options.ui as any, item.excludeFromContext);
          if (item.output) bash.appendOutput(item.output);
          bash.setComplete(item.exitCode, item.cancelled, item.truncated ? { truncated: true } : undefined, item.fullOutputPath);
          bash.setExpanded(options.expandedTools);
          container.addChild(bash);
          break;
        }
        case "custom": {
          if (!item.display) break;
          const custom = new CustomMessageComponent(item, undefined, options.markdownTheme, options.outputPad);
          custom.setExpanded(options.expandedTools);
          container.addChild(custom);
          break;
        }
        case "compactionSummary": {
          container.addChild(new Spacer(1));
          const summary = new CompactionSummaryMessageComponent(item, options.markdownTheme);
          summary.setExpanded(options.expandedTools);
          container.addChild(summary);
          break;
        }
        case "branchSummary": {
          container.addChild(new Spacer(1));
          const summary = new BranchSummaryMessageComponent(item, options.markdownTheme);
          summary.setExpanded(options.expandedTools);
          container.addChild(summary);
          break;
        }
      }
    }
    return container.render(options.width);
  }
}
