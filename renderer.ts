import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Run folding renders a whole agent run as:
 *
 *     > user prompt
 *     ▸ read ×2, bash · 2 thinking · 12.4s  (f2 to expand)
 *     final answer
 *
 * Pi gives extensions no transcript hook, so this module wraps the two
 * component classes that make up a run (`AssistantMessageComponent` and
 * `ToolExecutionComponent`) and replaces their rendered output. It never
 * changes messages, session entries, or model context, and it never inserts or
 * removes children from Pi's chat container, so Pi's own bookkeeping (child
 * order, mouse layout, `pendingTools`, `streamingComponent`) stays intact.
 */

export const DEFAULT_RUN_FOLD_TOGGLE_KEY = "f2";

export interface RunFoldOptions {
  /** Show whole runs instead of the folded summary. */
  expanded: boolean;
  /** Hide assistant text from steps that only call tools. */
  hideIntermediateText: boolean;
  /** Hide tool call/result blocks. */
  hideTools: boolean;
}

export const DEFAULT_RUN_FOLD_OPTIONS: RunFoldOptions = {
  expanded: false,
  hideIntermediateText: true,
  hideTools: true,
};

export interface TimingLike {
  startedAt: number;
  completedAt?: number;
}

export interface TimingSource {
  timingFor(timestamp: number | undefined): TimingLike | undefined;
  now(): number;
}

const NO_TIMINGS: TimingSource = {
  timingFor: () => undefined,
  now: () => 0,
};

export type RunChildClassification =
  | {
      group: "run";
      kind: "assistant";
      timestamp?: number;
      thinkingRuns: number;
      /** No tool call yet: this message is (so far) the run's answer. */
      answerLike: boolean;
      /** Still streaming, or a provider that reports a pending stop reason. */
      pending: boolean;
    }
  | { group: "run"; kind: "tool"; toolName?: string; pending: boolean }
  /** Custom cards/entries inside a run: kept visible, never a run boundary. */
  | { group: "run"; kind: "decor" };

export type FoldClassification = RunChildClassification | { group: "boundary" };

type AssistantClassification = Extract<RunChildClassification, { kind: "assistant" }>;
type ToolClassification = Extract<RunChildClassification, { kind: "tool" }>;

function runChild(classification: FoldClassification): RunChildClassification | undefined {
  return classification.group === "run" ? classification : undefined;
}

export interface RunSummary {
  toolCount: number;
  thinkingRuns: number;
  toolNames: string[];
  durationMs?: number;
  live: boolean;
}

export interface FoldEntry {
  hidden: boolean;
  /** Only set on the first hidden child of a run: it renders the summary line. */
  summary?: RunSummary;
}

interface ClassifiedChild {
  component: Component;
  classification: FoldClassification;
}

interface AssistantMessageLike {
  stopReason?: string;
  timestamp?: number;
  content?: Array<{ type?: string; thinking?: string }>;
}

interface AssistantInternals {
  isStreaming?: boolean;
  lastMessage?: AssistantMessageLike;
}

interface ToolInternals {
  toolName?: string;
  result?: unknown;
  isPartial?: boolean;
}

function isAssistant(component: Component): boolean {
  return component instanceof AssistantMessageComponent;
}

function isTool(component: Component): boolean {
  return component instanceof ToolExecutionComponent;
}

/** Custom messages/entries live inside a run but are never folded away. */
function isDecor(component: Component): boolean {
  const name = component.constructor?.name;
  return name === "CustomMessageComponent" || name === "CustomEntryComponent";
}

export function countThinkingRuns(messageOrComponent: unknown): number {
  const content = messageOf(messageOrComponent)?.content;
  if (!Array.isArray(content)) return 0;
  let runs = 0;
  let insideRun = false;
  for (const block of content) {
    const thinking = block?.type === "thinking" ? (block.thinking ?? "").trim() : "";
    if (thinking) {
      if (!insideRun) runs += 1;
      insideRun = true;
    } else {
      insideRun = false;
    }
  }
  return runs;
}

/**
 * Accepts either an `AssistantMessageComponent` or a raw assistant message, so
 * callers can classify components and tests can pass plain messages.
 */
function messageOf(value: unknown): AssistantMessageLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const internals = value as { lastMessage?: AssistantMessageLike } & AssistantMessageLike;
  if (internals.lastMessage) return internals.lastMessage;
  return Array.isArray(internals.content) ? internals : undefined;
}

function hasToolCalls(value: unknown): boolean {
  const content = messageOf(value)?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

/**
 * A tool row is still running while it has no result, or is streaming a partial
 * result. While it runs, its run can be folded even though no answer exists yet.
 */
function toolIsPending(component: Component): boolean {
  const internals = component as ToolInternals;
  return internals.result === undefined || internals.isPartial === true;
}

/**
 * Classify a chat-container child. Anything that is not an assistant, tool, or
 * decor component ends the current run (user prompts, banners, bash rows,
 * compaction summaries, status text, spacers, ...).
 */
export function classifyRunChild(component: Component): FoldClassification {
  if (isAssistant(component)) {
    const internals = component as AssistantInternals;
    const message = internals.lastMessage;
    return {
      group: "run",
      kind: "assistant",
      timestamp: message?.timestamp,
      thinkingRuns: countThinkingRuns(component),
      answerLike: !hasToolCalls(component),
      pending: internals.isStreaming === true || message?.stopReason === "pending",
    };
  }
  if (isTool(component)) {
    return {
      group: "run",
      kind: "tool",
      toolName: (component as ToolInternals).toolName,
      pending: toolIsPending(component),
    };
  }
  if (isDecor(component)) return { group: "run", kind: "decor" };
  return { group: "boundary" };
}

function assistantClassifications(
  run: readonly ClassifiedChild[],
): AssistantClassification[] {
  const assistants: AssistantClassification[] = [];
  for (const entry of run) {
    const classification = runChild(entry.classification);
    if (classification?.kind === "assistant") assistants.push(classification);
  }
  return assistants;
}

function runTiming(
  run: readonly ClassifiedChild[],
  timings: TimingSource,
): Pick<RunSummary, "durationMs" | "live"> {
  const assistants = assistantClassifications(run);
  const first = assistants[0];
  const last = assistants[assistants.length - 1];
  if (!first || !last) return { live: false };

  const startedAt = timings.timingFor(first.timestamp)?.startedAt ?? first.timestamp;
  const completedAt = timings.timingFor(last.timestamp)?.completedAt;
  const live = completedAt === undefined;
  const endedAt = completedAt ?? timings.now();
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return { live };
  }
  return { durationMs: Math.max(0, endedAt - startedAt), live };
}

function summarizeRun(
  run: readonly ClassifiedChild[],
  hidden: readonly ClassifiedChild[],
  timings: TimingSource,
): RunSummary {
  const toolNames: string[] = [];
  let thinkingRuns = 0;
  for (const entry of hidden) {
    const classification = runChild(entry.classification);
    if (classification?.kind === "tool") toolNames.push(classification.toolName ?? "tool");
    if (classification?.kind === "assistant") thinkingRuns += classification.thinkingRuns;
  }
  return {
    toolCount: toolNames.length,
    thinkingRuns,
    toolNames,
    ...runTiming(run, timings),
  };
}

function foldRun(
  run: readonly ClassifiedChild[],
  layout: Map<Component, FoldEntry>,
  options: RunFoldOptions,
  timings: TimingSource,
): void {
  let lastAnswer = -1;
  let anyPending = false;
  run.forEach((entry, index) => {
    const classification = runChild(entry.classification);
    if (!classification) return;
    if (classification.kind === "assistant" && classification.answerLike) lastAnswer = index;
    if (classification.kind !== "decor" && classification.pending) anyPending = true;
  });

  // Children before the run's answer are its intermediate steps. While a run is
  // still working (a tool is running, or an answer is streaming) and no answer
  // exists yet, every child is intermediate. A settled run without an answer
  // (aborted or failed) keeps its content visible: that output is the result.
  let candidates: ClassifiedChild[];
  if (lastAnswer >= 0) candidates = run.slice(0, lastAnswer);
  else if (anyPending) candidates = [...run];
  else return;

  const hidden: ClassifiedChild[] = [];
  for (const entry of candidates) {
    const classification = runChild(entry.classification);
    if (!classification || classification.kind === "decor") continue;
    if (classification.kind === "assistant" && !options.hideIntermediateText) continue;
    if (classification.kind === "tool" && !options.hideTools) continue;
    hidden.push(entry);
  }
  if (hidden.length === 0) return;

  const summary = summarizeRun(run, hidden, timings);
  hidden.forEach((entry, index) => {
    layout.set(entry.component, index === 0 ? { hidden: true, summary } : { hidden: true });
  });
}

/**
 * Decide, for every chat-container child, whether it is folded away and which
 * child renders the run summary. Recomputed from live children so restored
 * sessions, `/compact`, and `/tree` navigation need no extra bookkeeping.
 */
export function computeFoldLayout(
  children: readonly Component[],
  options: RunFoldOptions,
  timings: TimingSource = NO_TIMINGS,
): Map<Component, FoldEntry> {
  const layout = new Map<Component, FoldEntry>();
  if (options.expanded) return layout;
  if (!options.hideTools && !options.hideIntermediateText) return layout;

  let run: ClassifiedChild[] = [];
  const flush = () => {
    if (run.length > 0) foldRun(run, layout, options, timings);
    run = [];
  };
  for (const child of children) {
    const classification = classifyRunChild(child);
    if (classification.group === "boundary") {
      flush();
      continue;
    }
    run.push({ component: child, classification });
  }
  flush();
  return layout;
}

export function formatToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  if (parts.length <= 3) return parts.join(", ");
  return `${parts.slice(0, 3).join(", ")} +${parts.length - 3}`;
}

export function formatSummarySeconds(milliseconds: number, live: boolean): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  return live ? `${Math.floor(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function summaryBody(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.toolCount > 0) {
    parts.push(
      summary.toolNames.length > 0 ? formatToolNames(summary.toolNames) : `${summary.toolCount} tools`,
    );
  }
  if (summary.thinkingRuns > 0) parts.push(`${summary.thinkingRuns} thinking`);
  if (summary.durationMs !== undefined) {
    parts.push(formatSummarySeconds(summary.durationMs, summary.live));
  }
  return parts.length > 0 ? parts.join(" · ") : "collapsed";
}

/** Plain-text summary, used by tests. */
export function formatRunSummary(summary: RunSummary, toggleKey = DEFAULT_RUN_FOLD_TOGGLE_KEY): string {
  return `▸ ${summaryBody(summary)}  (${toggleKey} to expand)`;
}

export function renderRunSummaryLines(
  summary: RunSummary,
  width: number,
  theme: Theme | undefined,
  toggleKey = DEFAULT_RUN_FOLD_TOGGLE_KEY,
  pad = 1,
): string[] {
  const available = Math.max(4, width - pad * 2);
  const paint = (color: Parameters<Theme["fg"]>[0], text: string) =>
    theme ? theme.fg(color, text) : text;
  const line = [
    paint("muted", "▸ "),
    paint("dim", summaryBody(summary)),
    "  ",
    paint("muted", `(${toggleKey} to expand)`),
  ].join("");
  return [" ".repeat(pad) + truncateToWidth(line, available, "…")];
}

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-run-fold/render-patch");

type RenderFn = (this: Component, width: number) => string[];

interface LayoutCache {
  signature: string;
  layout: Map<Component, FoldEntry>;
}

export interface RunFoldPatchHandle {
  readonly expanded: boolean;
  readonly options: RunFoldOptions;
  setOptions(options: Partial<RunFoldOptions>): void;
  setToggleKey(key: string): void;
  setTimingSource(timings: TimingSource): void;
  /** The chat container used for run grouping; undefined disables folding. */
  setContainer(container: Container | undefined): void;
  setTheme(theme: Theme | undefined): void;
  /** Recompute the layout on the next render (options, timings, or theme changed). */
  refresh(): void;
  toggle(): void;
  dispose(): void;
}

interface PatchRecord {
  owners: number;
  options: RunFoldOptions;
  toggleKey: string;
  timings: TimingSource;
  container?: Container;
  theme?: Theme;
  revision: number;
  cache?: LayoutCache;
  baseAssistantRender: RenderFn;
  baseToolRender: RenderFn;
  patchedAssistantRender: RenderFn;
  patchedToolRender: RenderFn;
  assistantRender(record: PatchRecord): RenderFn;
  toolRender(record: PatchRecord): RenderFn;
}

function outputPadOf(component: Component): number {
  const pad = (component as { outputPad?: unknown }).outputPad;
  return typeof pad === "number" && Number.isFinite(pad) && pad >= 0 ? pad : 1;
}

let componentSequence = 0;
const componentIds = new WeakMap<Component, number>();

function componentId(component: Component): number {
  const existing = componentIds.get(component);
  if (existing !== undefined) return existing;
  componentSequence += 1;
  componentIds.set(component, componentSequence);
  return componentSequence;
}

/**
 * Grouping only depends on child count/identity and revision (options,
 * timings, theme), so one comparison per render keeps the per-frame cost flat
 * even on long transcripts that Pi re-renders in full every frame.
 */
function ensureLayout(record: PatchRecord): Map<Component, FoldEntry> {
  const container = record.container;
  if (!container) return new Map();
  const children = container.children;
  const last = children[children.length - 1];
  const key = `${record.revision}|${children.length}|${last ? componentId(last) : "none"}`;
  if (record.cache?.signature === key) return record.cache.layout;
  const layout = computeFoldLayout(children, record.options, record.timings);
  record.cache = { signature: key, layout };
  return layout;
}

function renderFolded(
  record: PatchRecord,
  component: Component,
  width: number,
  native: RenderFn,
): string[] {
  let entry: FoldEntry | undefined;
  try {
    entry = ensureLayout(record).get(component);
  } catch {
    // Never let a grouping failure hide content: fall back to native rendering.
    return native.call(component, width);
  }
  if (!entry) return native.call(component, width);
  if (!entry.hidden) return native.call(component, width);
  if (!entry.summary) return [];
  return renderRunSummaryLines(
    entry.summary,
    width,
    record.theme,
    record.toggleKey,
    outputPadOf(component),
  );
}

function createPatchRecord(options: Partial<RunFoldOptions>): PatchRecord {
  const assistantPrototype = AssistantMessageComponent.prototype as unknown as { render: RenderFn };
  const toolPrototype = ToolExecutionComponent.prototype as unknown as { render: RenderFn };

  const record = {
    owners: 0,
    options: { ...DEFAULT_RUN_FOLD_OPTIONS, ...options },
    toggleKey: DEFAULT_RUN_FOLD_TOGGLE_KEY,
    timings: NO_TIMINGS,
    revision: 0,
    baseAssistantRender: assistantPrototype.render,
    baseToolRender: toolPrototype.render,
  } as PatchRecord;

  // Each wrap closes over its base so other extensions' patches keep working
  // underneath ours, and so re-asserting after a reload cannot stack wrappers.
  record.assistantRender = (target) => {
    const base = target.baseAssistantRender;
    return function runFoldAssistantRender(this: Component, width: number): string[] {
      return renderFolded(target, this, width, base);
    };
  };
  record.toolRender = (target) => {
    const base = target.baseToolRender;
    return function runFoldToolRender(this: Component, width: number): string[] {
      return renderFolded(target, this, width, base);
    };
  };
  record.patchedAssistantRender = record.assistantRender(record);
  record.patchedToolRender = record.toolRender(record);
  assistantPrototype.render = record.patchedAssistantRender;
  toolPrototype.render = record.patchedToolRender;
  return record;
}

function getPatchRecord(): PatchRecord | undefined {
  return (AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>)[
    PATCH_SYMBOL
  ] as PatchRecord | undefined;
}

function setPatchRecord(record: PatchRecord | undefined): void {
  const prototype = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
  if (record) prototype[PATCH_SYMBOL] = record;
  else delete prototype[PATCH_SYMBOL];
}

/** Re-install our wrappers if another extension restored or replaced them. */
export function assertRunFoldPatch(): void {
  const record = getPatchRecord();
  if (!record) return;
  const assistantPrototype = AssistantMessageComponent.prototype as unknown as { render: RenderFn };
  const toolPrototype = ToolExecutionComponent.prototype as unknown as { render: RenderFn };
  if (assistantPrototype.render !== record.patchedAssistantRender) {
    record.baseAssistantRender = assistantPrototype.render;
    record.patchedAssistantRender = record.assistantRender(record);
    assistantPrototype.render = record.patchedAssistantRender;
  }
  if (toolPrototype.render !== record.patchedToolRender) {
    record.baseToolRender = toolPrototype.render;
    record.patchedToolRender = record.toolRender(record);
    toolPrototype.render = record.patchedToolRender;
  }
  record.cache = undefined;
}

export function installRunFoldPatch(
  options: Partial<RunFoldOptions> = {},
): RunFoldPatchHandle {
  const assistantPrototype = AssistantMessageComponent.prototype as unknown as { render?: unknown };
  const toolPrototype = ToolExecutionComponent.prototype as unknown as { render?: unknown };
  if (typeof assistantPrototype.render !== "function" || typeof toolPrototype.render !== "function") {
    throw new Error("Pi's assistant/tool render API is unavailable");
  }

  const record = getPatchRecord() ?? createPatchRecord(options);
  record.owners += 1;
  record.options = { ...record.options, ...options };
  record.revision += 1;
  record.cache = undefined;
  if (getPatchRecord() !== record) setPatchRecord(record);

  let disposed = false;
  return {
    get expanded() {
      return record.options.expanded;
    },
    get options() {
      return { ...record.options };
    },
    setOptions(next) {
      record.options = { ...record.options, ...next };
      record.revision += 1;
      record.cache = undefined;
    },
    setToggleKey(key) {
      record.toggleKey = key.trim() || DEFAULT_RUN_FOLD_TOGGLE_KEY;
      record.cache = undefined;
    },
    setTimingSource(timings) {
      record.timings = timings;
      record.cache = undefined;
    },
    setContainer(container) {
      record.container = container;
      record.cache = undefined;
    },
    setTheme(theme) {
      record.theme = theme;
      record.cache = undefined;
    },
    refresh() {
      record.revision += 1;
      record.cache = undefined;
    },
    toggle() {
      record.options = { ...record.options, expanded: !record.options.expanded };
      record.revision += 1;
      record.cache = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      record.owners -= 1;
      if (record.owners > 0 || getPatchRecord() !== record) return;
      const assistant = AssistantMessageComponent.prototype as unknown as { render: RenderFn };
      const tool = ToolExecutionComponent.prototype as unknown as { render: RenderFn };
      if (assistant.render === record.patchedAssistantRender) assistant.render = record.baseAssistantRender;
      if (tool.render === record.patchedToolRender) tool.render = record.baseToolRender;
      setPatchRecord(undefined);
    },
  };
}

/**
 * Walk a mounted TUI tree for the container that holds chat messages.
 * `root` accepts Pi's `TUI` instance, whose private members make it
 * structurally incompatible with `Component` even though it extends Container.
 */
export function findChatContainer(root: unknown): Container | undefined {
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (!(node instanceof Container)) continue;
    if (node.children.some((child) => isAssistant(child) || isTool(child))) return node;
    for (const child of node.children) {
      if (child instanceof Container) queue.push(child);
    }
  }
  return undefined;
}
