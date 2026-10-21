import * as path from "node:path";
import { classifySubagentChildPresentation, type SubagentPresentationStatus } from "../subagent-dispatch/presentation-status.ts";
import { readBrowserRunStatus } from "./browser-adapter.ts";

export interface BrowserChild {
  key: string;
  runId: string;
  index: number;
  agent: string;
  state: string;
  presentation?: SubagentPresentationStatus;
  asyncDir: string;
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  label?: string;
  transcriptPath?: string;
  model?: string;
  thinking?: string;
  tokens?: number;
  runMode?: "single" | "workflow";
  facadeLeafRunId?: string;
  parentWorkflowRunId?: string;
  workflowKey?: string;
}

export interface BrowserSnapshot {
  active: boolean;
  selectedKey?: string;
  children: BrowserChild[];
  activeChildren: BrowserChild[];
  recentChildren: BrowserChild[];
  selected?: BrowserChild;
}

export interface BrowserRosterPersistence {
  version: 1;
  children: BrowserChild[];
}

/**
 * child 模型展示标签（纯 TUI 投影，不改写 raw status）。
 * 两个消费方共用同一格式：subagent footer 的 child 分支（footer-runtime，standalone/
 * fallback 路径）与行投影 `ActivityRow.metaLabel`（subagent-activity → presenter 的
 * 详情 footer 首行）。不写回任何 raw/session 数据。
 */
export function formatChildModelLabel(model: string | undefined, thinking: string | undefined): string {
  if (!model) return "no-model";
  const suffix = thinking && model.endsWith(`:${thinking}`) ? `:${thinking}` : "";
  const normalized = suffix ? model.slice(0, -suffix.length) : model;
  const slash = normalized.indexOf("/");
  return slash > 0 ? `(${normalized.slice(0, slash)}) ${normalized.slice(slash + 1)}` : normalized;
}

type BrowserRun = {
  id: string;
  asyncDir: string;
  cwd: string;
  sessionId?: string;
  children: BrowserChild[];
};

type RecordValue = Record<string, unknown>;

const RECENT_RUN_LIMIT = 20;

// 旧版状态仍作为无协商信息时的最小投影；未知状态不得推断为终局。
const ACTIVE_STATES = new Set(["active", "queued", "running", "pending", "retained"]);
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "paused", "stopped", "rejected", "detached", "timed-out", "terminal", "terminal-proof"]);
const PRESENTATION_STATUSES = new Set<SubagentPresentationStatus>(["running", "completed", "reported", "needs-context", "limited", "paused", "stopped", "runtime-failed"]);

type StateClassification = "active" | "terminal" | "awaiting-disposition";

export interface SessionStatusProjection {
  classification: StateClassification;
  status?: string;
  raw: unknown;
}

type StatusProjectionSchema = Record<string, unknown>;

function statusFromRaw(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (!isRecord(raw)) return undefined;
  return stringValue(raw.status) ?? stringValue(raw.state);
}

function projectionSchemas(negotiated: unknown): StatusProjectionSchema[] {
  if (!isRecord(negotiated)) return [];
  const candidates: unknown[] = [
    negotiated.statusProjection,
    isRecord(negotiated.capabilities) ? negotiated.capabilities.statusProjection : undefined,
    isRecord(negotiated.raw) && isRecord(negotiated.raw.capabilities)
      ? negotiated.raw.capabilities.statusProjection : undefined,
  ];
  return candidates.filter(isRecord);
}

function schemaStates(schema: StatusProjectionSchema, names: string[]): Set<string> {
  const states = new Set<string>();
  for (const name of names) {
    const value = schema[name];
    if (Array.isArray(value)) {
      for (const candidate of value) if (typeof candidate === "string") states.add(candidate.toLowerCase());
    }
  }
  return states;
}

export function projectSessionStatus(negotiated: unknown, raw: unknown): SessionStatusProjection {
  const status = statusFromRaw(raw);
  if (!status) return { classification: "awaiting-disposition", raw };
  const normalized = status.toLowerCase();

  for (const schema of projectionSchemas(negotiated)) {
    if (schemaStates(schema, ["active", "activeStates"]).has(normalized)) {
      return { classification: "active", status, raw };
    }
    if (schemaStates(schema, ["terminal", "terminalStates"]).has(normalized)) {
      return { classification: "terminal", status, raw };
    }
    if (schemaStates(schema, ["awaitingDisposition", "awaiting-disposition", "awaitingDispositionStates"]).has(normalized)) {
      return { classification: "awaiting-disposition", status, raw };
    }
  }

  if (ACTIVE_STATES.has(normalized)) return { classification: "active", status, raw };
  if (TERMINAL_STATES.has(normalized)) return { classification: "terminal", status, raw };
  return { classification: "awaiting-disposition", status, raw };
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runModeValue(value: unknown): BrowserChild["runMode"] {
  return value === "single" || value === "workflow" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function classifyState(state: string | undefined): StateClassification {
  return projectSessionStatus(undefined, state).classification;
}

function isTerminalState(state: string | undefined): boolean {
  return classifyState(state) === "terminal";
}

// typed 派发的 root facade step 携带 leaf runId（steps 自身不携带 model/tokens，
// 数据在邻接 leaf run 的 status.json）。解析必须经 readBrowserRunStatus 防线，
// 且路径限定在 path.dirname(asyncDir) 的直接子目录（邻接 runs 根）。
function adjacentFacadeLeafStep(asyncDir: string, step: RecordValue): RecordValue | undefined {
  const leafRunId = stringValue(step.runId);
  if (!leafRunId) return undefined;
  const runsRoot = path.dirname(asyncDir);
  const leafAsyncDir = path.join(runsRoot, leafRunId);
  if (path.dirname(leafAsyncDir) !== runsRoot) return undefined;
  const leafStatus = readBrowserRunStatus(leafAsyncDir);
  if (!isRecord(leafStatus) || !Array.isArray(leafStatus.steps)) return undefined;
  for (const leafStep of leafStatus.steps) {
    if (isRecord(leafStep)) return leafStep;
  }
  return undefined;
}

export class SubagentSessionBrowserState {
  private readonly runs = new Map<string, BrowserRun>();
  private active = false;
  private selectedKey?: string;

  static hydrate(value: unknown): SubagentSessionBrowserState {
    const state = new SubagentSessionBrowserState();
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.children)) return state;
    for (const candidate of value.children) {
      if (!isRecord(candidate)) continue;
      const runId = stringValue(candidate.runId);
      const key = stringValue(candidate.key);
      const agent = stringValue(candidate.agent);
      const asyncDir = stringValue(candidate.asyncDir);
      const cwd = stringValue(candidate.cwd);
      const index = numberValue(candidate.index);
      if (!runId || !key || !agent || !asyncDir || !cwd || index === undefined || key !== `${runId}:${index}`) continue;
      const persistedPresentation = stringValue(candidate.presentation);
      const presentation = persistedPresentation && PRESENTATION_STATUSES.has(persistedPresentation as SubagentPresentationStatus)
        ? persistedPresentation as SubagentPresentationStatus : undefined;
      const child: BrowserChild = { key, runId, index, agent, state: stringValue(candidate.state) ?? "unknown", asyncDir, cwd, ...(presentation ? { presentation } : {}) };
      for (const field of ["sessionId", "sessionFile", "label", "transcriptPath", "model", "thinking", "facadeLeafRunId", "parentWorkflowRunId", "workflowKey"] as const) {
        const fieldValue = stringValue(candidate[field]);
        if (fieldValue) child[field] = fieldValue;
      }
      const mode = runModeValue(candidate.runMode);
      if (mode) child.runMode = mode;
      const tokens = numberValue(candidate.tokens);
      if (tokens !== undefined) child.tokens = tokens;
      const sessionId = stringValue(candidate.sessionId);
      const run = state.runs.get(runId) ?? { id: runId, asyncDir, cwd, ...(sessionId ? { sessionId } : {}), children: [] };
      if (!run.sessionId && sessionId) run.sessionId = sessionId;
      run.children.push(child);
      state.runs.set(runId, run);
    }
    const runs = [...state.runs.values()];
    state.runs.clear();
    for (const run of runs.filter((run) => !state.isTerminalRun(run))) state.runs.set(run.id, run);
    for (const run of runs.filter((run) => state.isTerminalRun(run)).reverse()) state.runs.set(run.id, run);
    state.trimRuns();
    return state;
  }

  serialize(): BrowserRosterPersistence {
    return { version: 1, children: this.rawChildren().map((child) => ({ ...child })) };
  }

  trackStarted(event: unknown): void {
    if (!isRecord(event)) return;

    const id = stringValue(event.id);
    const asyncDir = stringValue(event.asyncDir);
    const cwd = stringValue(event.cwd);
    if (!id || !asyncDir || !cwd) return;

    const agents = Array.isArray(event.agents)
      ? event.agents.filter((agent): agent is string => typeof agent === "string" && agent.length > 0)
      : [stringValue(event.agent)].filter((agent): agent is string => Boolean(agent));
    if (agents.length === 0) return;

    const sessionId = stringValue(event.sessionId);
    const title = stringValue(event.title);
    const runMode = runModeValue(event.mode);
    const parentWorkflowRunId = stringValue(event.parentWorkflowRunId);
    const workflowKey = stringValue(event.workflowKey);
    const existingRun = this.runs.get(id);
    if (existingRun) {
      if (!existingRun.sessionId && sessionId) existingRun.sessionId = sessionId;
      return;
    }
    const children = agents.map((agent, index): BrowserChild => ({
      key: `${id}:${index}`,
      runId: id,
      index,
      agent,
      state: "running",
      asyncDir,
      cwd,
      ...(sessionId ? { sessionId } : {}),
      ...(title ? { label: title } : {}),
      ...(runMode ? { runMode } : {}),
      ...(parentWorkflowRunId ? { parentWorkflowRunId } : {}),
      ...(workflowKey ? { workflowKey } : {}),
    }));

    this.runs.set(id, { id, asyncDir, cwd, ...(sessionId ? { sessionId } : {}), children });
    this.ensureSelection();
    this.trimRuns();
  }

  reconcileRun(runId: string, status: unknown): void {
    const run = this.runs.get(runId);
    if (!run || !isRecord(status) || !Array.isArray(status.steps)) return;

    const runState = stringValue(status.state);
    const runMode = runModeValue(status.mode) ?? run.children[0]?.runMode;
    const parentWorkflowRunId = stringValue(status.parentWorkflowRunId) ?? run.children[0]?.parentWorkflowRunId;
    const workflowKey = stringValue(status.workflowKey) ?? run.children[0]?.workflowKey;
    if (status.steps.length === 0 && classifyState(runState) === "active") {
      this.ensureSelection();
      return;
    }
    run.children = status.steps.flatMap((step, index) => {
      if (!isRecord(step)) return [];
      const existing = run.children[index];
      const agent = stringValue(step.agent) ?? existing?.agent;
      if (!agent) return [];
      const stepStatus = stringValue(step.status);
      // run 级终局兑底 child 级非终局：root facade 的 step.status 冻结在 detach 时刻的
      // "running"，不能遮蔽容器自身的终局 state。
      const requestedState = isTerminalState(runState) && !isTerminalState(stepStatus)
        ? runState
        : stepStatus ?? runState ?? existing?.state ?? "unknown";
      const state = isTerminalState(existing?.state) && !isTerminalState(requestedState) ? existing.state : requestedState;
      const child: BrowserChild = {
        key: `${runId}:${index}`,
        runId,
        index,
        agent,
        state,
        asyncDir: run.asyncDir,
        cwd: run.cwd,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(existing?.presentation ? { presentation: existing.presentation } : {}),
        ...(runMode ? { runMode } : {}),
        ...(parentWorkflowRunId ? { parentWorkflowRunId } : {}),
        ...(runMode === "single" && workflowKey ? { workflowKey } : {}),
      };
      const label = stringValue(step.label) ?? stringValue(step.title) ?? existing?.label;
      const sessionFile = stringValue(step.sessionFile);
      const transcriptPath = stringValue(step.transcriptPath);
      let model = stringValue(step.model);
      let thinking = stringValue(step.thinking);
      let tokens = isRecord(step.tokens) ? numberValue(step.tokens.total) : undefined;
      if (model === undefined || thinking === undefined || tokens === undefined) {
        const leafStep = adjacentFacadeLeafStep(run.asyncDir, step);
        if (leafStep !== undefined) {
          if (model === undefined) model = stringValue(leafStep.model);
          if (thinking === undefined) thinking = stringValue(leafStep.thinking);
          if (tokens === undefined && isRecord(leafStep.tokens)) tokens = numberValue(leafStep.tokens.total);
        }
      }
      if (runMode === "workflow") {
        const leafRunId = stringValue(step.runId);
        const stepKey = stringValue(step.workflowKey);
        if (leafRunId) child.facadeLeafRunId = leafRunId;
        if (stepKey) child.workflowKey = stepKey;
      }
      if (label) child.label = label;
      if (sessionFile) child.sessionFile = sessionFile;
      if (transcriptPath) child.transcriptPath = transcriptPath;
      if (model) child.model = model;
      if (thinking) child.thinking = thinking;
      if (tokens !== undefined) child.tokens = tokens;
      return [child];
    });
    this.ensureSelection();
    this.trimRuns();
  }

  trackCompleted(event: unknown): void {
    if (!isRecord(event)) return;
    const runId = stringValue(event.runId) ?? stringValue(event.id);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;
    const state = stringValue(event.state) ?? stringValue(event.status) ?? "complete";
    const results = Array.isArray(event.results) ? event.results : [];
    const runTerminal = isTerminalState(state);
    run.children = run.children.map((child) => {
      const result = isRecord(results[child.index]) ? results[child.index] : undefined;
      const resultState = stringValue(result?.status) ?? stringValue(result?.state);
      // root facade 完成事件的逐 child 条目携带 detach 时刻 state:"running"；run 级终局
      // 必须兑底未携带显式终局的 child，否则 root 条目被自己的完成事件锁死。
      const childState = runTerminal && !isTerminalState(resultState) ? state : resultState ?? state;
      return {
        ...child,
        state: isTerminalState(child.state) ? child.state : childState,
        presentation: classifySubagentChildPresentation(result ?? event),
      };
    });
    this.trimRuns();
  }

  enter(): boolean {
    const children = this.children();
    if (children.length === 0) return false;
    this.active = true;
    this.selectedKey = children[0].key;
    return true;
  }

  exit(): void {
    this.active = false;
    this.selectedKey = undefined;
    this.trimRuns();
  }

  move(delta: -1 | 1): void {
    if (!this.active || !this.selectedKey) return;
    const children = this.children();
    const index = children.findIndex((child) => child.key === this.selectedKey);
    if (index < 0 || children.length === 0) {
      this.exit();
      return;
    }
    this.selectedKey = children[(index + delta + children.length) % children.length].key;
    this.trimRuns();
  }

  snapshot(): BrowserSnapshot {
    const children = this.children();
    const activeChildren = this.activeChildren();
    const recentChildren = this.recentChildren();
    const selected = children.find((child) => child.key === this.selectedKey);
    return {
      active: this.active,
      ...(this.selectedKey ? { selectedKey: this.selectedKey } : {}),
      children: children.map((child) => ({ ...child })),
      activeChildren: activeChildren.map((child) => ({ ...child })),
      recentChildren: recentChildren.map((child) => ({ ...child })),
      ...(selected ? { selected: { ...selected } } : {}),
    };
  }

  clear(options?: { preserveRuns?: boolean }): void {
    this.exit();
    if (!options?.preserveRuns) this.runs.clear();
  }

  trackedRuns(): ReadonlyArray<{ id: string; asyncDir: string }> {
    return [...this.runs.values()].map(({ id, asyncDir }) => ({ id, asyncDir }));
  }

  private rawChildren(): BrowserChild[] {
    const runs = [...this.runs.values()];
    return [
      ...runs.filter((run) => !this.isTerminalRun(run)).flatMap((run) => run.children),
      ...runs.filter((run) => this.isTerminalRun(run)).reverse().flatMap((run) => run.children),
    ];
  }

  // 只以完整双向身份确认显示关系；标题、正文和 sessionFile 不参与判断。
  private confirmedFacades(): Map<string, BrowserChild> {
    const confirmed = new Map<string, BrowserChild>();
    for (const root of this.runs.values()) {
      for (const facade of root.children) {
        if (facade.runMode !== "workflow" || !facade.facadeLeafRunId || !facade.workflowKey || !facade.sessionId) continue;
        const leafRun = this.runs.get(facade.facadeLeafRunId);
        if (!leafRun || leafRun.id === root.id || leafRun.children.length !== 1) continue;
        const leaf = leafRun.children[0];
        if (leaf.runMode === "single" && leaf.parentWorkflowRunId === root.id
          && leaf.workflowKey === facade.workflowKey && leaf.sessionId === facade.sessionId
          && leaf.agent === facade.agent) confirmed.set(facade.key, leaf);
      }
    }
    return confirmed;
  }

  private children(): BrowserChild[] {
    const confirmed = this.confirmedFacades();
    return this.rawChildren().filter((child) => !confirmed.has(child.key));
  }

  private activeChildren(): BrowserChild[] {
    return this.children().filter((child) => !this.isTerminalRun(this.runs.get(child.runId)!));
  }

  private recentChildren(): BrowserChild[] {
    return this.children().filter((child) => this.isTerminalRun(this.runs.get(child.runId)!));
  }

  private isTerminalRun(run: BrowserRun): boolean {
    return run.children.every((child) => isTerminalState(child.state));
  }

  private ensureSelection(): void {
    if (!this.active) return;
    const leaf = this.selectedKey ? this.confirmedFacades().get(this.selectedKey) : undefined;
    if (leaf) this.selectedKey = leaf.key;
    if (!this.selectedKey || !this.children().some((child) => child.key === this.selectedKey)) this.exit();
  }

  private trimRuns(): void {
    // 确认过的 root/leaf 共用一个临时无向组件，不保留关系墓碑。
    const edges = new Map([...this.runs.keys()].map((id) => [id, new Set<string>()]));
    const confirmed = this.confirmedFacades();
    for (const root of this.runs.values()) {
      for (const facade of root.children) {
        const leaf = confirmed.get(facade.key);
        if (!leaf) continue;
        edges.get(root.id)!.add(leaf.runId);
        edges.get(leaf.runId)!.add(root.id);
      }
    }
    const selectedRunId = this.children().find((child) => child.key === this.selectedKey)?.runId;
    const visited = new Set<string>();
    let terminalCount = [...this.runs.values()].filter((run) => this.isTerminalRun(run)).length;
    // Map 的插入顺序即最老成员顺序；整组淘汰允许预算少于20。
    for (const run of this.runs.values()) {
      if (terminalCount <= RECENT_RUN_LIMIT) break;
      if (visited.has(run.id)) continue;
      const component: BrowserRun[] = [];
      const pending = [run.id];
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        component.push(this.runs.get(id)!);
        pending.push(...edges.get(id)!);
      }
      if (component.some((member) => member.id === selectedRunId || !this.isTerminalRun(member))) continue;
      for (const member of component) this.runs.delete(member.id);
      terminalCount -= component.length;
    }
  }
}
