import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

export type AgentCatalogEntry = Readonly<{
  name: string;
  description: string;
}>;

export type AgentCatalogReadResult = Readonly<{
  admission: "repository-configured";
  agents: readonly AgentCatalogEntry[];
}>;

export type AgentCatalogDependencies = {
  readAdmittedAgents: (
    ctx: ExtensionContext,
  ) => AgentCatalogReadResult | Promise<AgentCatalogReadResult>;
};

export interface AdmittedAgentCatalog {
  initialize(ctx: ExtensionContext): Promise<void>;
  apply(event: BeforeAgentStartEvent, ctx: ExtensionContext): void;
  invalidate(): void;
  dispose(): void;
}

export function projectAgentCatalog(
  agents: readonly AgentCatalogEntry[],
): readonly AgentCatalogEntry[] {
  return agents
    .map(({ name, description }) => ({ name, description }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function encodeCatalogText(value: string): string {
  // 保留完整正文及换行、制表符，仅清理终端控制符并编码 XML 特殊字符。
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatAgentCatalog(
  entries: readonly AgentCatalogEntry[],
): string {
  return [
    "本会话准入角色，通过 subagent_start 使用；名册仅供选择，实际派发仍由 runtime 校验。",
    "默认不传 model，模型由 runtime 按既有规则选择；仅用户显式指定时传入 model。",
    "",
    ...entries.map(({ name, description }) =>
      `<agent name="${encodeCatalogText(name)}"><description>${encodeCatalogText(description)}</description></agent>`,
    ),
  ].join("\n");
}

type CatalogIdentity = {
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  cwd: string;
};

type CatalogSnapshot = CatalogIdentity & {
  generation: number;
  status: "loading" | "ready" | "unavailable";
  entries: readonly AgentCatalogEntry[];
  text: string;
  initialization: Promise<void>;
};

function matchesIdentity(identity: CatalogIdentity, ctx: ExtensionContext): boolean {
  return identity.manager === ctx.sessionManager
    && identity.sessionId === ctx.sessionManager.getSessionId()
    && identity.cwd === ctx.cwd;
}

export function createAdmittedAgentCatalog(
  deps: AgentCatalogDependencies,
): AdmittedAgentCatalog {
  let generation = 0;
  let snapshot: CatalogSnapshot | undefined;
  let disposed = false;

  function isCurrent(candidate: CatalogSnapshot, ctx: ExtensionContext): boolean {
    return !disposed
      && snapshot === candidate
      && candidate.generation === generation
      && matchesIdentity(candidate, ctx);
  }

  function invalidate(): void {
    generation += 1;
    snapshot = undefined;
  }

  return {
    initialize(ctx) {
      if (disposed) return Promise.resolve();
      if (snapshot && matchesIdentity(snapshot, ctx)) return snapshot.initialization;

      const candidate: CatalogSnapshot = {
        manager: ctx.sessionManager,
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        generation: ++generation,
        status: "loading",
        entries: [],
        text: "",
        initialization: Promise.resolve(),
      };
      snapshot = candidate;
      // 先安装同代 Promise，再调用依赖，包含同步失败在内均由调用方既有诊断链处理。
      candidate.initialization = Promise.resolve().then(async () => {
        if (!isCurrent(candidate, ctx)) return;
        try {
          const result = await deps.readAdmittedAgents(ctx);
          if (!isCurrent(candidate, ctx)) return;
          if (result.admission !== "repository-configured") {
            throw new Error("名册准入不可用：需要 repository-configured");
          }
          const entries = projectAgentCatalog(result.agents);
          const text = formatAgentCatalog(entries);
          candidate.entries = entries;
          candidate.text = text;
          candidate.status = "ready";
        } catch (error) {
          if (isCurrent(candidate, ctx)) candidate.status = "unavailable";
          throw error;
        }
      });
      return candidate.initialization;
    },

    apply(event, ctx) {
      const options = event.systemPromptOptions;
      if (snapshot?.status === "ready"
        && isCurrent(snapshot, ctx)
        && options.selectedTools.includes("subagent_start")) {
        options.sections.advertised_subagents = snapshot.text;
      } else {
        delete options.sections.advertised_subagents;
      }
    },

    invalidate,

    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
    },
  };
}
