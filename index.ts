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
const TICK_INTERVAL_MS = 1000;

/**
 * Folds every agent run down to its prompt, a one-line summary
 * (`▸ read ×2, bash · 2 thinking · 12.4s`), and the final answer.
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

  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };

  const startTicker = () => {
    if (ticker || ctx?.mode !== "tui") return;
    ticker = setInterval(() => {
      const timing = streamingTimestamp === undefined ? undefined : timings.get(streamingTimestamp);
      if (!timing || timing.completedAt !== undefined) {
        stopTicker();
        return;
      }
      refresh();
    }, TICK_INTERVAL_MS);
    ticker.unref?.();
  };

  const completeTiming = (timestamp: number, completedAt = Date.now()) => {
    const timing = timings.get(timestamp) ?? { startedAt: Math.min(timestamp, completedAt) };
    if (timing.completedAt !== undefined) return;
    timings.set(timestamp, { ...timing, completedAt });
    if (streamingTimestamp === timestamp) {
      streamingTimestamp = undefined;
      stopTicker();
    }
    refresh();
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
    restoreTimings(context);
    useTimings();
    assertRunFoldPatch();

    context.ui.setWidget(
      RUN_FOLD_WIDGET_KEY,
      (bridgeTui) => {
        tui = bridgeTui;
        requestRender = () => bridgeTui.requestRender();
        return renderBridge(bridgeTui);
      },
      { placement: "belowEditor" },
    );

    refresh();
  });

  pi.on("message_start", (event, context) => {
    if (event.message.role !== "assistant") return;
    ctx = context;
    const timestamp = event.message.timestamp;
    if (!timings.has(timestamp)) timings.set(timestamp, { startedAt: Date.now() });
    streamingTimestamp = timestamp;
    assertRunFoldPatch();
    startTicker();
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
    stopTicker();
    refresh();
  });

  pi.on("agent_settled", () => {
    if (streamingTimestamp !== undefined) completeTiming(streamingTimestamp);
    stopTicker();
    refresh();
  });

  pi.on("session_shutdown", (_event, context) => {
    stopTicker();
    ctx = undefined;
    tui = undefined;
    container = undefined;
    theme = undefined;
    requestRender = undefined;
    if (context.hasUI) {
      context.ui.setWidget(RUN_FOLD_WIDGET_KEY, undefined);
    }
    patch?.dispose();
    patch = undefined;
  });

  pi.registerShortcut(DEFAULT_RUN_FOLD_TOGGLE_KEY, {
    description: "Toggle run folding (expand/collapse agent runs)",
    handler: async () => {
      patch?.toggle();
      refresh();
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
          break;
        case "expand":
          patch.setOptions({ expanded: true });
          break;
        case "collapse":
          patch.setOptions({ expanded: false });
          break;
        case "text":
          patch.setOptions({ hideIntermediateText: value !== "off" && value !== "show" });
          break;
        case "tools":
          patch.setOptions({ hideTools: value !== "off" && value !== "show" });
          break;
        case "status":
          break;
        default:
          context.ui.notify(
            "Usage: /run-fold [toggle|expand|collapse|text on|off|tools on|off|status]",
            "warning",
          );
          return;
      }
      refresh();
      context.ui.notify(`run-fold: ${describeOptions(patch.options)}`, "info");
    },
  });
}

function describeOptions(options: RunFoldOptions): string {
  return [
    options.expanded ? "expanded" : "folded",
    `intermediate text ${options.hideIntermediateText ? "hidden" : "shown"}`,
    `tools ${options.hideTools ? "hidden" : "shown"}`,
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
  type FoldClassification,
  type FoldEntry,
  type RunFoldOptions,
  type RunFoldPatchHandle,
  type RunSummary,
  type TimingLike,
  type TimingSource,
} from "./renderer.ts";
