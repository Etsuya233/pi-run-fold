import {
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import {
  DEFAULT_RUN_FOLD_OPTIONS,
  DEFAULT_RUN_FOLD_TOGGLE_KEY,
  assertRunFoldPatch,
  findChatContainer,
  installRunFoldPatch,
  type RunFoldOptions,
  type RunFoldPatchHandle,
  type TimingLike,
} from "./renderer.ts";

export const RUN_FOLD_WIDGET_KEY = "run-fold-render-bridge";
export const RUN_FOLD_STATUS_KEY = "run-fold";
const TICK_INTERVAL_MS = 1000;

/**
 * Rows above Pi's viewport are terminal scrollback. In regular mode the only way
 * to repaint them is Pi's own full redraw (clear screen + scrollback, re-render
 * everything). A preserve-scrollback extension rewrites exactly that redraw into
 * an in-place viewport repaint, so a fold that only touches offscreen runs never
 * reaches the terminal. `/run-fold redraw` (or `repaint on`) reproduces Pi's full
 * redraw through the extension's saved original write.
 */
const PRESERVE_SCROLLBACK_STATE = Symbol.for("pi-preserve-scrollback.stdout-patch-state");
const FULL_REDRAW_CLEAR = "\x1b[2J\x1b[H\x1b[3J";

/**
 * Folds every agent run down to its prompt, a one-line summary
 * (`▸ read ×2, bash · 2 thinking · 12.4s`), and the final answer. While the run
 * works, its newest step stays on screen as the live tail. Clicking a summary
 * row in fullscreen mode opens the stretch under it (`▾`, click again to fold).
 *
 * Display only: messages, session entries, and model context are untouched.
 */
export default function (pi: ExtensionAPI) {
  const timings = new Map<number, TimingLike>();
  let patch: RunFoldPatchHandle | undefined;
  let patchError: string | undefined;
  try {
    patch = installRunFoldPatch(DEFAULT_RUN_FOLD_OPTIONS);
  } catch (error) {
    patchError = error instanceof Error ? error.message : String(error);
  }

  let ctx: ExtensionContext | undefined;
  let tui: TUI | undefined;
  let requestRender: (() => void) | undefined;
  let container: Container | undefined;
  let theme: Theme | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let streamingTimestamp: number | undefined;
  /** The agent is still working on the trailing run (which has no answer yet). */
  let runActive = false;
  /** `/run-fold repaint on`: repaint the whole transcript when a fold touches offscreen runs. */
  let repaintOffscreen = false;
  /** `/run-fold statusline off`: leave the shared footer line to the other extensions. */
  let statusLineVisible = true;
  /** Fullscreen routes mouse input to components; regular mode leaves it to the terminal. */
  let mouseAvailable = false;
  let offscreenHintShown = false;

  const useTimings = () => {
    patch?.setTimingSource({
      timingFor: (timestamp) => (timestamp === undefined ? undefined : timings.get(timestamp)),
      now: () => Date.now(),
    });
  };

  const refresh = () => {
    patch?.refresh();
    requestRender?.();
  };

  /**
   * Tell the renderer whether a summary row can be clicked, so the row points at
   * the mouse where there is one and at the key where there is not. Fullscreen
   * owns the viewport and dispatches pointer events; regular mode hands the
   * scrollback to the terminal, which never reports clicks on it.
   */
  const syncMouseMode = (instance: TUI) => {
    const clickable = instance.mode === "fullscreen";
    if (clickable === mouseAvailable) return;
    mouseAvailable = clickable;
    patch?.setClickToToggle(clickable);
  };

  /**
   * Keep the footer in step with the strategy. Option-only, so it is O(1) and
   * belongs on the commands that change the options - never in `refresh()`, which
   * the ticker calls every second.
   */
  const syncStatus = (context: ExtensionContext) => {
    if (context.mode !== "tui") return;
    const text = statusLineVisible && patch ? statusText(patch.options) : undefined;
    // Pi prints extension statuses as-is while every other footer line is dim, so
    // the text has to dim itself to sit at the same weight as its neighbours.
    context.ui.setStatus(
      RUN_FOLD_STATUS_KEY,
      text === undefined ? undefined : context.ui.theme.fg("dim", text),
    );
  };

  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };

  const startTicker = () => {
    if (ticker || ctx?.mode !== "tui" || !runActive) return;
    ticker = setInterval(() => {
      if (!runActive) {
        stopTicker();
        return;
      }
      refresh();
    }, TICK_INTERVAL_MS);
    ticker.unref?.();
  };

  /**
   * Run-level liveness, driven by Pi's agent events (a low-level run can retry,
   * compact, and continue, so only `agent_settled` means "really done"). It keeps
   * the trailing run folded - and its clock moving - across the gap between a
   * finished tool call and the next assistant message, where nothing is pending.
   */
  const setRunActive = (active: boolean) => {
    if (runActive === active) return;
    runActive = active;
    patch?.setRunActive(active);
    if (active) startTicker();
    else stopTicker();
    refresh();
  };

  const completeTiming = (timestamp: number, completedAt = Date.now()) => {
    const timing = timings.get(timestamp) ?? { startedAt: Math.min(timestamp, completedAt) };
    if (timing.completedAt !== undefined) return;
    timings.set(timestamp, { ...timing, completedAt });
    if (streamingTimestamp === timestamp) streamingTimestamp = undefined;
    refresh();
  };

  /** Is there transcript content above Pi's viewport (i.e. terminal scrollback)? */
  const hasOffscreenRows = (): boolean => {
    const viewportTop = (tui as { previousViewportTop?: unknown } | undefined)?.previousViewportTop;
    return typeof viewportTop === "number" && viewportTop > 0;
  };

  /** The saved unpatched `process.stdout.write`, when a scrollback preserver is active. */
  const scrollbackPreserver = (): { originalWrite: (...args: unknown[]) => unknown } | undefined => {
    const stdout = process.stdout as unknown as Record<PropertyKey, unknown>;
    const state = stdout[PRESERVE_SCROLLBACK_STATE] as
      | { originalWrite?: unknown; patchedWrite?: unknown }
      | undefined;
    if (typeof state?.originalWrite !== "function" || state.patchedWrite !== stdout.write) return undefined;
    return state as { originalWrite: (...args: unknown[]) => unknown };
  };

  /**
   * Reproduce Pi's own full redraw: clear screen + scrollback (through the
   * preserver's original write, when one is installed) and make Pi re-render the
   * whole transcript from scratch instead of diffing against stale rows.
   */
  const forceFullRedraw = (): boolean => {
    const instance = tui;
    if (!instance || (instance as { mode?: string }).mode !== "regular") return false;
    const target = instance as unknown as {
      terminal: { columns: number; rows: number };
      captureRenderState?: () => unknown;
      restoreRenderState?: (state: unknown) => void;
      renderNow: () => void;
    };
    if (typeof target.captureRenderState !== "function" || typeof target.restoreRenderState !== "function") {
      return false;
    }
    const preserver = scrollbackPreserver();
    if (preserver) Reflect.apply(preserver.originalWrite, process.stdout, [FULL_REDRAW_CLEAR]);
    else process.stdout.write(FULL_REDRAW_CLEAR);
    target.restoreRenderState({
      ...(target.captureRenderState() as Record<string, unknown>),
      previousLines: [],
      previousWidth: target.terminal.columns,
      previousHeight: target.terminal.rows,
      cursorRow: 0,
      hardwareCursorRow: 0,
      maxLinesRendered: 0,
      previousViewportTop: 0,
    });
    target.renderNow();
    return true;
  };

  const hintOffscreen = () => {
    if (offscreenHintShown || ctx?.mode !== "tui") return;
    offscreenHintShown = true;
    ctx.ui.notify(
      "run-fold: runs above the viewport keep the text the terminal already printed " +
        "(use /run-fold redraw, /run-fold repaint on, or --tui-mode fullscreen)",
      "info",
    );
  };

  /** Redraw after a fold-state change, repainting offscreen runs when asked to. */
  const afterFoldChange = () => {
    refresh();
    if (!hasOffscreenRows()) return;
    if (repaintOffscreen && forceFullRedraw()) return;
    hintOffscreen();
  };

  /** Approximate durations for a restored session, reconstructed from Pi's entries. */
  const restoreTimings = (context: ExtensionContext) => {
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      const completedAt = Date.parse(entry.timestamp);
      const startedAt = Number.isFinite(message.timestamp) ? message.timestamp : completedAt;
      timings.set(message.timestamp, {
        startedAt: Math.min(startedAt, completedAt),
        completedAt,
      });
    }
  };

  /**
   * A zero-row widget whose factory hands us Pi's live TUI. It renders every
   * frame, which makes it the cheapest place to refresh the theme, rediscover
   * the chat container after a session swap, and request redraws.
   */
  const renderBridge = (bridgeTui: TUI): Component & { dispose?(): void } => ({
    render: (): string[] => {
      const current = ctx?.ui.theme;
      if (current && current !== theme) {
        theme = current;
        patch?.setTheme(current);
      }
      syncMouseMode(bridgeTui);
      if (ctx?.mode === "tui") {
        const found = findChatContainer(bridgeTui);
        if (found && found !== container) {
          container = found;
          patch?.setContainer(found);
          patch?.refresh();
        }
      }
      return [];
    },
    invalidate() {},
    dispose() {
      requestRender = undefined;
    },
  });

  pi.on("session_start", (_event, context) => {
    if (patchError) {
      if (context.hasUI) {
        context.ui.notify(`run-fold disabled on Pi ${VERSION}: ${patchError}`, "warning");
      }
      return;
    }
    if (!patch || context.mode !== "tui") return;

    ctx = context;
    timings.clear();
    runActive = false;
    repaintOffscreen = false;
    mouseAvailable = false;
    offscreenHintShown = false;
    restoreTimings(context);
    useTimings();
    assertRunFoldPatch();
    patch.setRunActive(false);

    context.ui.setWidget(
      RUN_FOLD_WIDGET_KEY,
      (bridgeTui) => {
        tui = bridgeTui;
        requestRender = () => bridgeTui.requestRender();
        // Before the first frame, so the summary rows already offer the mouse.
        syncMouseMode(bridgeTui);
        return renderBridge(bridgeTui);
      },
      { placement: "belowEditor" },
    );

    syncStatus(context);
    refresh();
  });

  pi.on("agent_start", (_event, context) => {
    ctx = context;
    setRunActive(true);
  });

  pi.on("message_start", (event, context) => {
    if (event.message.role !== "assistant") return;
    ctx = context;
    const timestamp = event.message.timestamp;
    if (!timings.has(timestamp)) timings.set(timestamp, { startedAt: Date.now() });
    streamingTimestamp = timestamp;
    assertRunFoldPatch();
    if (!runActive) setRunActive(true);
    startTicker();
    refresh();
  });

  pi.on("message_update", (event, context) => {
    if (event.message.role !== "assistant") return;
    ctx = context;
    // The layout now depends on the streaming message's content: its reasoning
    // stops being the live tail - and folds away - the moment the same message
    // emits text. Refreshing per update lands the mask on the same frame as the
    // text instead of up to a tick later.
    refresh();
  });

  pi.on("message_end", (event, context) => {
    if (event.message.role !== "assistant") return;
    ctx = context;
    completeTiming(event.message.timestamp);
  });

  pi.on("agent_end", (_event, context) => {
    ctx = context;
    if (streamingTimestamp !== undefined) completeTiming(streamingTimestamp);
    // The low-level run ended; Pi may still retry, compact, or continue, so the
    // trailing run stays "active" until agent_settled. Only the animation stops.
    stopTicker();
    refresh();
  });

  pi.on("agent_settled", () => {
    if (streamingTimestamp !== undefined) completeTiming(streamingTimestamp);
    setRunActive(false);
    refresh();
  });

  pi.on("session_shutdown", (_event, context) => {
    stopTicker();
    runActive = false;
    repaintOffscreen = false;
    ctx = undefined;
    tui = undefined;
    container = undefined;
    theme = undefined;
    requestRender = undefined;
    if (context.hasUI) {
      context.ui.setWidget(RUN_FOLD_WIDGET_KEY, undefined);
      context.ui.setStatus(RUN_FOLD_STATUS_KEY, undefined);
    }
    patch?.dispose();
    patch = undefined;
  });

  pi.registerShortcut(DEFAULT_RUN_FOLD_TOGGLE_KEY, {
    description: "Toggle run folding (expand/collapse agent runs)",
    handler: async (context) => {
      patch?.toggle();
      afterFoldChange();
      syncStatus(context);
    },
  });

  pi.registerCommand("run-fold", {
    description: "Toggle or inspect run folding",
    handler: async (args, context) => {
      if (!patch) {
        context.ui.notify(patchError ?? "run-fold is not active", "error");
        return;
      }
      const [action, value] = args.trim().split(/\s+/, 2);
      switch (action) {
        case "":
        case "toggle":
          patch.toggle();
          afterFoldChange();
          break;
        // The value aliases at the action level: `/run-fold collapse` says
        // "fold it" and `/run-fold expand` says "show it natively".
        case "collapse":
          patch.setOptions({ folded: true });
          afterFoldChange();
          break;
        case "expand":
          patch.setOptions({ folded: false });
          afterFoldChange();
          break;
        case "fold":
          patch.setOptions({ folded: parseToggle(value) });
          afterFoldChange();
          break;
        case "text":
        case "intermediateText":
          patch.setOptions({ hideIntermediateText: parseToggle(value) });
          afterFoldChange();
          break;
        case "thinking":
        case "think":
          patch.setOptions({ hideThinking: parseToggle(value) });
          afterFoldChange();
          break;
        case "tool":
        case "toolcalls":
          patch.setOptions({ hideToolCalls: parseToggle(value) });
          afterFoldChange();
          break;
        case "repaint":
          repaintOffscreen = value === "on" || value === "true";
          refresh();
          break;
        case "statusline": {
          if (value === "on") statusLineVisible = true;
          else if (value === "off") statusLineVisible = false;
          else if (value === undefined || value === "toggle") statusLineVisible = !statusLineVisible;
          else {
            context.ui.notify("Usage: /run-fold statusline [toggle|on|off]", "warning");
            return;
          }
          break;
        }
        case "redraw":
          if (forceFullRedraw()) offscreenHintShown = true;
          else context.ui.notify("run-fold: nothing to repaint (no offscreen runs in this TUI)", "info");
          return;
        case "status":
          break;
        default:
          context.ui.notify(
            "Usage: /run-fold [toggle|collapse|expand|fold|text|thinking|tool|repaint <on|off>] " +
              "[statusline <toggle|on|off>|redraw|status] " +
              "(aliases: intermediateText = text, think = thinking, toolcalls = tool; on = collapse, off = show = expand)",
            "warning",
          );
          return;
      }
      syncStatus(context);
      refresh();
      context.ui.notify(
        `run-fold: ${describeOptions(patch.options)} · offscreen repaint ${repaintOffscreen ? "on" : "off"} · ` +
          `statusline ${statusLineVisible ? "on" : "off"}`,
        "info",
      );
    },
  });
}

/**
 * `on` folds or hides, `off` keeps or shows. `collapse` and `expand` say the
 * same thing in the vocabulary of what happens on screen, and `show` is the
 * historical spelling of `off`. No argument - or anything else - means on.
 */
function parseToggle(value: string | undefined): boolean {
  return value !== "off" && value !== "show" && value !== "expand";
}

/**
 * The footer status line, or undefined for "leave the line to the other
 * extensions".
 *
 * The line is shared with every extension and sorted by key, so this stays
 * short: the parentheses list the kinds the fold is configured to take away -
 * bare `folded` when that is all three, and nothing at all when it is none of
 * them, since the fold then has nothing to do.
 */
export function statusText(options: RunFoldOptions): string | undefined {
  if (!options.folded) return undefined;
  const hidden: string[] = [];
  if (options.hideIntermediateText) hidden.push("text");
  if (options.hideThinking) hidden.push("think");
  if (options.hideToolCalls) hidden.push("tool");
  if (hidden.length === 0) return undefined;
  return hidden.length === 3 ? "folded" : `folded(${hidden.join(",")})`;
}

function describeOptions(options: RunFoldOptions): string {
  return [
    options.folded ? "folded" : "expanded",
    `intermediate text ${options.hideIntermediateText ? "hidden" : "shown"}`,
    `thinking ${options.hideThinking ? "hidden" : "shown"}`,
    `tool calls ${options.hideToolCalls ? "hidden" : "shown"}`,
    `${DEFAULT_RUN_FOLD_TOGGLE_KEY} toggles`,
  ].join(" · ");
}

export {
  DEFAULT_RUN_FOLD_OPTIONS,
  DEFAULT_RUN_FOLD_TOGGLE_KEY,
  assertRunFoldPatch,
  computeFoldLayout,
  countThinkingRuns,
  findChatContainer,
  formatRunSummary,
  formatSummarySeconds,
  formatToolNames,
  installRunFoldPatch,
  renderRunSummaryLines,
  type ExpandedStretches,
  type FoldClassification,
  type FoldEntry,
  type FoldMask,
  type RunFoldOptions,
  type RunFoldPatchHandle,
  type RunSummary,
  type TimingLike,
  type TimingSource,
} from "./renderer.ts";
