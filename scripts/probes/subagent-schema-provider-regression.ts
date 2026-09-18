#!/usr/bin/env node
/**
 * 回归探针：拍平后的生产 TYPED_SUBAGENT_PARAMETERS 在真实 provider 上的参数生成。
 *
 * 用途：docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md 修复后的
 * provider 回归验证。直接 import 生产 schema（packages/pi-subagents-enhanced），
 * 与旧顶层 anyOf 形态对照，确认：
 *   - zai-coding-cn/glm-5.3 拍平后生成完整 arguments（修复生效）
 *   - deepseek 拍平后仍正常（历史上 deepseek 对根节点形态最敏感）
 *
 * 用法：node scripts/probes/subagent-schema-provider-regression.ts [zai|deepseek|all] [modelId]
 * 凭据从 pi/auth.json 间接读取，不打印。原始 SSE 落盘 var/diagnostics/subagent-schema-regression/。
 * 旧顶层联合形态的故障复现由 zai-tool-stream-diagnostic.ts 的 B/C/E/F 案覆盖，
 * 本探针只验证拍平后的生产 schema 回归。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// 生产 schema：直接从源码加载，保证与注册到 Host 的形态完全一致。
const { TYPED_SUBAGENT_PARAMETERS } = await import(
	new URL("../../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts", import.meta.url).href
);

const configHome = process.env.PI_CONFIG_HOME;
if (!configHome) throw new Error("需要 PI_CONFIG_HOME 环境变量");
const auth = JSON.parse(readFileSync(join(configHome, "pi/auth.json"), "utf8"));
const store = JSON.parse(readFileSync(join(configHome, "pi/models-store.json"), "utf8"));

const outDir = join(configHome, "var/diagnostics/subagent-schema-regression");
mkdirSync(outDir, { recursive: true });

// 旧顶层联合形态（修复前），仅作故障对照。
const legacyUnionSchema = undefined; // 旧形态内层已拍平，对照改由 zai-tool-stream-diagnostic 承担。

const TOOL_NAME = "spawn_task";
const PROMPT = `请立即调用 ${TOOL_NAME} 工具派发 coding 任务，参数要求：version 为 dispatch-ir.v1，taskId 为 regression-1，title 为 回归验证，agent 为 executor，risk 为 low，objective 为 验证生产schema参数生成，workflow 为 {"mode":"tdd"}，requirements 为 ["生成完整参数"]，context 为 {"knownFacts":["f"],"decisions":["d"],"relevantFiles":["src/a.ts"]}，boundaries 为 {"writePaths":["src/"],"excludedWork":["无"],"forbiddenActions":["不提交"]}，acceptance 为 {"criteria":["参数完整"]}，execution 为 {"worktree":false}。不要输出多余文字。`;

interface ProviderCase {
	providerKey: string;
	modelId: string;
	apiKey: string;
	baseUrl: string;
}

function resolveProvider(providerKey: string, modelId?: string): ProviderCase {
	const provider = store[providerKey];
	if (!provider?.models?.length) throw new Error(`models-store 缺少 ${providerKey}`);
	const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0];
	const authEntry = auth[providerKey];
	if (!authEntry?.key) throw new Error(`auth.json 缺少 ${providerKey} key`);
	return { providerKey, modelId: model.id, apiKey: authEntry.key, baseUrl: model.baseUrl };
}

async function runCase(provider: ProviderCase, schemaName: string, schema: unknown): Promise<void> {
	const caseName = `${provider.providerKey}-${schemaName}`;
	const body = {
		model: provider.modelId,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 4096,
		messages: [{ role: "user", content: PROMPT }],
		tools: [{ type: "function", function: { name: TOOL_NAME, description: "派发一个任务。", parameters: schema } }],
	};
	const res = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify(body),
	});
	console.log(`\n=== ${caseName} (HTTP ${res.status}, model ${provider.modelId}) ===`);
	if (!res.ok || !res.body) {
		console.log("请求失败:", (await res.text()).slice(0, 300));
		return;
	}
	const sseLines: string[] = [];
	let argChars = 0;
	let argChunks = 0;
	let finishReason: string | undefined;
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
			if (!payload || payload === "[DONE]") continue;
			sseLines.push(payload);
			try {
				const chunk = JSON.parse(payload);
				const choice = chunk.choices?.[0];
				if (choice?.finish_reason) finishReason = choice.finish_reason;
				for (const tc of choice?.delta?.tool_calls ?? []) {
					const args = tc.function?.arguments;
					if (typeof args === "string") {
						argChunks++;
						argChars += args.length;
					}
				}
			} catch { /* 非标准分片保留在落盘文件中人工分析 */ }
		}
	}
	writeFileSync(join(outDir, `${caseName}.sse.txt`), sseLines.join("\n"), "utf8");
	console.log(`arguments 分片 ${argChunks} 个 / 累计 ${argChars} 字符；finish=${finishReason ?? "?"}`);
	console.log(argChars > 10 ? "✅ 完整参数生成" : "❌ 空参数/截断");
}

const which = process.argv[2] ?? "all";
const modelOverride = process.argv[3];
const providers: string[] = which === "all" ? ["zai-coding-cn", "deepseek"] : [which === "zai" ? "zai-coding-cn" : which];
for (const key of providers) {
	const provider = resolveProvider(key, modelOverride);
	await runCase(provider, "flattened-production", TYPED_SUBAGENT_PARAMETERS);
}
console.log("\n完成。");
