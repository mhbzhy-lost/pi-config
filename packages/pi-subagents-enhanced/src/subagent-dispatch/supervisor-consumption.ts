import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { supervisorCanonicalDigest } from './supervisor-control-plane.ts';
import { captureProcessBirthIdentity } from './process-birth-identity.ts';
import type { RootBrokerServer } from './root-broker-server.ts';

function checkedText(file: string, maximum: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.uid !== process.getuid?.()) throw new Error('SUPERVISOR_CONSUMPTION_FILE_INVALID');
    const text = readFileSync(fd, 'utf8');
    const after = lstatSync(file);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('SUPERVISOR_CONSUMPTION_FILE_CHANGED');
    return text;
  } finally { closeSync(fd); }
}
function inside(root: string, file: string): boolean { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }

function trustedSessionFile(binding: {sessionId: string}, physical: string): boolean {
  const temporaryRoot = realpathSync(tmpdir());
  if (inside(temporaryRoot,physical) && path.relative(temporaryRoot,physical).split(path.sep)[0].startsWith('pi-subagent-session-')) return true;
  if (!path.isAbsolute(binding.sessionId) || !binding.sessionId.endsWith('.jsonl')) return false;
  const derivedRoot = binding.sessionId.slice(0,-'.jsonl'.length);
  try { return inside(realpathSync(derivedRoot), physical); } catch { return false; }
}

export async function captureSupervisorCorrelation(broker: RootBrokerServer, native: any) {
  const owned = broker.inspectExecutionProof(native.runId);
  const binding = owned?.binding ?? broker.facadeRuns.get(native.runId);
  if (!binding) throw new Error('SUPERVISOR_CORRELATION_BINDING_MISSING');
  const status = JSON.parse(checkedText(path.join(binding.asyncDir, 'status.json'), 4 * 1024 * 1024));
  if (status.runId !== native.runId || status.pid !== binding.pid || status.sessionId !== binding.sessionId || !Number.isSafeInteger(native.childIndex)) throw new Error('SUPERVISOR_CORRELATION_RUN_MISMATCH');
  const step = status.steps?.[native.childIndex];
  if (!step || step.agent !== native.agent || typeof step.sessionFile !== 'string') throw new Error('SUPERVISOR_CORRELATION_CHILD_MISMATCH');
  const physical = realpathSync(step.sessionFile);
  const temporaryRoot = realpathSync(tmpdir());
  if (!trustedSessionFile(binding,physical)) throw new Error('SUPERVISOR_CORRELATION_SESSION_OUTSIDE');
  const text = checkedText(step.sessionFile, 64 * 1024 * 1024);
  const manager = SessionManager.open(physical);
  if (text !== checkedText(step.sessionFile, 64 * 1024 * 1024) || realpathSync(manager.getCwd()) !== realpathSync(status.cwd)) throw new Error('SUPERVISOR_CORRELATION_SESSION_CHANGED');
  const entries = manager.getEntries();
  const completed = new Set(entries.filter(e=>e.type==='message' && e.message.role==='toolResult').map((e:any)=>e.message.toolCallId));
  const calls = entries.filter(e => e.type === 'message' && e.message.role === 'assistant').flatMap((e:any) => e.message.content).filter(c => c.type === 'toolCall' && c.name === 'contact_supervisor' && !completed.has(c.id) && c.arguments?.reason === native.reason && (c.arguments.message?.trim() ?? '') === native.requestBody);
  if (calls.length !== 1) throw new Error('SUPERVISOR_CORRELATION_CALL_AMBIGUOUS');
  return { asyncDir: binding.asyncDir, pid: binding.pid, lifecycleSessionId: binding.sessionId, processBirth: await captureProcessBirthIdentity(binding.pid), sessionFile: physical, childSessionId: manager.getSessionId(), toolCallId: calls[0].id, agent: native.agent, childIndex: native.childIndex, reason: native.reason, requestBodyDigest: supervisorCanonicalDigest(native.requestBody) };
}

/** 只观察已由Root Broker接受的终局与其canonical会话；不依据输出文本或终局成功猜测消费。 */
export async function reconcileSupervisorConsumption(input: { broker: RootBrokerServer; plane: any; runId: string; rootSessionId: string; diagnosticSink?: (value: unknown) => void }) {
  const { broker, plane, runId, rootSessionId } = input;
  const owned = broker.inspectExecutionProof(runId);
  const facade = broker.inspectFacadeTerminalProof(runId);
  const proof = owned?.terminal?.proof ?? facade?.proof;
  const conflict = owned?.terminalConflict ?? facade?.conflict;
  const binding = owned?.binding ?? broker.facadeRuns.get(runId);
  if (!binding || !proof || conflict || proof.state !== 'observed') return { observed: 0 };
  const status = JSON.parse(checkedText(path.join(binding.asyncDir, 'status.json'), 4 * 1024 * 1024));
  if (status.runId !== runId || status.pid !== binding.pid || status.sessionId !== binding.sessionId || status.processTerminal?.runnerProcessInstanceId !== proof.runnerProcessInstanceId || status.processTerminal?.observedAt !== proof.observedAt) throw new Error('SUPERVISOR_CONSUMPTION_RUN_MISMATCH');
  const descriptor = JSON.parse(checkedText(path.join(binding.asyncDir, 'recovery-descriptor.json'), 4 * 1024 * 1024));
  if (descriptor.sourceRunId !== runId || descriptor.sessionFile !== status.sessionFile || descriptor.cwd !== status.cwd) throw new Error('SUPERVISOR_CONSUMPTION_DESCRIPTOR_MISMATCH');
  const sessionFile = status.sessionFile;
  if (typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile)) throw new Error('SUPERVISOR_CONSUMPTION_SESSION_INVALID');
  const temporaryRoot = realpathSync(tmpdir());
  const physical = realpathSync(sessionFile);
  const rel = path.relative(temporaryRoot, physical);
  if (!trustedSessionFile(binding,physical)) throw new Error('SUPERVISOR_CONSUMPTION_SESSION_OUTSIDE');
  // 官方公开SessionManager解析同一稳定文件，前后hash检查阻止路径交换或修改。
  const before = checkedText(sessionFile, 64 * 1024 * 1024);
  const manager = SessionManager.open(physical);
  const after = checkedText(sessionFile, 64 * 1024 * 1024);
  if (before !== after || realpathSync(manager.getCwd()) !== realpathSync(status.cwd)) throw new Error('SUPERVISOR_CONSUMPTION_SESSION_CHANGED');
  const entries = manager.getEntries();
  const calls = new Map<string, any>();
  let observed = 0;
  let timedOut = false;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message: any = entry.message;
    if (message.role === 'assistant') for (const call of message.content) if (call.type === 'toolCall' && call.name === 'contact_supervisor') calls.set(call.id, call);
    if (message.role !== 'toolResult' || message.toolName !== 'contact_supervisor') continue;
    if (message.isError === true) {
      const call = calls.get(message.toolCallId);
      if (call && ['need_decision', 'interview_request'].includes(call.arguments?.reason) && message.content?.length === 1 && message.content[0]?.text === 'Timed out waiting for supervisor reply.' && message.timestamp <= proof.observedAt) timedOut = true;
      continue;
    }
    if (message.isError !== false) continue;
    const requestId = message.details?.requestId;
    const call = calls.get(message.toolCallId);
    const reason = message.details?.reason;
    if (!call || call.arguments?.reason !== reason || !['need_decision', 'interview_request'].includes(reason) || typeof requestId !== 'string') continue;
    const request = await plane.findRequestAsync(requestId, rootSessionId);
    if (!request || request.runId !== runId || !request.correlation || request.correlation.sessionFile !== physical || request.correlation.childSessionId !== manager.getSessionId() || request.correlation.toolCallId !== message.toolCallId || request.correlation.reason !== reason || request.correlation.agent !== descriptor.agent || request.correlation.requestBodyDigest !== supervisorCanonicalDigest(call.arguments.message?.trim() ?? '') || !Number.isFinite(message.timestamp) || message.timestamp < request.createdAt || message.timestamp > proof.observedAt) continue;
    const content = message.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || !content[0].text.startsWith('**Reply from supervisor:**\n')) continue;
    const reply = content[0].text.slice('**Reply from supervisor:**\n'.length);
    const result = await plane.observeReplyConsumption({ runId, requestId, payloadDigest: supervisorCanonicalDigest(reply) }, rootSessionId);
    if (result.status === 'committed' || (result.status === 'idempotent' && result.receipt?.consumed === true)) observed++;
    else input.diagnosticSink?.({ phase: 'supervisor-consumption-rejected', runId, requestId, code: result.code });
  }
  if (timedOut) await plane.expireTerminalRequests(runId, rootSessionId);
  else if (["stopped", "failed"].includes(status.state)) await plane.expireTerminalRequests(runId, rootSessionId, "failed");
  return { observed };
}
