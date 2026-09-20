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
 * While the run is in flight the newest step (the running tool, the streaming
 * text, or the reasoning being produced) stays on screen as the live tail; once
 * it settles the fold takes away whatever `RunFoldOptions` says it should.
 * Intermediate text, thinking runs, and tool rows fold independently, so a step
 * the fold has nothing left to take from stays visible as it is.
 *
 * Pi gives extensions no transcript hook, so this module wraps the two
 * component classes that make up a run (`AssistantMessageComponent` and
 * `ToolExecutionComponent`) and replaces their rendered output. It never
 * changes messages, session entries, or model context, and it never inserts or
 * removes children from Pi's chat container, so Pi's own bookkeeping (child
 * order, mouse layout, `pendingTools`, `streamingComponent`) stays intact.
 * Content is masked by temporarily replacing the `render` of the message's own
 * text/thinking children while the message renders normally underneath.
 */

export const DEFAULT_RUN_FOLD_TOGGLE_KEY = "f2";

/**
 * Which kinds of content the fold takes away. Each is independent: the fold
 * only ever removes content, never reorders it, so anything left over stays
 * exactly where Pi put it.
 */
export interface RunFoldOptions {
  /** Fold runs at all. When false every run renders natively. */
  folded: boolean;
  /**
   * Assistant text from steps that only call tools. The answer's own text and
   * the content of an answerless run are never folded away.
   */
  hideIntermediateText: boolean;
  /** Reasoning runs, including the ones inside a message that stays visible. */
  hideThinking: boolean;
  /** Tool call/result rows. */
  hideToolCalls: boolean;
}

export const DEFAULT_RUN_FOLD_OPTIONS: RunFoldOptions = {
  folded: true,
  hideIntermediateText: false,
  hideThinking: true,
  hideToolCalls: true,
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
      /** The message carries text, so folding its reasoning still leaves content. */
      hasText: boolean;
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

/** Which kinds of a message's own content the fold masks to zero rows. */
export interface FoldMask {
  /** Mask the message's text blocks. */
  text?: boolean;
  /** Mask the message's reasoning runs. */
  thinking?: boolean;
}

export interface FoldEntry {
  hidden: boolean;
  /**
   * Set on the first folded child of a run: it renders the summary block. That
   * child is usually hidden, but a run whose folded content all lives inside a
   * message that stays visible renders the summary above that message.
   */
  summary?: RunSummary;
  /**
   * Render natively, but mask the listed kinds of content to zero rows. The
   * summary (when this component hosts it) is rendered above the message.
   */
  mask?: FoldMask;
  /**
   * Keep a reasoning run that nothing visible follows: it is what the run is
   * producing right now (or, when settled, the only thing the message says).
   */
  keepTrailingReasoning?: boolean;
}

interface ClassifiedChild {
  component: Component;
  classification: FoldClassification;
}

/** A child that stays on screen with some of its content masked away. */
interface MaskedChild {
  entry: ClassifiedChild;
  mask: FoldMask;
  /** This child is the run's tail, so its newest reasoning run is live activity. */
  keepTrailing: boolean;
}

interface AssistantContentBlock {
  type?: string;
  thinking?: string;
  text?: string;
}

interface AssistantMessageLike {
  stopReason?: string;
  timestamp?: number;
  content?: AssistantContentBlock[];
}

interface AssistantInternals {
  isStreaming?: boolean;
  lastMessage?: AssistantMessageLike;
  contentContainer?: { children?: Component[] };
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

/** Does the message render any text of its own? */
function hasText(value: unknown): boolean {
  const content = messageOf(value)?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "text" && (block.text ?? "").trim());
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
      hasText: hasText(component),
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
  active: boolean,
): Pick<RunSummary, "durationMs" | "live"> {
  const assistants = assistantClassifications(run);
  const first = assistants[0];
  const last = assistants[assistants.length - 1];
  if (!first || !last) return { live: false };

  const startedAt = timings.timingFor(first.timestamp)?.startedAt ?? first.timestamp;
  // A run that is still in flight ends "now": tool execution and the gaps
  // between messages belong to the run, and the number keeps moving instead of
  // freezing on the last message that happened to finish. Once the run settles,
  // the last message's completion is the end, so the value stays consistent.
  const completedAt = active ? undefined : timings.timingFor(last.timestamp)?.completedAt;
  const live = active || completedAt === undefined;
  const endedAt = completedAt ?? timings.now();
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return { live };
  }
  return { durationMs: Math.max(0, endedAt - startedAt), live };
}

function summarizeRun(
  run: readonly ClassifiedChild[],
  hidden: readonly ClassifiedChild[],
  masked: readonly MaskedChild[],
  timings: TimingSource,
  active: boolean,
): RunSummary {
  const toolNames: string[] = [];
  for (const entry of hidden) {
    const classification = runChild(entry.classification);
    if (classification?.kind === "tool") toolNames.push(classification.toolName ?? "tool");
  }
  // Reasoning counts whatever the fold takes off the screen: steps it takes
  // whole, and the reasoning it masks out of a row that stays. A row whose
  // reasoning survives contributes nothing, and the two sets are disjoint, so
  // nothing is counted twice.
  let thinkingRuns = 0;
  const countThinking = (entry: ClassifiedChild) => {
    const classification = runChild(entry.classification);
    if (classification?.kind === "assistant") thinkingRuns += classification.thinkingRuns;
  };
  for (const entry of hidden) countThinking(entry);
  for (const entry of masked) {
    if (entry.mask.thinking) countThinking(entry.entry);
  }
  return {
    toolCount: toolNames.length,
    thinkingRuns,
    toolNames,
    ...runTiming(run, timings, active),
  };
}

/**
 * Fold a run down to its summary block plus the one thing still worth watching:
 *
 * - While the run is in flight the newest child stays on screen, so you see the
 *   tool that is running, the text that is streaming, or the reasoning that is
 *   being produced - without the transcript growing with every step.
 * - Once the run settles only its answer survives: every step folds, and the
 *   reasoning inside the answer folds with them, because by then it is history
 *   rather than activity. A settled run without an answer (aborted or failed)
 *   keeps its content: that output is the result.
 */
function foldRun(
  run: readonly ClassifiedChild[],
  layout: Map<Component, FoldEntry>,
  options: RunFoldOptions,
  timings: TimingSource,
  active: boolean,
): void {
  let lastAnswer = -1;
  let lastStep = -1;
  let anyPending = false;
  run.forEach((entry, index) => {
    const classification = runChild(entry.classification);
    if (!classification) return;
    if (classification.kind !== "decor") lastStep = index;
    if (classification.kind === "assistant" && classification.answerLike) lastAnswer = index;
    if (classification.kind !== "decor" && classification.pending) anyPending = true;
  });

  const inFlight = active || anyPending;
  // Everything before this index is a step the run has already finished.
  let visibleFrom: number;
  if (inFlight) visibleFrom = lastStep;
  else if (lastAnswer >= 0) visibleFrom = lastAnswer;
  else return;
  if (visibleFrom < 0) return;

  // Every finished step loses content: the whole row when all of its kinds
  // fold, or just the kinds that do. A row that keeps something renders in
  // place, so the fold never has to move content around.
  const hidden: ClassifiedChild[] = [];
  const masked: MaskedChild[] = [];
  run.forEach((entry, index) => {
    const classification = runChild(entry.classification);
    if (!classification || classification.kind === "decor") return;
    const isStep = index < visibleFrom;
    if (classification.kind === "tool") {
      if (isStep && options.hideToolCalls) hidden.push(entry);
      return;
    }
    const keepsText = !isStep || !options.hideIntermediateText;
    const keepsThinking = !options.hideThinking && classification.thinkingRuns > 0;
    if (!keepsText && !keepsThinking) {
      // Nothing of this step survives the fold: fold it whole instead of
      // leaving an empty row behind.
      hidden.push(entry);
      return;
    }
    // A mask only ever lists what the fold takes away: an empty one means the
    // row renders exactly as Pi drew it.
    const mask: FoldMask = {};
    if (!keepsText) mask.text = true;
    if (!keepsThinking && classification.thinkingRuns > 0) mask.thinking = true;
    if (!mask.text && !mask.thinking) return;
    // Reasoning is the run's live activity only while it is what the run is
    // currently producing: the newest child, still without text of its own.
    const isTail = index === lastStep;
    if (mask.thinking && isTail && !classification.hasText) return;
    masked.push({ entry, mask, keepTrailing: isTail });
  });

  if (hidden.length === 0 && masked.length === 0) return;

  // One component renders the summary: the first thing the fold takes away. A
  // run whose folded content all lives inside a message that stays visible
  // prints the summary above that message.
  const summary = summarizeRun(run, hidden, masked, timings, inFlight);
  const host = hidden[0] ?? masked[0]?.entry;
  for (const entry of hidden) {
    layout.set(entry.component, entry === host ? { hidden: true, summary } : { hidden: true });
  }
  for (const watched of masked) {
    layout.set(watched.entry.component, {
      hidden: false,
      mask: watched.mask,
      keepTrailingReasoning: watched.keepTrailing,
      ...(watched.entry === host ? { summary } : {}),
    });
  }
}

/**
 * Decide, for every chat-container child, whether it is folded away and which
 * child renders the run summary. Recomputed from live children so restored
 * sessions, `/compact`, and `/tree` navigation need no extra bookkeeping.
 *
 * `active` says whether the agent is still working on the trailing run. Between
 * a finished assistant message (with tool calls) and the next one, nothing in
 * the transcript is pending, but the run is clearly not over: the flag keeps it
 * folded and its clock live instead of falling back to native rendering.
 */
export function computeFoldLayout(
  children: readonly Component[],
  options: RunFoldOptions,
  timings: TimingSource = NO_TIMINGS,
  active = false,
): Map<Component, FoldEntry> {
  const layout = new Map<Component, FoldEntry>();
  if (!options.folded) return layout;

  let run: ClassifiedChild[] = [];
  // Only the trailing run can still be in flight; every earlier run is settled.
  const flush = (runActive = false) => {
    if (run.length > 0) foldRun(run, layout, options, timings, runActive);
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
  flush(active);
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

/**
 * The summary block, as it appears in the transcript: one blank line, then the
 * summary row. The blank line restores the spacing Pi gets from the leading
 * `Spacer(1)` of the assistant message we hide: a run follows the user prompt,
 * whose background box has a full row of background below the text, so the
 * summary would otherwise sit flush against that background block.
 */
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
  return ["", " ".repeat(pad) + truncateToWidth(line, available, "…")];
}

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-run-fold/render-patch");

type RenderFn = (this: Component, width: number) => string[];

interface LayoutCache {
  signature: string;
  layout: Map<Component, FoldEntry>;
}

export interface RunFoldPatchHandle {
  readonly folded: boolean;
  readonly options: RunFoldOptions;
  setOptions(options: Partial<RunFoldOptions>): void;
  /** Whether the agent is still working on the trailing run. */
  setRunActive(active: boolean): void;
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
  runActive: boolean;
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
  const layout = computeFoldLayout(children, record.options, record.timings, record.runActive);
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
  if (entry.hidden) {
    if (!entry.summary) return [];
    return renderRunSummaryLines(
      entry.summary,
      width,
      record.theme,
      record.toggleKey,
      outputPadOf(component),
    );
  }
  if (!entry.mask) return native.call(component, width);
  const lines = renderMasked(component, width, native, entry.mask, entry.keepTrailingReasoning === true);
  if (!entry.summary) return lines;
  return [
    ...renderRunSummaryLines(entry.summary, width, record.theme, record.toggleKey, outputPadOf(component)),
    ...lines,
  ];
}

/**
 * Pi's `AssistantMessageComponent.updateContent()` builds its content container
 * as: a leading spacer, one child per text block, one child per run of thinking
 * blocks (plus a spacer when visible content follows), and finally the
 * truncation/abort/error note. Mirroring that layout points at the children a
 * mask has to hide without matching colors or private markdown text - and a
 * mismatch (Pi changed the layout) disables the mask instead of mangling the
 * message.
 *
 * Returns the child indexes to mask, or an empty set when the layout is not the
 * one this module knows how to read.
 */
function maskedChildIndexes(
  message: AssistantMessageLike,
  children: readonly Component[],
  mask: FoldMask,
  keepTrailing: boolean,
): Set<number> {
  const content = message.content;
  if (!Array.isArray(content)) return new Set();

  const visible = (block: AssistantContentBlock | undefined) =>
    (block?.type === "text" && (block.text ?? "").trim()) ||
    (block?.type === "thinking" && (block.thinking ?? "").trim());
  const kinds: Array<"spacer" | "content" | "reasoning" | "note"> = [];
  if (content.some(visible)) kinds.push("spacer");
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (block?.type === "text" && (block.text ?? "").trim()) {
      kinds.push("content");
    } else if (block?.type === "thinking") {
      let hasReasoning = false;
      for (; index < content.length; index++) {
        const next = content[index];
        if (next?.type !== "thinking") break;
        if ((next.thinking ?? "").trim()) hasReasoning = true;
      }
      index--;
      if (!hasReasoning) continue;
      kinds.push("reasoning");
      // Pi separates a reasoning run from the visible content that follows it.
      if (content.slice(index + 1).some(visible)) kinds.push("spacer");
    }
  }
  const hasToolCalls = content.some((block) => block?.type === "toolCall");
  // The truncation/abort/error rows are not content the fold owns: they are the
  // message's result, so they are never masked.
  if (message.stopReason === "length") kinds.push("spacer", "note");
  else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
    kinds.push("spacer", "note");
  }

  if (kinds.length !== children.length) return new Set();
  const masked = new Set<number>();
  kinds.forEach((kind, index) => {
    if (kind === "content" && mask.text) masked.add(index);
    else if (kind === "reasoning" && mask.thinking) {
      // A run nothing visible follows is the newest thing the message says, so
      // it is the live activity while this message is the run's tail.
      const trailing = !kinds.slice(index + 1).some((later) => later !== "spacer");
      if (keepTrailing && trailing) return;
      masked.add(index);
    }
  });

  // A spacer exists to separate the two rows next to it. Once the mask takes
  // one of them away it would be a stray blank line, so it goes too. The
  // leading spacer is the message's own top margin rather than a separator, so
  // it only goes when nothing of the message is left to show.
  const nearest = (index: number, step: number): number => {
    for (let i = index + step; i >= 0 && i < kinds.length; i += step) {
      if (kinds[i] !== "spacer") return i;
    }
    return -1;
  };
  kinds.forEach((kind, index) => {
    if (kind !== "spacer" || index === 0 || masked.has(index)) return;
    const before = nearest(index, -1);
    const after = nearest(index, 1);
    const separates = before !== -1 && after !== -1 && !masked.has(before) && !masked.has(after);
    if (!separates) masked.add(index);
  });
  const survivor = kinds.some((kind, index) => kind !== "spacer" && !masked.has(index));
  if (!survivor && masked.size > 0 && kinds[0] === "spacer") masked.add(0);
  return masked;
}

/**
 * Render an assistant message with the masked kinds of content taken down to
 * zero rows. The mask is a temporary `render` override on those children while
 * the message's real render runs underneath, so Pi's own container bookkeeping
 * (child heights, the mouse layout, the OSC 133 marks) still matches what
 * reaches the terminal.
 */
function renderMasked(
  component: Component,
  width: number,
  native: RenderFn,
  mask: FoldMask,
  keepTrailing: boolean,
): string[] {
  const internals = component as AssistantInternals;
  const children = internals.contentContainer?.children;
  const message = internals.lastMessage;
  if (!children || !message) return native.call(component, width);
  const masked = maskedChildIndexes(message, children, mask, keepTrailing);
  if (masked.size === 0) return native.call(component, width);

  const saved = new Map<Component, { own: boolean; render: RenderFn }>();
  for (const index of masked) {
    const child = children[index];
    if (!child || typeof child.render !== "function") continue;
    saved.set(child, {
      own: Object.prototype.hasOwnProperty.call(child, "render"),
      render: child.render,
    });
    child.render = () => [];
  }
  try {
    return native.call(component, width);
  } finally {
    for (const [child, previous] of saved) {
      if (previous.own) child.render = previous.render;
      else delete (child as { render?: RenderFn }).render;
    }
  }
}

function createPatchRecord(options: Partial<RunFoldOptions>): PatchRecord {
  const assistantPrototype = AssistantMessageComponent.prototype as unknown as { render: RenderFn };
  const toolPrototype = ToolExecutionComponent.prototype as unknown as { render: RenderFn };

  const record = {
    owners: 0,
    options: { ...DEFAULT_RUN_FOLD_OPTIONS, ...options },
    toggleKey: DEFAULT_RUN_FOLD_TOGGLE_KEY,
    runActive: false,
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
    get folded() {
      return record.options.folded;
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
    setRunActive(active) {
      if (record.runActive === active) return;
      record.runActive = active;
      record.revision += 1;
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
      record.options = { ...record.options, folded: !record.options.folded };
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
