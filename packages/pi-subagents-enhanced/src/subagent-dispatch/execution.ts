import { compileGenericPrompt, renderGenericPrompt, type GenericPromptContract, type CompiledGenericPrompt } from "../contracts/generic-prompt.ts";
import { assertAuthorizedDispatch, type AuthorizedDispatch } from "./execution-contract.ts";

/** Shared execution boundary for all subagent input adapters.
 *
 * Adapters only describe public transport.  Host services provide the actual
 * executor and (when applicable) the managed workspace cwd.  In particular,
 * nested workflow children can never turn a public worktree request into a
 * second worktree.
 */

export type DispatchExecutionRequest = Readonly<{
  agent: string;
  title: string;
  prompt: string;
  cwd: string;
  model?: string;
  contractHash?: string;
}>;

export type DispatchExecutionDependencies = Readonly<{
  execute: (request: Readonly<DispatchExecutionRequest & { worktree: false }>) => unknown | Promise<unknown>;
  workspace?: Readonly<{ dispatchCwd?: string }>;
  authorizedDispatch: AuthorizedDispatch;
}>;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRequest(value: unknown): asserts value is DispatchExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("dispatch execution request must be an object");
  const request = value as Record<string, unknown>;
  for (const key of ["agent", "title", "prompt", "cwd"]) {
    if (!nonempty(request[key])) throw new TypeError(`dispatch execution ${key} must be non-empty`);
  }
  if (request.contractHash !== undefined && !/^[a-f0-9]{64}$/.test(String(request.contractHash))) {
    throw new TypeError("dispatch execution contractHash must be a SHA-256 hash");
  }
}

export async function dispatchExecution(
  request: DispatchExecutionRequest,
  dependencies: DispatchExecutionDependencies,
): Promise<any> {
  assertRequest(request);
  if (!dependencies || typeof dependencies.execute !== "function") throw new TypeError("dispatch execution requires an execute service");
  assertAuthorizedDispatch(dependencies.authorizedDispatch);
  const managedCwd = dependencies.workspace?.dispatchCwd;
  const effective = {
    ...request,
    authorizedDispatch: dependencies.authorizedDispatch,
    ...(nonempty(managedCwd) ? { cwd: managedCwd } : {}),
    worktree: false as const,
  };
  return dependencies.execute(Object.freeze(effective));
}

export function createGenericDispatchAdapter(input: Readonly<{
  agent: string; title: string; prompt: GenericPromptContract | CompiledGenericPrompt; cwd: string; model?: string;
}>): DispatchExecutionRequest {
  if (input && ["authorization", "authorizedDispatch", "capability", "goal", "ticket"].some((key) => Object.hasOwn(input, key))) {
    throw new TypeError("generic public dispatch cannot provide authority");
  }
  if (!input || !input.prompt) throw new TypeError("generic dispatch prompt contract is required");
  const { hash: _ignoredHash, ...promptInput } = input.prompt as GenericPromptContract & { hash?: string };
  const prompt = compileGenericPrompt(promptInput);
  return Object.freeze({
    agent: input.agent,
    title: input.title,
    prompt: renderGenericPrompt(prompt),
    cwd: input.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
  });
}

export function createCodingDispatchAdapter(input: Readonly<{
  agent: string; prompt: string; cwd: string; contractHash: string; title?: string; model?: string;
}>): DispatchExecutionRequest {
  if (input && ["authorization", "authorizedDispatch", "capability", "goal", "ticket"].some((key) => Object.hasOwn(input, key))) {
    throw new TypeError("coding public dispatch cannot provide authority");
  }
  if (!input || !nonempty(input.prompt)) throw new TypeError("coding dispatch prompt must be non-empty");
  return Object.freeze({
    agent: input.agent,
    title: input.title ?? "Coding dispatch",
    prompt: input.prompt,
    cwd: input.cwd,
    contractHash: input.contractHash,
    ...(input.model === undefined ? {} : { model: input.model }),
  });
}
