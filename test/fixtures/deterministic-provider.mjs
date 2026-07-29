import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { decideDeterministicTurn, deterministicExecutorCommand } from "./deterministic-provider-state.mjs";

export default function (pi) {
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
      const compatTurn = decideDeterministicTurn({ messages, toolNames: [...availableTools] });
      const amendmentSource = process.env.PI_PLAN_HARNESS_AMENDMENT_SOURCE;
      const amendmentMode = process.env.PI_PLAN_HARNESS_AMENDMENT === "1";
      let amendmentOwnsTurn = false;
      const amendmentTurn = (() => {
        const messageText = (message) => {
          if (typeof message?.content === "string") return message.content;
          if (Array.isArray(message?.content)) return message.content
            .filter((part) => part?.type === "text")
            .map((part) => part?.text ?? "")
            .join("\n");
          return "";
        };
        const hasResult = (name) => toolResults.some((message) => message?.toolName === name);
        const hasToolCall = (name) => messages.some((message) => message?.role === "assistant"
          && message?.content?.some((part) => part?.type === "toolCall" && part?.name === name));
        if (!amendmentMode) return undefined;
        const latestStatus = messages.filter((message) => message?.role === "toolResult"
          && message?.toolName === "plan_status" && message?.isError !== true).at(-1);
        let latestPlanStatus;
        try { latestPlanStatus = latestStatus ? JSON.parse(messageText(latestStatus)) : undefined; } catch {}
        const latestStatusIndex = latestStatus ? messages.lastIndexOf(latestStatus) : -1;
        amendmentOwnsTurn = latestPlanStatus?.revision?.number === 2;
        if (amendmentOwnsTurn) {
          const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
          const currentUserTurn = messages.slice(lastUserIndex + 1);
          const hasCurrentTurnAction = (name) => currentUserTurn.some((message) => message?.toolName === name
            || (message?.role === "assistant" && message?.content?.some((part) => part?.type === "toolCall" && part?.name === name)));
          const actionAfterStatus = latestStatusIndex >= 0 && messages.slice(latestStatusIndex + 1).some((message) => {
            const name = message?.toolName;
            return ["plan_continue", "plan_verify", "subagent_wait"].includes(name)
              || (message?.role === "assistant" && message?.content?.some((part) => part?.type === "toolCall"
                && ["plan_continue", "plan_verify", "subagent_wait"].includes(part?.name)));
          });
          if (actionAfterStatus) {
            if (availableTools.has("plan_status")) return { name: "plan_status", arguments: {} };
            return undefined;
          }

          const tasks = Array.isArray(latestPlanStatus.tasks) ? latestPlanStatus.tasks : [];
          const allTasksTerminal = tasks.length > 0
            && tasks.every((task) => ["accepted", "integrated", "retired"].includes(task?.status));
          const attempts = tasks.flatMap((task) => Array.isArray(task?.attempts) ? task.attempts : []);
          const pending = tasks.some((task) => task?.status === "pending");
          const active = [...tasks, ...attempts].some((item) => ["active", "waiting", "waiting-attention", "dispatch", "dispatching"].includes(item?.status));
          const integrated = tasks.some((task) => ["accepted", "integrated"].includes(task?.status));
          const validated = attempts.some((attempt) => ["validated", "succeeded"].includes(attempt?.status));
          const superseded = attempts.some((attempt) => attempt?.status === "superseded");
          const recoveryAlreadyCalled = messages.some((message) => message?.role === "assistant"
            && message?.content?.some((part) => part?.type === "toolCall" && part?.name === "plan_continue"
              && part?.arguments?.reason === "amendment-recovery"));
          const mustContinue = /MUST call plan_continue/.test(userText) && !hasCurrentTurnAction("plan_continue");
          const mustVerify = /MUST call plan_verify/.test(userText) && !hasCurrentTurnAction("plan_verify");
          const continueReason = validated || integrated ? "integrate" : "amendment-recovery";

          if ((mustVerify || latestPlanStatus.lifecycle === "verifying" || allTasksTerminal) && availableTools.has("plan_verify")
            && !hasCurrentTurnAction("plan_verify")) return { name: "plan_verify", arguments: {} };
          if (mustContinue && availableTools.has("plan_continue")) {
            return { name: "plan_continue", arguments: { reason: continueReason } };
          }
          if (active && availableTools.has("subagent_wait")) return { name: "subagent_wait", arguments: { all: false, timeoutMs: 1000 } };
          if (pending && (validated || integrated) && availableTools.has("plan_continue")) {
            return { name: "plan_continue", arguments: { reason: "integrate" } };
          }
          if (pending && superseded && !validated && !integrated && !recoveryAlreadyCalled
            && availableTools.has("plan_continue")) {
            return { name: "plan_continue", arguments: { reason: "amendment-recovery" } };
          }
          return undefined;
        }
        const planAmendIndex = messages.findLastIndex((message) => message?.role === "assistant"
          && message?.content?.some((part) => part?.type === "toolCall" && part?.name === "plan_amend"));
        if (planAmendIndex >= 0) {
          const postAmend = messages.slice(planAmendIndex + 1);
          const hasPostAmendContinue = postAmend.some((message) => message?.toolName === "plan_continue"
            || (message?.role === "assistant" && message?.content?.some((part) => part?.type === "toolCall" && part?.name === "plan_continue")));
          const hasPostAmendVerify = postAmend.some((message) => message?.toolName === "plan_verify"
            || (message?.role === "assistant" && message?.content?.some((part) => part?.type === "toolCall" && part?.name === "plan_verify")));
          const status = postAmend.filter((message) => message?.role === "toolResult"
            && message?.toolName === "plan_status" && message?.isError !== true).at(-1);
          const statusText = status?.content?.map((part) => part?.text ?? "").join("\n") ?? "";
          let current;
          try { current = status ? JSON.parse(statusText) : undefined; } catch {}
          if (!hasPostAmendContinue && !status && availableTools.has("plan_status")) return { name: "plan_status", arguments: {} };
          if (!hasPostAmendContinue && current?.revision?.number === 2 && current?.lifecycle === "running" && current?.tasks?.some((task) => task?.status === "pending") && availableTools.has("plan_continue")) {
            return { name: "plan_continue", arguments: { reason: "amendment-recovery" } };
          }
          const postAmendVerifyRequested = postAmend.some((message) => /MUST call plan_verify/.test(messageText(message)));
          const allTasksTerminal = current?.tasks?.length > 0 && current.tasks.every((task) => ["accepted", "integrated", "retired"].includes(task?.status));
          if (hasPostAmendContinue && !hasPostAmendVerify && availableTools.has("plan_verify")
            && (postAmendVerifyRequested || (current?.revision?.number === 2 && (current?.lifecycle === "verifying" || allTasksTerminal)))) {
            return { name: "plan_verify", arguments: {} };
          }
          return undefined;
        }
        if (/^Allowed paths: decision\.txt$/m.test(userText) && hasResult("contact_supervisor") && !hasResult("bash") && availableTools.has("bash")) {
          return { name: "bash", arguments: { command: "sleep 10; printf 'approved\\n' > decision.txt && git add decision.txt && git commit -m 'test: amendment 旧任务'" } };
        }
        if (/^Allowed paths: amended\.txt$/m.test(userText) && !hasResult("bash") && availableTools.has("bash")) {
          return { name: "bash", arguments: { command: "printf 'amended\\n' > amended.txt && git add amended.txt && git commit -m 'test: amendment 新任务'" } };
        }
        if (/^Allowed paths: repair\.txt$/m.test(userText) && !hasResult("bash") && availableTools.has("bash")) {
          return { name: "bash", arguments: { command: "printf 'repair\\n' > repair.txt && git add repair.txt && git commit -m 'test: amendment 修复任务'" } };
        }
        const replyIndex = messages.reduce((latest, message, index) => message?.role === "toolResult"
          && message?.toolName === "subagent_supervisor" && message?.isError !== true
          && typeof message?.details?.replyTo === "string" ? index : latest, -1);
        const reply = messages[replyIndex];
        if (replyIndex < 0 || !amendmentSource || hasToolCall("plan_amend") || hasResult("plan_amend")) return undefined;
        const status = messages.slice(replyIndex + 1).filter((message) => message?.role === "toolResult"
          && message?.toolName === "plan_status" && message?.isError !== true).at(-1);
        if (!status && availableTools.has("plan_status")) return { name: "plan_status", arguments: {} };
        if (status && availableTools.has("plan_amend")) {
          const statusText = status.content?.map((part) => part?.text ?? "").join("\n") ?? "";
          const projectionVersion = Number(statusText.match(/"projectionVersion"\s*:\s*(\d+)/)?.[1]);
          if (Number.isSafeInteger(projectionVersion)) return { name: "plan_amend", arguments: { expectedProjectionVersion: projectionVersion, baseRevision: 1, requestId: reply.details.replyTo, reason: "approved amendment", source: amendmentSource } };
        }
        return undefined;
      })();
      const next = amendmentTurn ?? (amendmentOwnsTurn ? undefined : compatTurn?.tool ?? (() => {
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
      })());
      const responseText = amendmentOwnsTurn && !next ? "amendment revision2 waiting" : compatTurn?.text ?? "deterministic";
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
        content: next ? [{ type: "toolCall", id: `deterministic-${next.name}-${toolResults.length}`, name: next.name, arguments: next.arguments }] : [{ type: "text", text: responseText }],
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
