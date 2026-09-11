import { realpath } from "node:fs/promises";
import path from "node:path";

import { assertRunAuthorization, type RunAuthorization } from "./run-authorization.ts";

export type DispatchIsolation = "shared" | "managed-workspace";

export type HostExecutionGrant = {
  rootSessionId: string;
  allowedProfiles: readonly [string, ...string[]];
  originRoot: string;
  cwdRoot: string;
  isolation: DispatchIsolation;
  authorization: Readonly<RunAuthorization>;
};

export type UntrustedDispatchRequest = {
  agent: string;
  cwd?: string;
  isolation?: DispatchIsolation;
  worktree?: boolean;
  model?: string;
  prompt?: string;
};

const AUTHORIZED_DISPATCH: unique symbol = Symbol("authorized-dispatch");

/** 仅供内部深层模块调用；不导出到 package entry，brand 只能由本模块的私有 symbol 验证。 */
export function assertAuthorizedDispatch(value: unknown): asserts value is AuthorizedDispatch {
  if (!isPlainObject(value)) fail("dispatch must be a Host-authorized envelope");
  const brand = Object.getOwnPropertySymbols(value).find((symbol) => symbol === AUTHORIZED_DISPATCH);
  if (!brand || (value as Record<symbol, unknown>)[brand] !== true || !isPlainObject(value.request) || !isPlainObject(value.authorization)) {
    fail("dispatch must be a Host-authorized envelope");
  }
}

export type AuthorizedDispatch = Readonly<{
  request: Readonly<{
    agent: string;
    cwd: string;
    isolation: DispatchIsolation;
    model?: string;
    prompt?: string;
  }>;
  authorization: Readonly<RunAuthorization>;
}> & { readonly [AUTHORIZED_DISPATCH]: true };

const GRANT_KEYS = ["rootSessionId", "allowedProfiles", "originRoot", "cwdRoot", "isolation", "authorization"];
const REQUEST_KEYS = ["agent", "cwd", "isolation", "worktree", "model", "prompt"];
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

function fail(message: string): never {
  throw new Error(`Dispatch execution contract is invalid: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be an exact object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} contains an unknown authority field`);
}

function profile(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || CONTROL_CHARACTER.test(value) || Buffer.byteLength(value, "utf8") > 256) {
    fail(`${label} must be a bounded profile identity`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return value;
}

function isolation(value: unknown, label: string): DispatchIsolation {
  if (value !== "shared" && value !== "managed-workspace") fail(`${label} must be shared or managed-workspace`);
  return value;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function canonicalPath(value: unknown, label: string): Promise<string> {
  try {
    return await realpath(absolutePath(value, label));
  } catch {
    fail(`${label} must resolve to an existing canonical path`);
  }
}

async function managedStateRoot(): Promise<string | null> {
  const configured = process.env.PI_CODING_WORKSPACE_DIR;
  return configured === undefined ? null : canonicalPath(configured, "PI_CODING_WORKSPACE_DIR");
}

async function normalizeGrant(value: unknown): Promise<Readonly<HostExecutionGrant>> {
  assertAllowedKeys(value, GRANT_KEYS, "Host grant");
  if (Object.keys(value).length !== GRANT_KEYS.length) fail("Host grant contains missing fields");
  const rootSessionId = profile(value.rootSessionId, "Host grant rootSessionId");
  if (!Array.isArray(value.allowedProfiles) || value.allowedProfiles.length === 0) fail("Host grant allowedProfiles must be non-empty");
  const allowedProfiles = value.allowedProfiles.map((entry, index) => profile(entry, `Host grant allowedProfiles[${index}]`));
  if (new Set(allowedProfiles).size !== allowedProfiles.length) fail("Host grant allowedProfiles must not contain duplicates");
  const [originRoot, cwdRoot] = await Promise.all([
    canonicalPath(value.originRoot, "Host grant originRoot"),
    canonicalPath(value.cwdRoot, "Host grant cwdRoot"),
  ]);
  if (!contains(originRoot, cwdRoot)) fail("Host grant cwdRoot must be confined to originRoot");
  const grantIsolation = isolation(value.isolation, "Host grant isolation");
  assertRunAuthorization(value.authorization);
  if (value.authorization.binding.sessionId !== rootSessionId) fail("Host grant root session must match authorization binding");
  return deepFreeze({
    rootSessionId,
    allowedProfiles: allowedProfiles as [string, ...string[]],
    originRoot,
    cwdRoot,
    isolation: grantIsolation,
    authorization: value.authorization,
  });
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function requestedIsolation(value: Record<string, unknown>, grantIsolation: DispatchIsolation): DispatchIsolation {
  const fromIsolation = value.isolation === undefined ? undefined : isolation(value.isolation, "request isolation");
  let fromWorktree: DispatchIsolation | undefined;
  if (value.worktree !== undefined) {
    if (typeof value.worktree !== "boolean") fail("request worktree must be a boolean");
    fromWorktree = value.worktree ? "managed-workspace" : "shared";
  }
  if (fromIsolation && fromWorktree && fromIsolation !== fromWorktree) fail("request isolation and worktree conflict");
  const effective = fromIsolation ?? fromWorktree ?? grantIsolation;
  if (grantIsolation === "managed-workspace" && effective !== "managed-workspace") fail("request cannot downgrade managed-workspace isolation to shared");
  return effective;
}

export async function createAuthorizedDispatch(input: unknown, hostGrant: unknown): Promise<AuthorizedDispatch> {
  assertAllowedKeys(input, REQUEST_KEYS, "dispatch request");
  if (typeof input.agent !== "string") fail("dispatch request agent must be a string");
  const grant = await normalizeGrant(hostGrant);
  const agent = profile(input.agent, "dispatch request agent");
  if (!grant.allowedProfiles.includes(agent)) fail("dispatch request agent is not an allowed profile");
  const cwd = input.cwd === undefined ? grant.cwdRoot : await canonicalPath(input.cwd, "dispatch request cwd");
  if (!contains(grant.cwdRoot, cwd)) fail("dispatch request cwd escapes the Host cwd confinement");
  const stateRoot = await managedStateRoot();
  if (stateRoot && contains(stateRoot, cwd)) fail("dispatch request cwd cannot be inside the managed state root");
  const model = optionalString(input.model, "dispatch request model");
  const prompt = optionalString(input.prompt, "dispatch request prompt");
  const request = {
    agent,
    cwd,
    isolation: requestedIsolation(input, grant.isolation),
    ...(model === undefined ? {} : { model }),
    ...(prompt === undefined ? {} : { prompt }),
  };
  return deepFreeze({ request, authorization: grant.authorization, [AUTHORIZED_DISPATCH]: true }) as AuthorizedDispatch;
}
