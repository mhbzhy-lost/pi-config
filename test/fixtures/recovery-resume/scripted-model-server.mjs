// Test-only fixture: R8 非 LLM 验收的确定性 openai-completions 模型服务。
// 按请求消息语义返回脚本化响应：
// - Root 会话（prompt 含 "r8 dispatch"）：派发 subagent tool call（dispatch-ir 合同）；
// - Child 首轮（任务 prompt）：bash 提交任务改动；
// - conflict continuation（"current rebase conflict"）：bash kill 自身（模拟 resolving-conflict 阶段退出）；
// - recovery resume prompt（"继续之前中断"）：bash 解决当前冲突或 no-op；
// - 其余（reviewer 等）：纯文本收尾。
import { createServer } from "node:http";

const ALLOWED_TASKS = new Set(["solo", "head", "follower", "conflict", "prepared"]);

export function dispatchContract(task) {
  const file = task === "head" || task === "follower" ? `src/${task}.txt` : "src/pipeline.ts";
  return {
    version: "dispatch-ir.v1",
    taskId: `r8-${task}`,
    title: `R8 recovery stage ${task}`,
    agent: "executor",
    model: "fake/deterministic",
    risk: "high",
    objective: `Append the ${task} change and commit it.`,
    workflow: { mode: "tdd" },
    requirements: [`Write ${file} with the ${task} content and create a commit.`, "Only perform business-file changes; Auto Integration owns queue admission, rebase, conflict continuation, and publication."],
    context: { knownFacts: ["The recovery harness drives integration via the trusted lifecycle."], decisions: ["Auto Integration owns the queue."], relevantFiles: [file] },
    boundaries: { writePaths: [file], excludedWork: ["Production coordinator changes."], forbiddenActions: ["Do not call integration mutation tools."] },
    acceptance: { criteria: [`${file} contains the ${task} change and is committed.`] },
    execution: { worktree: true },
  };
}

function messageText(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return JSON.stringify(lastUser?.content ?? "");
}

function issuedToolCallIds(messages) {
  const issued = new Set();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) if (typeof call.id === "string") issued.add(call.id);
    if (Array.isArray(message.content)) for (const part of message.content) if (part?.type === "toolCall" && typeof part.id === "string") issued.add(part.id);
  }
  return issued;
}

function scriptedResponse(messages, tasks) {
  const text = messageText(messages);
  const issued = issuedToolCallIds(messages);
  if (text.includes("r8 dispatch")) {
    const calls = tasks.filter((task) => !issued.has(`r8-${task}`)).map((task) => ({ id: `r8-${task}`, name: "subagent", arguments: dispatchContract(task) }));
    return calls.length ? { toolCalls: calls } : { text: "r8 root settled" };
  }
  if (text.includes("继续之前中断") && !issued.has("r8-recovery")) {
    return { toolCalls: [{ id: "r8-recovery", name: "bash", arguments: { command: "if git diff --name-only --diff-filter=U | grep -q .; then git checkout --theirs -- . && git add -A; fi" } }] };
  }
  if (text.includes("current rebase conflict") && !issued.has("r8-exit")) {
    return { toolCalls: [{ id: "r8-exit", name: "bash", arguments: { command: "kill -9 $PPID" } }] };
  }
  const taskMatch = text.match(/r8-(solo|head|follower|conflict|prepared)/) ?? text.match(/Append the (solo|head|follower|conflict|prepared) change/);
  if (taskMatch && !issued.has("r8-work")) {
    const task = taskMatch[1];
    const file = task === "head" || task === "follower" ? `src/${task}.txt` : "src/pipeline.ts";
    return { toolCalls: [{ id: "r8-work", name: "bash", arguments: { command: `echo '${task}' > ${file} && git add ${file} && git commit -m 'feat: 添加 ${task} 阶段'` } }] };
  }
  return { text: "r8 scripted turn complete" };
}

/** 启动本地 openai-completions 兼容服务；返回 { port, requests, close }。 */
export function startScriptedModelServer({ tasks = ["solo"], port = 0 } = {}) {
  if (!Array.isArray(tasks) || tasks.some((task) => !ALLOWED_TASKS.has(task))) throw new Error("scripted model server tasks are invalid");
  const requests = [];
  const server = createServer((request, response) => {
    if (!String(request.url ?? "").endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const reply = scriptedResponse(messages, tasks);
      requests.push({ messageCount: messages.length, lastUser: messageText(messages).slice(0, 200), toolCalls: (reply.toolCalls ?? []).map((call) => call.id) });
      const chunkId = `chatcmpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const model = typeof payload.model === "string" && payload.model ? payload.model : "deterministic";
      const send = (delta, finishReason = null) => {
        response.write(`data: ${JSON.stringify({ id: chunkId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      send({ role: "assistant", content: "" });
      if (reply.toolCalls?.length) {
        reply.toolCalls.forEach((call, index) => {
          send({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] });
          send({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments) } }] });
        });
        send({}, "tool_calls");
      } else {
        send({ content: reply.text ?? "r8 scripted turn complete" });
        send({}, "stop");
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
