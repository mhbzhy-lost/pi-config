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

async function collectAttempt(model: any, context: any, options: any): Promise<{ events: any[]; result: any }> {
  const stream = streamSimpleOpenAICompletions(model, context, options);
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function replay(events: any[], result: any) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) output.push(event);
    output.end(result);
  });
  return output;
}

export default function tokenPlanRetryExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    // 只覆盖 tokenplan 的请求实现，模型目录、baseUrl、认证仍沿用内置 provider。
    streamSimple(model: any, context: any, options: any = {}) {
      const run = async () => {
        let attempt = await collectAttempt(model, context, options);
        for (let retry = 0; retry < MAX_429_RETRIES && is429Result(attempt.result); retry += 1) {
          if (options.signal?.aborted) break;
          attempt = await collectAttempt(model, context, options);
        }
        return replay(attempt.events, attempt.result);
      };
      const output = createAssistantMessageEventStream();
      void run().then(async stream => {
        for await (const event of stream) output.push(event);
        output.end(await stream.result());
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
