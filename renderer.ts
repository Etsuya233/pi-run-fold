import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

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
 * the fold has nothing left to take from stays visible as it is - and a run whose
 * steps stay on screen gets one summary per stretch of folded rows, not one for
 * the whole run. A steer or follow-up Pi delivers mid-turn arrives as a user
 * message in the middle of the run it interrupted: the message stays where Pi
 * put it, and the steps before it fold as history, because the run they belong to
 * no longer has an answer of its own.
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
   * Assistant text from steps that only call tools. The answer's own text is
   * never folded away, and neither is the content of an answerless run - unless
   * a boundary cut that run off, since then its steps are as much history as any
   * other run's.
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
      /** The message draws a truncation/abort/error note of its own. */
      hasNote: boolean;
      /** Still streaming, or a provider that reports a pending stop reason. */
      pending: boolean;
      /** The run never finished: this message is where it was aborted or errored. */
      failed: boolean;
    }
  | {
      group: "run";
      kind: "tool";
      toolName?: string;
      pending: boolean;
      /** The tool came back an error, so a run ending here ended on a failure. */
      failed: boolean;
    }
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

/**
 * The stretch hosts the reader opened. A host is a live component, so the patch
 * keeps them in a `WeakSet` and tests can hand in a plain `Set`.
 */
export interface ExpandedStretches {
  has(component: Component): boolean;
}

export interface FoldEntry {
  hidden: boolean;
  /**
   * Set on one child of each folded stretch: it renders that stretch's summary.
   * The host is usually a hidden child, but a stretch whose folded content all
   * lives inside a message that stays visible renders the summary above that
   * message.
   */
  summary?: RunSummary;
  /**
   * Render natively, but mask the listed kinds of content to zero rows. The
   * summary (when this component hosts it) is rendered above the message.
   */
  mask?: FoldMask;
  /**
   * The reader opened this stretch by clicking its summary row: everything the
   * stretch folded renders as Pi drew it, under a summary row that points down
   * and closes the stretch again.
   */
  expanded?: boolean;
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

/** A child the fold takes content from, in chat order. */
interface FoldedRow {
  entry: ClassifiedChild;
  /**
   * Index into the run: a row that stays on screen ends the stretch above it, so
   * consecutive folded rows are what a single summary accounts for.
   */
  index: number;
  /** The whole row goes; otherwise `mask` says which of its content goes. */
  hidden: boolean;
  mask?: FoldMask;
  /**
   * Whether the row still draws a line once the fold is done with it. A row that
   * does is what the reader sees between two marks, so it ends the stretch above
   * it - whether the fold took the whole row or only its reasoning.
   */
  renders: boolean;
  /** This row is the run's tail, so its newest reasoning run is live activity. */
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
  result?: { isError?: boolean };
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
 * Did the run stop on a failure? Only the last row inside it gets a say: a tool
 * that errored halfway through says nothing about how the run ended, while the
 * row it ended on is what the reader has to be left with.
 */
function endedInFailure(run: readonly ClassifiedChild[]): boolean {
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const classification = runChild(run[index]!.classification);
    if (!classification || classification.kind === "decor") continue;
    return classification.failed;
  }
  return false;
}

/**
 * Classify a chat-container child. Anything that is not an assistant, tool, or
 * decor component ends the current run (user prompts - a steer Pi delivered
 * mid-turn is one of those - banners, bash rows, compaction summaries, status
 * text, spacers, ...).
 */
export function classifyRunChild(component: Component): FoldClassification {
  if (isAssistant(component)) {
    const internals = component as AssistantInternals;
    const message = internals.lastMessage;
    const toolCalls = hasToolCalls(component);
    const stopReason = message?.stopReason;
    return {
      group: "run",
      kind: "assistant",
      timestamp: message?.timestamp,
      thinkingRuns: countThinkingRuns(component),
      answerLike: !toolCalls,
      hasText: hasText(component),
      // Pi draws these two rows even when the message has nothing else to say.
      hasNote: stopReason === "length" || (!toolCalls && (stopReason === "aborted" || stopReason === "error")),
      pending: internals.isStreaming === true || stopReason === "pending",
      // Not `length`: a truncated message either carries text (an answer) or its
      // tool calls come back as errors, which the tool row itself reports.
      failed: stopReason === "aborted" || stopReason === "error",
    };
  }
  if (isTool(component)) {
    const internals = component as ToolInternals;
    return {
      group: "run",
      kind: "tool",
      toolName: internals.toolName,
      pending: toolIsPending(component),
      failed: internals.result?.isError === true,
    };
  }
  if (isDecor(component)) return { group: "run", kind: "decor" };
  return { group: "boundary" };
}

function runStartedAt(run: readonly ClassifiedChild[], timings: TimingSource): number | undefined {
  for (const entry of run) {
    const classification = runChild(entry.classification);
    if (classification?.kind !== "assistant") continue;
    return timings.timingFor(classification.timestamp)?.startedAt ?? classification.timestamp;
  }
  return undefined;
}

/**
 * Where the run ends. A run that is still in flight ends "now": tool execution
 * and the gaps between messages belong to the run, and the number keeps moving
 * instead of freezing on the last message that happened to finish. Once the run
 * settles, the last message's completion is the end, so the value stays
 * consistent.
 */
function runEndedAt(
  run: readonly ClassifiedChild[],
  timings: TimingSource,
  active: boolean,
): { endedAt: number | undefined; live: boolean } {
  let last: AssistantClassification | undefined;
  for (const entry of run) {
    const classification = runChild(entry.classification);
    if (classification?.kind === "assistant") last = classification;
  }
  if (!last) return { endedAt: undefined, live: false };
  const completedAt = active ? undefined : timings.timingFor(last.timestamp)?.completedAt;
  if (completedAt !== undefined) return { endedAt: completedAt, live: false };
  return { endedAt: timings.now(), live: true };
}

/** Where the next assistant message after `index` starts: a stretch's end. */function nextAssistantStart(
  run: readonly ClassifiedChild[],
  index: number,
  timings: TimingSource,
): number | undefined {
  for (let next = index + 1; next < run.length; next += 1) {
    const classification = runChild(run[next]!.classification);
    if (classification?.kind !== "assistant") continue;
    return timings.timingFor(classification.timestamp)?.startedAt ?? classification.timestamp;
  }
  return undefined;
}

/**
 * Whether a row draws any line of its own - before the fold takes something from
 * it (`mask` undefined) or after (the kinds it leaves). Two cases hide nothing
 * but draw nothing either: a message carrying only tool calls, and a step whose
 * reasoning is the only thing left once `mask` takes the rest.
 */
function drawsRows(entry: ClassifiedChild, hidden: boolean, mask?: FoldMask): boolean {
  if (hidden) return false;
  const classification = runChild(entry.classification);
  if (!classification) return false;
  // Tool rows and custom cards always draw something of their own.
  if (classification.kind !== "assistant") return true;
  if (classification.hasNote) return true;
  const keepsText = classification.hasText && mask?.text !== true;
  const keepsThinking = classification.thinkingRuns > 0 && mask?.thinking !== true;
  return keepsText || keepsThinking;
}

function summarizeStretch(
  rows: readonly FoldedRow[],
  startedAt: number | undefined,
  endedAt: number | undefined,
  live: boolean,
): RunSummary {
  const toolNames: string[] = [];
  // Reasoning counts whatever this stretch takes off the screen: rows it takes
  // whole, and the reasoning it masks out of a row that stays. A row whose
  // reasoning survives contributes nothing.
  let thinkingRuns = 0;
  for (const row of rows) {
    const classification = runChild(row.entry.classification);
    if (classification?.kind === "tool") {
      if (row.hidden) toolNames.push(classification.toolName ?? "tool");
      continue;
    }
    if (classification?.kind !== "assistant") continue;
    if (row.hidden || row.mask?.thinking) thinkingRuns += classification.thinkingRuns;
  }
  const durationMs =
    startedAt !== undefined && endedAt !== undefined && Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, endedAt - startedAt)
      : undefined;
  return {
    toolCount: toolNames.length,
    thinkingRuns,
    toolNames,
    ...(durationMs === undefined ? {} : { durationMs }),
    live,
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
 *   rather than activity. A settled run without an answer keeps its content only
 *   when that content is the result - it failed, or it is still the end of the
 *   transcript. A boundary that cut it off first (`superseded`) makes it fold
 *   like any other finished run: a steer or a follow-up arrived, so whatever the
 *   run was doing is history, not an answer the reader is waiting on.
 */
function foldRun(
  run: readonly ClassifiedChild[],
  layout: Map<Component, FoldEntry>,
  options: RunFoldOptions,
  timings: TimingSource,
  active: boolean,
  superseded: boolean,
  expanded?: ExpandedStretches,
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
  // Nothing of a superseded run belongs on screen: its steps are history for the
  // same reason a folded run's are, and it has no answer of its own to keep.
  else if (superseded && !endedInFailure(run)) visibleFrom = run.length;
  else return;
  if (visibleFrom < 0) return;

  // Every finished step loses content: the whole row when all of its kinds
  // fold, or just the kinds that do. A row that keeps something renders in
  // place, so the fold never has to move content around.
  const folded: FoldedRow[] = [];
  run.forEach((entry, index) => {
    const classification = runChild(entry.classification);
    if (!classification || classification.kind === "decor") return;
    const isStep = index < visibleFrom;
    if (classification.kind === "tool") {
      if (isStep && options.hideToolCalls) {
        folded.push({ entry, index, hidden: true, renders: false, keepTrailing: false });
      }
      return;
    }
    const keepsText = !isStep || !options.hideIntermediateText;
    const keepsThinking = !options.hideThinking && classification.thinkingRuns > 0;
    if (!keepsText && !keepsThinking) {
      // Nothing of this step survives the fold: fold it whole instead of
      // leaving an empty row behind.
      folded.push({ entry, index, hidden: true, renders: false, keepTrailing: false });
      return;
    }
    // A mask only ever lists what the fold takes away: an empty one means the
    // row renders exactly as Pi drew it.
    const mask: FoldMask = {};
    if (!keepsText) mask.text = true;
    if (!keepsThinking && classification.thinkingRuns > 0) mask.thinking = true;
    if (!mask.text && !mask.thinking) return;
    // Reasoning is the run's live activity only while it is what the run is
    // currently producing: the newest child, still without text of its own, of a
    // run that still has something to produce. A run a boundary cut off has
    // none - its newest child is as much history as the steps before it.
    const isTail = index === lastStep && !superseded;
    if (mask.thinking && isTail && !classification.hasText) return;
    folded.push({
      entry,
      index,
      hidden: false,
      mask,
      renders: drawsRows(entry, false, mask),
      keepTrailing: isTail,
    });
  });

  if (folded.length === 0) return;

  // A row that stays on screen splits the fold. Each stretch of consecutive
  // folded rows gets its own summary, printed where that content used to be and
  // counting only what it takes away: one summary per run would leave every
  // stretch after the first without a trace, under a count that belongs to
  // somewhere else on screen.
  // Only a row that actually draws something ends a stretch - and that includes
  // a row the fold merely masked: its paragraph is on screen either way, so the
  // marks must not depend on whether the provider happened to return reasoning
  // for that step.
  const continues = (previous: FoldedRow, next: FoldedRow): boolean => {
    if (next.renders) return false;
    for (let index = previous.index + 1; index < next.index; index += 1) {
      if (drawsRows(run[index]!, false)) return false;
    }
    return true;
  };
  const chunks: FoldedRow[][] = [];
  for (const row of folded) {
    const current = chunks[chunks.length - 1];
    if (!current || !continues(current[current.length - 1]!, row)) chunks.push([row]);
    else current.push(row);
  }

  // A chunk that is nothing but a row the reader can see has no mark of its own:
  // the content it folded is everything the row itself hides (its reasoning), and
  // the mark it belongs to is the one below it - or, when there is none, the one
  // above. The answer is the usual case: the run's last mark already sits right
  // above it. Merging only ever happens between neighbours, so a mark never
  // reaches across something the reader can see.
  const stretches: FoldedRow[][] = [];
  for (const chunk of chunks) {
    const previous = stretches[stretches.length - 1];
    const lone = chunk.length === 1 && chunk[0]!.renders;
    if (lone && previous && previous[previous.length - 1]!.index === chunk[0]!.index - 1) {
      previous.push(chunk[0]!);
      continue;
    }
    stretches.push(chunk);
  }

  const runStart = runStartedAt(run, timings);
  const runEnd = runEndedAt(run, timings, active);
  let startedAt = runStart;
  for (let start = 0; start < stretches.length; start += 1) {
    const rows = stretches[start]!;
    // Stretches tile the run: each one ends where the next visible message
    // starts, and the last one ends where the run itself does (which is where it
    // keeps its clock while the run is still in flight).
    const isLast = start === stretches.length - 1;
    const endedAt = isLast ? runEnd.endedAt : nextAssistantStart(run, rows[rows.length - 1]!.index, timings);
    const summary = summarizeStretch(rows, startedAt, endedAt, isLast && runEnd.live);
    // One component renders the summary: the first row the stretch takes away
    // whole, or - when it takes content only - the first row it masks.
    const host = rows.find((row) => row.hidden)?.entry ?? rows[0]!.entry;
    if (expanded?.has(host.component)) {
      // The reader opened this stretch, so nothing in it folds: the host keeps
      // its summary row as the header that closes the stretch again, and every
      // row - the host included - renders exactly as Pi drew it. The host is
      // what the click is keyed on, so the header lands where the mark was.
      layout.set(host.component, { hidden: false, summary, expanded: true });
    } else {
      for (const row of rows) {
        const hosting = row.entry === host ? { summary } : {};
        layout.set(
          row.entry.component,
          row.hidden
            ? { hidden: true, ...hosting }
            : { hidden: false, mask: row.mask, keepTrailingReasoning: row.keepTrailing, ...hosting },
        );
      }
    }
    startedAt = endedAt;
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
 *
 * `expanded` holds the stretch hosts the reader opened by clicking their summary
 * row. An expanded stretch still gets its summary - nothing about what it folded
 * changes, only whether that content stays folded - so the same row closes it
 * again.
 */
export function computeFoldLayout(
  children: readonly Component[],
  options: RunFoldOptions,
  timings: TimingSource = NO_TIMINGS,
  active = false,
  expanded?: ExpandedStretches,
): Map<Component, FoldEntry> {
  const layout = new Map<Component, FoldEntry>();
  if (!options.folded) return layout;

  let run: ClassifiedChild[] = [];
  // Only the trailing run can still be in flight; every earlier run is settled.
  // A boundary flush marks the run as superseded: something - a user message Pi
  // delivered mid-turn (a steer, a follow-up), a banner, a compaction summary -
  // came next, so the run never reached the end of the transcript on its own.
  const flush = (runActive: boolean, superseded: boolean) => {
    if (run.length > 0) foldRun(run, layout, options, timings, runActive, superseded, expanded);
    run = [];
  };
  for (const child of children) {
    const classification = classifyRunChild(child);
    if (classification.group === "boundary") {
      flush(false, true);
      continue;
    }
    run.push({ component: child, classification });
  }
  flush(active, false);
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

/**
 * How a summary row points at the content under it, and how it says to move:
 * the key that toggles folding always works, the mouse only where the TUI routes
 * pointer input (see `RunFoldPatchHandle.setClickToToggle`).
 */
interface SummaryPresentation {
  arrow: string;
  hint: string;
}

function summaryPresentation(
  toggleKey: string,
  expanded: boolean,
  clickToToggle: boolean,
): SummaryPresentation {
  if (expanded) return { arrow: "▾ ", hint: "click to collapse" };
  return {
    arrow: "▸ ",
    hint: clickToToggle ? `click or ${toggleKey} to expand` : `${toggleKey} to expand`,
  };
}

function summaryRow(summary: RunSummary, presentation: SummaryPresentation): string {
  return `${presentation.arrow}${summaryBody(summary)}  (${presentation.hint})`;
}

/** Plain-text summary, used by tests. */
export function formatRunSummary(summary: RunSummary, toggleKey = DEFAULT_RUN_FOLD_TOGGLE_KEY): string {
  return summaryRow(summary, summaryPresentation(toggleKey, false, false));
}

/**
 * The summary block, as it appears in the transcript: one blank line, then the
 * summary row. The blank line restores the spacing Pi gets from the leading
 * `Spacer(1)` of the assistant message we hide: a run follows the user prompt,
 * whose background box has a full row of background below the text, so the
 * summary would otherwise sit flush against that background block.
 *
 * `expanded` is the stretch the reader opened: the arrow points down and the row
 * is where the click that closes it lands.
 */
export function renderRunSummaryLines(
  summary: RunSummary,
  width: number,
  theme: Theme | undefined,
  toggleKey = DEFAULT_RUN_FOLD_TOGGLE_KEY,
  pad = 1,
  expanded = false,
  clickToToggle = false,
): string[] {
  const available = Math.max(4, width - pad * 2);
  const paint = (color: Parameters<Theme["fg"]>[0], text: string) =>
    theme ? theme.fg(color, text) : text;
  const presentation = summaryPresentation(toggleKey, expanded, clickToToggle);
  const line = [
    paint("muted", presentation.arrow),
    paint("dim", summaryBody(summary)),
    "  ",
    paint("muted", `(${presentation.hint})`),
  ].join("");
  return ["", " ".repeat(pad) + truncateToWidth(line, available, "…")];
}

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-run-fold/render-patch");

type RenderFn = (this: Component, width: number) => string[];
type MouseHandler = (this: Component, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** What a host component's `handleMouse` was before we put the click on it. */
interface MouseSwap {
  own: boolean;
  handleMouse?: MouseHandler;
}

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
  /**
   * Whether a summary row can be clicked. Pi routes mouse input to components in
   * fullscreen mode only: in regular mode the terminal owns its scrollback, so
   * the summary keeps telling the reader about the key instead.
   */
  setClickToToggle(enabled: boolean): void;
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
  clickToToggle: boolean;
  timings: TimingSource;
  container?: Container;
  theme?: Theme;
  revision: number;
  cache?: LayoutCache;
  /** The stretches the reader opened, keyed by the component hosting the summary. */
  expandedStretches: WeakSet<Component>;
  /**
   * Lines the summary block takes at the top of each host's output. It sits
   * above the rows the host's own mouse layout knows about, so a click on it is
   * ours and every other row has to be handed on with those lines taken off.
   */
  summaryBlocks: WeakMap<Component, number>;
  /** Hosts whose `handleMouse` we replaced, and what to put back. */
  mouseHosts: Map<Component, MouseSwap>;
  mouseHandler: MouseHandler;
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
  if (!container) {
    syncMouseHosts(record);
    return new Map();
  }
  const children = container.children;
  const last = children[children.length - 1];
  const key = `${record.revision}|${children.length}|${last ? componentId(last) : "none"}`;
  if (record.cache?.signature === key) return record.cache.layout;
  const layout = computeFoldLayout(
    children,
    record.options,
    record.timings,
    record.runActive,
    record.expandedStretches,
  );
  syncMouseHosts(record, layout);
  record.cache = { signature: key, layout };
  return layout;
}

/**
 * Put the click on the row that opens a stretch, and take it off again when that
 * component stops hosting a summary, when folding is turned off, or on dispose.
 *
 * The host is one of Pi's own components, so the handler goes on the instance:
 * mouse dispatch skips a container whose `handleMouse` is still the inherited
 * one, and a handler of its own is exactly what makes the summary row reachable.
 * Replacing it has to keep `ToolExecutionComponent.handleMouse` working for every
 * other row, since that one forwards clicks inside the tool's own output.
 */
function syncMouseHosts(record: PatchRecord, layout?: Map<Component, FoldEntry>): void {
  const hosts = new Set<Component>();
  if (layout && record.clickToToggle) {
    for (const [component, entry] of layout) {
      if (entry.summary) hosts.add(component);
    }
  }
  for (const [component, swap] of record.mouseHosts) {
    if (hosts.has(component)) continue;
    record.mouseHosts.delete(component);
    if (component.handleMouse !== record.mouseHandler) continue;
    if (swap.own) component.handleMouse = swap.handleMouse;
    else delete (component as { handleMouse?: MouseHandler }).handleMouse;
  }
  for (const component of hosts) {
    if (record.mouseHosts.has(component)) continue;
    record.mouseHosts.set(component, {
      own: Object.prototype.hasOwnProperty.call(component, "handleMouse"),
      handleMouse: component.handleMouse,
    });
    component.handleMouse = record.mouseHandler;
  }
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
  const summary = entry.summary
    ? renderRunSummaryLines(
        entry.summary,
        width,
        record.theme,
        record.toggleKey,
        outputPadOf(component),
        entry.expanded === true,
        record.clickToToggle,
      )
    : undefined;
  if (summary) record.summaryBlocks.set(component, summary.length);
  else record.summaryBlocks.delete(component);
  if (entry.hidden) return summary ?? [];
  // An expanded stretch has no mask: everything the fold took away renders as Pi
  // drew it, under the row that closes the stretch again.
  const lines = entry.mask
    ? renderMasked(component, width, native, entry.mask, entry.keepTrailingReasoning === true)
    : native.call(component, width);
  return summary ? [...summary, ...lines] : lines;
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
    clickToToggle: false,
    timings: NO_TIMINGS,
    revision: 0,
    expandedStretches: new WeakSet<Component>(),
    summaryBlocks: new WeakMap<Component, number>(),
    mouseHosts: new Map<Component, MouseSwap>(),
    baseAssistantRender: assistantPrototype.render,
    baseToolRender: toolPrototype.render,
  } as PatchRecord;

  record.mouseHandler = function runFoldSummaryClick(
    this: Component,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    const block = record.summaryBlocks.get(this);
    const previous = record.mouseHosts.get(this)?.handleMouse;
    if (block === undefined || !previous) return undefined;
    if (event.type === "click" && event.button === "left" && event.y === block - 1) {
      if (record.expandedStretches.has(this)) record.expandedStretches.delete(this);
      else record.expandedStretches.add(this);
      // The click renders anyway (mouse results render by default); the bumped
      // revision is what makes that render use the new fold state.
      record.revision += 1;
      record.cache = undefined;
      return { handled: true };
    }
    // Every other row stays Pi's business: a tool row forwards clicks into the
    // output it drew, and an assistant message hands them to the reasoning
    // blocks it wrapped in mouse regions of its own. The summary is drawn above
    // everything those handlers measure from, so its lines come off first.
    return Reflect.apply(previous, this, [
      { ...event, y: event.y - block, height: Math.max(0, event.height - block) },
    ]);
  };

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
    setClickToToggle(enabled) {
      if (record.clickToToggle === enabled) return;
      record.clickToToggle = enabled;
      record.revision += 1;
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
      syncMouseHosts(record);
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
