import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  decideDeterministicTurn,
  deterministicContractKey,
  deterministicExecutorAcceptanceReport,
  deterministicExecutorCommand,
  decideDeterministicAmendmentTurn,
} from "./deterministic-provider-state.mjs";

export default function (pi) {
  const issuedDispatchContractKeys = new Set();
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
      const userText = messages.filter((message) => message?.role === "user").at(-1)?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
      const toolResults = messages.filter((message) => message?.role === "toolResult");
      const availableTools = new Set(tools.map((tool) => tool.name));
      const toolResultText = toolResults.map((message) => message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "").join("\n");
      const bootstrap = userText.match(/exact bootstrap JSON:\s*\n(\{[^\n]+\})/)?.[1];
      const compatTurn = decideDeterministicTurn({
        messages,
        toolNames: [...availableTools],
        issuedDispatchContractKeys,
        attentionMode: process.env.PI_PLAN_HARNESS_ATTENTION === "1",
        executorRunId: process.env.PI_SUBAGENT_RUN_ID,
      });
      const amendmentSource = process.env.PI_PLAN_HARNESS_AMENDMENT_SOURCE;
      const amendmentMode = process.env.PI_PLAN_HARNESS_AMENDMENT === "1";
      const amendmentTurn = amendmentMode
        ? decideDeterministicAmendmentTurn({ messages, toolNames: [...availableTools], amendmentSource })
        : undefined;
      const fallbackTurn = amendmentTurn === undefined && compatTurn === undefined ? (() => {
        if (toolResults.some((message) => message?.toolName === "plan_verify")) return undefined;
        if (bootstrap && availableTools.has("plan_open") && toolResults.length === 0) {
          return { name: "plan_open", arguments: JSON.parse(bootstrap) };
        }
        if (availableTools.has("compact_plan_session")
          && toolResults.some((message) => message?.toolName === "plan_open")
          && !toolResults.some((message) => message?.toolName === "compact_plan_session")) {
          return { name: "compact_plan_session", arguments: {} };
        }
        if (availableTools.has("plan_continue") && toolResults.length === 1) {
          return { name: "plan_continue", arguments: { reason: "e2e" } };
        }
        if (availableTools.has("plan_verify") && toolResults.some((message) => message?.toolName === "subagent")) {
          return { name: "plan_verify", arguments: {} };
        }
        if (availableTools.has("subagent") && /"tool"\s*:\s*\{/.test(toolResultText)) {
          const payload = JSON.parse(toolResultText.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
          return { name: "subagent", arguments: payload.tool };
        }
        if (availableTools.has("bash") && toolResults.length === 0) {
          const command = deterministicExecutorCommand(userText);
          if (command) return { name: "bash", arguments: { command } };
        }
        return undefined;
      })() : undefined;
      const next = amendmentTurn !== undefined
        ? amendmentTurn.tool
        : compatTurn?.tool ?? fallbackTurn;
      const executorCommand = deterministicExecutorCommand(userText);
      const successfulExecutorResult = executorCommand !== undefined
        && issuedExecutorBashCommands.has(executorCommand)
        && toolResults.some((message) => message?.toolName === "bash"
          && message?.isError !== true
          && (message?.details?.exitCode === undefined || message.details.exitCode === 0));
      const responseText = successfulExecutorResult
        ? deterministicExecutorAcceptanceReport(userText, executorCommand)
        : amendmentTurn?.text ?? compatTurn?.text ?? "deterministic";
      const assistantToolCalls = messages.filter((message) => message?.role === "assistant")
        .flatMap((message) => message.content ?? [])
        .filter((part) => part?.type === "toolCall");
      const seenToolCallIds = new Set(assistantToolCalls
        .filter((part) => typeof part.id === "string")
        .map((part) => part.id));
      let toolCallOrdinal = nextToolCallOrdinal;
      let toolCallId = `deterministic-${next?.name}-${toolCallOrdinal}`;
      while (seenToolCallIds.has(toolCallId)) {
        toolCallOrdinal += 1;
        toolCallId = `deterministic-${next?.name}-${toolCallOrdinal}`;
      }
      if (next) {
        nextToolCallOrdinal = toolCallOrdinal + 1;
        if (next.name === "subagent") issuedDispatchContractKeys.add(deterministicContractKey(next.arguments));
        if (next.name === "bash" && next.arguments?.command === executorCommand) {
          issuedExecutorBashCommands.add(executorCommand);
        }
      }
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const message = {
        role: "assistant",
        content: next ? [{ type: "toolCall", id: toolCallId, name: next.name, arguments: next.arguments }] : [{ type: "text", text: responseText }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: next ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      if (next) {
        const id = message.content[0].id;
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
