import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  decideDeterministicTurn,
  deterministicExecutorAcceptanceReport,
  deterministicExecutorCommand,
} from "./deterministic-provider-state.mjs";

export default function deterministicProviderExtension(pi) {
  const issuedExecutorBashCommands = new Set();
  let nextToolCallOrdinal = 1;
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:9",
    api: "fake",
    apiKey: "not-used",
    models: [{
      id: "deterministic",
      name: "Deterministic",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const messages = context?.messages ?? [];
      const tools = context?.tools ?? [];
      const toolNames = tools.map((tool) => tool.name);
      const toolResults = messages.filter((message) => message?.role === "toolResult");
      const userText = messages.filter((message) => message?.role === "user").at(-1)?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
      const decided = decideDeterministicTurn({ messages, toolNames });
      const executorCommand = deterministicExecutorCommand(userText);
      const fallback = decided === undefined && executorCommand && toolNames.includes("bash") && !toolResults.some((message) => message.toolName === "bash")
        ? { tool: { name: "bash", arguments: { command: executorCommand } } }
        : undefined;
      const next = decided?.tool ?? fallback?.tool;
      if (next?.name === "bash" && next.arguments?.command === executorCommand) issuedExecutorBashCommands.add(executorCommand);
      const successfulExecutorResult = executorCommand !== undefined
        && issuedExecutorBashCommands.has(executorCommand)
        && toolResults.some((message) => message.toolName === "bash"
          && message.isError !== true
          && (message.details?.exitCode === undefined || message.details.exitCode === 0));
      const responseText = successfulExecutorResult
        ? deterministicExecutorAcceptanceReport(userText, executorCommand)
        : decided?.text ?? "deterministic";

      const seenToolCallIds = new Set(messages.filter((message) => message?.role === "assistant")
        .flatMap((message) => message.content ?? [])
        .filter((part) => part?.type === "toolCall" && typeof part.id === "string")
        .map((part) => part.id));
      let ordinal = nextToolCallOrdinal;
      let toolCallId = `deterministic-${next?.name}-${ordinal}`;
      while (seenToolCallIds.has(toolCallId)) toolCallId = `deterministic-${next?.name}-${++ordinal}`;
      if (next) nextToolCallOrdinal = ordinal + 1;

      const usage = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const message = {
        role: "assistant",
        content: next
          ? [{ type: "toolCall", id: toolCallId, name: next.name, arguments: next.arguments }]
          : [{ type: "text", text: responseText }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: next ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      if (next) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(next.arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: responseText, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: responseText, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  });
}
