import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PROVIDER = 'qwen-token-plan-cn';
const MAX_429_RETRIES = 1;

type ProviderError = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  error?: unknown;
  message?: unknown;
  errorMessage?: unknown;
};

function contains429(value: unknown): boolean {
  if (typeof value === 'number') return value === 429;
  if (typeof value === 'string') return /(?:^|\D)429(?:\D|$)/.test(value);
  if (!value || typeof value !== 'object') return false;
  const error = value as ProviderError;
  return [error.status, error.statusCode, error.code].some(contains429)
    || contains429(error.error)
    || contains429(error.message)
    || contains429(error.errorMessage);
}

function is429Result(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const message = result as ProviderError;
  return contains429(message)
    || contains429(message.error)
    || contains429(message.errorMessage);
}

// 429 拒答只可能出现在「还没有任何内容」的阶段。因此在产生首个内容事件之前先把事件
// 暂存：确认不是 429 立刻按序转发，随后的增量事件继续直通，流式不受影响；若这一段以
// 429 结束则整段丢弃并重试，不把已失效的 start/error 片段写给调用方。
function gatesStream(event: any): boolean {
  return event?.type === 'start' || event?.type === 'error';
}

async function forwardAttempt(model: any, context: any, options: any, output: any): Promise<{ result: any; retryable: boolean }> {
  const stream = streamSimpleOpenAICompletions(model, context, options);
  const buffered: any[] = [];
  let committed = false;
  for await (const event of stream) {
    if (committed) {
      output.push(event);
      continue;
    }
    buffered.push(event);
    if (gatesStream(event)) continue;
    committed = true;
    for (const pending of buffered) output.push(pending);
    buffered.length = 0;
  }
  const result = await stream.result();
  const retryable = !committed && is429Result(result);
  if (!retryable) for (const pending of buffered) output.push(pending);
  return { result, retryable };
}

export default function tokenPlanRetryExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    // 只覆盖 tokenplan 的请求实现，模型目录、baseUrl、认证仍沿用内置 provider。
    // "api" 是注册 streamSimple 的必填字段，同时决定 hook 只对该 api 的模型生效。
    api: 'openai-completions',
    streamSimple(model: any, context: any, options: any = {}) {
      const output = createAssistantMessageEventStream();
      const run = async () => {
        let result: any;
        for (let retry = 0; ; retry += 1) {
          const attempt = await forwardAttempt(model, context, options, output);
          result = attempt.result;
          if (!attempt.retryable || retry >= MAX_429_RETRIES || options.signal?.aborted) break;
        }
        return result;
      };
      void run().then((result) => {
        output.end(result);
      }).catch(error => {
        output.end({
          role: 'assistant',
          content: [],
          stopReason: options.signal?.aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          api: model.api,
          provider: model.provider,
          model: model.id,
        });
      });
      return output;
    },
  });
}
