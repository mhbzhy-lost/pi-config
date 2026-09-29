#!/usr/bin/env node
/**
 * 诊断探针：zai-coding-cn glm-5.3 在 `tool_stream: true` 下的空 tool arguments 问题。
 *
 * 背景：pi 会话中 glm-5.3 对 subagent tool（顶层 anyOf 三分支 schema）的调用
 * 8/8 全部空参数（arguments === {}），rawStopReason=tool_calls、responseId 正常。
 * pi-ai 侧 arguments 只来自 function.arguments 流式分片累积，
 * 因此怀疑 zai 服务端在 tool_stream 模式下未发送（或以非标准格式发送）arguments 分片。
 *
 * 本探针直接调用 zai endpoint，三组对照实验，原始 SSE 逐行落盘：
 *   A) simple-schema   + tool_stream: true   —— 简单 object schema 基线
 *   B) anyof-schema    + tool_stream: true   —— 模拟 subagent 的顶层 anyOf schema（故障形态）
 *   C) anyof-schema    + 无 tool_stream      —— 关闭 tool_stream 的 anyOf 对照
 *
 * 凭据从 pi/auth.json 间接读取，不打印、不落盘。
 * 输出：var/diagnostics/zai-tool-stream/<case>.sse.txt + stdout 统计摘要。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const configHome = process.env.PI_CONFIG_HOME;
if (!configHome) throw new Error("需要 PI_CONFIG_HOME 环境变量");

const auth = JSON.parse(readFileSync(join(configHome, "pi/auth.json"), "utf8"));
const zaiAuth = auth["zai-coding-cn"];
if (!zaiAuth?.key) throw new Error("auth.json 中缺少 zai-coding-cn key");
const apiKey = zaiAuth.key; // 间接读取，仅用于请求头，绝不打印

const store = JSON.parse(readFileSync(join(configHome, "pi/models-store.json"), "utf8"));
const glm = store["zai-coding-cn"].models.find((m: { id: string }) => m.id === "glm-5.3");
if (!glm) throw new Error("models-store.json 中缺少 glm-5.3");
const baseUrl = glm.baseUrl as string;

const outDir = join(configHome, "var/diagnostics/zai-tool-stream");
mkdirSync(outDir, { recursive: true });

const TOOL_NAME = "spawn_task";

const simpleSchema = {
	type: "object",
	properties: {
		taskId: { type: "string", minLength: 1 },
		title: { type: "string", minLength: 1 },
	},
	required: ["taskId", "title"],
	additionalProperties: false,
};

// 模拟 subagent tool 的顶层 anyOf 三分支结构（dispatch-ir.v1 / generic / control action）。
// 保持等价复杂度：anyOf 顶层、每分支独立 required、enum、pattern、嵌套对象数组。
const anyOfSchema = {
	anyOf: [
		{
			type: "object",
			additionalProperties: false,
			required: ["version", "taskId", "title", "agent", "risk", "objective", "workflow", "requirements", "context", "boundaries", "acceptance", "execution"],
			properties: {
				version: { const: "dispatch-ir.v1" },
				taskId: { type: "string", pattern: "^[A-Za-z0-9._-]{1,160}$" },
				title: { type: "string", minLength: 1, maxLength: 4096 },
				agent: { type: "string", minLength: 1 },
				risk: { type: "string", enum: ["low", "normal", "high"] },
				task: { type: "string", minLength: 1 },
				workflow: {
					type: "object",
					required: ["mode"],
					properties: {
						mode: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
						reason: { type: "string" },
					},
				},
				requirements: { type: "array", items: { type: "string" }, minItems: 1 },
				context: {
					type: "object",
					required: ["knownFacts", "decisions", "relevantFiles"],
					properties: {
						knownFacts: { type: "array", items: { type: "string" } },
						decisions: { type: "array", items: { type: "string" } },
						relevantFiles: { type: "array", items: { type: "string" } },
					},
				},
				boundaries: {
					type: "object",
					required: ["writePaths", "excludedWork", "forbiddenActions"],
					properties: {
						writePaths: { type: "array", items: { type: "string" } },
						excludedWork: { type: "array", items: { type: "string" } },
						forbiddenActions: { type: "array", items: { type: "string" } },
					},
				},
				acceptance: {
					type: "object",
					required: ["criteria"],
					properties: { criteria: { type: "array", items: { type: "string" }, minItems: 1 } },
				},
				execution: {
					type: "object",
					properties: { cwd: { type: "string" }, worktree: { type: "boolean" } },
				},
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["agent", "title", "task"],
			properties: {
				agent: { type: "string", minLength: 1 },
				title: { type: "string", minLength: 1, maxLength: 256 },
				task: { type: "string", minLength: 1 },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: ["status", "steer", "interrupt", "resume", "stop"] },
				id: { type: "string" },
				runId: { type: "string" },
				dir: { type: "string" },
				index: { type: "integer", minimum: 0 },
				message: { type: "string" },
			},
		},
	],
};

interface CaseDef {
	name: string;
	schema: unknown;
	toolStream: boolean;
	prompt: string;
}

// 变换形态 D：把三分支 anyOf 拍平成单 object（字段并集，全部可选）。
// 这是 OpenAI 生态最保守兼容的顶层形态，也是候选修复方案。
const flatObjectSchema = {
	type: "object",
	properties: {
		version: { type: "string", enum: ["dispatch-ir.v1"] },
		taskId: { type: "string", pattern: "^[A-Za-z0-9._-]{1,160}$" },
		title: { type: "string", minLength: 1, maxLength: 4096 },
		agent: { type: "string", minLength: 1 },
		risk: { type: "string", enum: ["low", "normal", "high"] },
		task: { type: "string", minLength: 1 },
		workflow: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["tdd", "existing-tests", "docs-only"] },
				reason: { type: "string" },
			},
		},
		requirements: { type: "array", items: { type: "string" } },
		context: {
			type: "object",
			properties: {
				knownFacts: { type: "array", items: { type: "string" } },
				decisions: { type: "array", items: { type: "string" } },
				relevantFiles: { type: "array", items: { type: "string" } },
			},
		},
		boundaries: {
			type: "object",
			properties: {
				writePaths: { type: "array", items: { type: "string" } },
				excludedWork: { type: "array", items: { type: "string" } },
				forbiddenActions: { type: "array", items: { type: "string" } },
			},
		},
		acceptance: {
			type: "object",
			properties: { criteria: { type: "array", items: { type: "string" } } },
		},
		execution: {
			type: "object",
			properties: { cwd: { type: "string" }, worktree: { type: "boolean" } },
		},
		task: { type: "string", minLength: 1 },
		action: { type: "string", enum: ["status", "steer", "interrupt", "resume", "stop"] },
		id: { type: "string" },
		runId: { type: "string" },
		dir: { type: "string" },
		index: { type: "integer", minimum: 0 },
		message: { type: "string" },
	},
	additionalProperties: false,
};

// 变换形态 E：顶层 oneOf（对照，确认 anyOf/oneOf 是否同病）。
const oneOfSchema = { oneOf: anyOfSchema.anyOf };
// 变换形态 F：顶层 allOf 包裹 anyOf（变体对照）。
const allOfWrapSchema = { allOf: [anyOfSchema] };
// 变换形态 G：顶层 object（无 anyOf）+ 字段级 anyOf（模拟 runtimeValidated 结构）。
// 验证拍平后内部字段级 anyOf 是否安全。
const fieldAnyOfSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		taskId: { type: "string", pattern: "^[A-Za-z0-9._-]{1,160}$" },
		title: { type: "string", minLength: 1, maxLength: 4096 },
		requirements: {
			anyOf: [
				{ type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, maxItems: 32, minItems: 1 },
				{ type: "array" },
				{ type: "string" },
			],
		},
		context: {
			anyOf: [
				{
					type: "object",
					additionalProperties: false,
					required: ["knownFacts", "decisions", "relevantFiles"],
					properties: {
						knownFacts: { type: "array", items: { type: "string" } },
						decisions: { type: "array", items: { type: "string" } },
						relevantFiles: { type: "array", items: { type: "string" } },
					},
				},
				{ type: "object", additionalProperties: true },
			],
		},
	},
};

const promptFor = (hint: string) =>
	`请立即调用 ${TOOL_NAME} 工具完成任务：${hint}。不要输出多余文字，直接调用工具。`;

const cases: CaseDef[] = [
	{
		name: "A-simple-stream",
		schema: simpleSchema,
		toolStream: true,
		prompt: promptFor("taskId 填 diag-simple-1，title 填 简单诊断"),
	},
	{
		name: "B-anyof-stream",
		schema: anyOfSchema,
		toolStream: true,
		prompt: promptFor(
			"使用 dispatch-ir.v1 分支：taskId 填 diag-anyof-1，title 填 anyOf诊断，agent 填 executor，risk 填 low，objective 填 验证anyOf，workflow 填 {mode: tdd}，requirements 填 [验证参数生成]，context 填 {knownFacts:[a], decisions:[b], relevantFiles:[c]}，boundaries 填 {writePaths:[src/], excludedWork:[无], forbiddenActions:[不提交]}，acceptance 填 {criteria:[参数完整]}，execution 填 {worktree: false}",
		),
	},
	{
		name: "D-flat-object-stream",
		schema: flatObjectSchema,
		toolStream: true,
		prompt: promptFor(
			"使用 dispatch-ir.v1 形态：version 填 dispatch-ir.v1，taskId 填 diag-flat-1，title 填 拍平诊断，agent 填 executor，risk 填 low，objective 填 验证拍平，workflow 填 {mode: tdd}，requirements 填 [验证参数生成]，context 填 {knownFacts:[a], decisions:[b], relevantFiles:[c]}，boundaries 填 {writePaths:[src/], excludedWork:[无], forbiddenActions:[不提交]}，acceptance 填 {criteria:[参数完整]}，execution 填 {worktree: false}",
		),
	},
	{
		name: "G-field-anyof-stream",
		schema: fieldAnyOfSchema,
		toolStream: true,
		prompt: promptFor(
			"taskId 填 diag-g-1，title 填 字段级anyOf诊断，requirements 填 [验证字段级anyOf, 第二条要求]，context 填 {knownFacts:[事实一], decisions:[决策一], relevantFiles:[src/a.ts]}",
		),
	},
	{
		name: "E-oneof-stream",
		schema: oneOfSchema,
		toolStream: true,
		prompt: promptFor(
			"使用第一分支（version=dispatch-ir.v1）：taskId 填 diag-oneof-1，title 填 oneOf诊断，agent 填 executor，risk 填 low，objective 填 验证oneOf，workflow 填 {mode: tdd}，requirements 填 [验证参数生成]，context 填 {knownFacts:[a], decisions:[b], relevantFiles:[c]}，boundaries 填 {writePaths:[src/], excludedWork:[无], forbiddenActions:[不提交]}，acceptance 填 {criteria:[参数完整]}，execution 填 {worktree: false}",
		),
	},
	{
		name: "F-allof-wrap-stream",
		schema: allOfWrapSchema,
		toolStream: true,
		prompt: promptFor(
			"使用第一分支（version=dispatch-ir.v1）：taskId 填 diag-allof-1，title 填 allOf包裹诊断，agent 填 executor，risk 填 low，objective 填 验证allOf包裹，workflow 填 {mode: tdd}，requirements 填 [验证参数生成]，context 填 {knownFacts:[a], decisions:[b], relevantFiles:[c]}，boundaries 填 {writePaths:[src/], excludedWork:[无], forbiddenActions:[不提交]}，acceptance 填 {criteria:[参数完整]}，execution 填 {worktree: false}",
		),
	},
];

async function runCase(def: CaseDef): Promise<void> {
	const body: Record<string, unknown> = {
		model: "glm-5.3",
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 4096,
		thinking: { type: "enabled", clear_thinking: false },
		reasoning_effort: "high",
		messages: [
			{ role: "user", content: def.prompt },
		],
		tools: [
			{
				type: "function",
				function: {
					name: TOOL_NAME,
					description: "派发一个任务。必须根据用户指令构造参数并调用。",
					parameters: def.schema,
				},
			},
		],
	};
	if (def.toolStream) body.tool_stream = true;

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	});

	console.log(`\n=== ${def.name} (HTTP ${res.status}) ===`);
	if (!res.ok || !res.body) {
		console.log("请求失败:", res.status, (await res.text()).slice(0, 300));
		return;
	}

	const sseLines: string[] = [];
	let argChunkCount = 0;
	let argCharCount = 0;
	let nameChunkCount = 0;
	const ids = new Set<string>();
	let finishReason: string | undefined;
	let usage: unknown;
	let otherToolCallShapes: string[] = [];

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			sseLines.push(payload);
			if (payload === "[DONE]") continue;
			try {
				const chunk = JSON.parse(payload);
				if (chunk.usage) usage = chunk.usage;
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				if (choice.finish_reason) finishReason = choice.finish_reason;
				const delta = choice.delta;
				if (!delta) continue;
				// 统计一切 tool call 形态（标准与非标准）
				const shapes = [
					...(Array.isArray(delta.tool_calls) ? delta.tool_calls : delta.tool_calls ? [delta.tool_calls] : []),
				];
				for (const tc of shapes as Array<Record<string, unknown>>) {
					if (typeof tc.id === "string" && tc.id) ids.add(tc.id);
					const fn = tc.function as Record<string, unknown> | undefined;
					if (fn) {
						if (typeof fn.name === "string" && fn.name) nameChunkCount++;
						if (typeof fn.arguments === "string") {
							argChunkCount++;
							argCharCount += fn.arguments.length;
						}
					}
					if (!fn) otherToolCallShapes.push(JSON.stringify(tc).slice(0, 200));
				}
				// 捕获非标准位置（如 delta.reasoning_content 之外的 tool 形态）
				for (const k of Object.keys(delta)) {
					if (k !== "tool_calls" && k !== "content" && k !== "reasoning_content" && !otherToolCallShapes.includes(k)) {
						otherToolCallShapes.push(`delta.${k}`);
					}
				}
			} catch {
				sseLines.push(`<<parse-error: ${payload.slice(0, 120)}>>`);
			}
		}
	}

	writeFileSync(join(outDir, `${def.name}.sse.txt`), sseLines.join("\n"), "utf8");
	console.log(`arguments 分片数: ${argChunkCount}, 累计字符: ${argCharCount}`);
	console.log(`name 分片数: ${nameChunkCount}, tool call ids: ${[...ids].join(", ") || "(无)"}`);
	console.log(`finish_reason: ${finishReason ?? "(未出现)"}`);
	console.log(`usage: ${JSON.stringify(usage)}`);
	if (otherToolCallShapes.length) console.log(`非标准形态/字段: ${otherToolCallShapes.slice(0, 8).join(" ; ")}`);
	console.log(`原始 SSE 已落盘: var/diagnostics/zai-tool-stream/${def.name}.sse.txt`);
}

const only = process.argv[2];
for (const def of cases) {
	if (only && !def.name.startsWith(only)) continue;
	await runCase(def);
}
console.log("\n完成。");
