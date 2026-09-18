import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
// Since Pi 0.84 `TUI` is no longer re-exported from pi-coding-agent; it is
// defined in pi-tui (pi-coding-agent 0.83 exported both).
import { Container, type TUI } from "@earendil-works/pi-tui";
import runFoldExtension, {
  DEFAULT_RUN_FOLD_OPTIONS,
  assertRunFoldPatch,
  computeFoldLayout,
  countThinkingRuns,
  findChatContainer,
  formatRunSummary,
  formatToolNames,
  installRunFoldPatch,
  renderRunSummaryLines,
  type RunFoldOptions,
  type TimingSource,
} from "../index.ts";

initTheme("dark", false);

const T0 = 1_700_000_000_000;
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const markdownTheme = getMarkdownTheme();
const ui = { requestRender() {} } as unknown as TUI;

function assistant(options: {
  timestamp: number;
  thinking?: string;
  text?: string;
  tools?: Array<{ id: string; name: string }>;
  stopReason?: string;
}): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
  if (options.text) content.push({ type: "text", text: options.text });
  for (const tool of options.tools ?? []) {
    content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: {} } as never);
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: (options.stopReason ?? "stop") as AssistantMessage["stopReason"],
    timestamp: options.timestamp,
  } as AssistantMessage;
}

function assistantComponent(message: AssistantMessage): AssistantMessageComponent {
  return new AssistantMessageComponent(message, false, markdownTheme);
}

function toolComponent(id: string, name: string, output: string): ToolExecutionComponent {
  const component = new ToolExecutionComponent(name, id, {}, {}, undefined, ui, "/local/workspace");
  component.updateResult({ content: [{ type: "text", text: output }], isError: false });
  return component;
}

function timingsSource(map: Map<number, { startedAt: number; completedAt?: number }>): TimingSource {
  return {
    timingFor: (timestamp) => (timestamp === undefined ? undefined : map.get(timestamp)),
    now: () => T0 + 60_000,
  };
}

const options: RunFoldOptions = { ...DEFAULT_RUN_FOLD_OPTIONS };

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

test("a run keeps only its last assistant message and folds everything else", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "先看测试",
      tools: [{ id: "t1", name: "read" }, { id: "t2", name: "read" }, { id: "t3", name: "grep" }],
      stopReason: "toolUse",
    }),
  );
  const final = assistantComponent(assistant({ timestamp: T0 + 4_000, text: "答案是 A" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t1", "read", "…"));
  chat.addChild(toolComponent("t2", "read", "…"));
  chat.addChild(toolComponent("t3", "grep", "…"));
  chat.addChild(final);

  const timings = new Map([
    [T0, { startedAt: T0 - 500, completedAt: T0 + 1_500 }],
    [T0 + 4_000, { startedAt: T0 + 3_500, completedAt: T0 + 7_000 }],
  ]);
  const layout = computeFoldLayout(chat.children, options, timingsSource(timings));

  assert.equal(layout.get(final), undefined, "the final answer renders natively");
  assert.deepEqual(layout.get(first)?.summary, {
    toolCount: 3,
    thinkingRuns: 1,
    toolNames: ["read", "read", "grep"],
    durationMs: 7_500,
    live: false,
  });
  assert.deepEqual(layout.get(chat.children[1]!), { hidden: true });
  assert.equal(layout.size, 4, "every intermediate child is hidden");
});

test("runs are split by user prompts, banners, and other non-run children", () => {
  const chat = new Container();
  const runOne = assistantComponent(assistant({ timestamp: T0, tools: [{ id: "a", name: "read" }], stopReason: "toolUse" }));
  const runOneFinal = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "first" }));
  const user = new UserMessageComponent("second prompt", markdownTheme, 1, []);
  const runTwo = assistantComponent(assistant({ timestamp: T0 + 5_000, tools: [{ id: "b", name: "bash" }], stopReason: "toolUse" }));
  const runTwoFinal = assistantComponent(assistant({ timestamp: T0 + 6_000, text: "second" }));
  chat.addChild(runOne);
  chat.addChild(toolComponent("a", "read", "…"));
  chat.addChild(runOneFinal);
  chat.addChild(user);
  chat.addChild(runTwo);
  chat.addChild(toolComponent("b", "bash", "…"));
  chat.addChild(runTwoFinal);

  const layout = computeFoldLayout(chat.children, options);
  assert.equal(layout.get(runOne)?.summary?.toolCount, 1);
  assert.equal(layout.get(runTwo)?.summary?.toolCount, 1);
  assert.equal(layout.get(user), undefined);
  assert.equal(layout.get(runOneFinal), undefined);
  assert.equal(layout.get(runTwoFinal), undefined);
});

test("a single answer run stays untouched and a settled run keeps its output", () => {
  const chat = new Container();
  const only = assistantComponent(assistant({ timestamp: T0, thinking: "hmm", text: "answer" }));
  const trailingTool = toolComponent("t1", "read", "…");
  chat.addChild(only);
  chat.addChild(trailingTool);
  assert.equal(computeFoldLayout(chat.children, options).size, 0);

  // An aborted run leaves settled tool output behind: that output is the
  // result the user needs, so it is never folded away.
  const aborted = new Container();
  const intermediate = assistantComponent(
    assistant({ timestamp: T0, tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }),
  );
  aborted.addChild(intermediate);
  aborted.addChild(toolComponent("t", "read", "error: aborted"));
  assert.equal(computeFoldLayout(aborted.children, options).size, 0);

  // While a tool is still running there is no answer yet, but the run is
  // clearly in flight: fold its steps so the transcript does not keep growing.
  const running = new Container();
  running.addChild(intermediate);
  running.addChild(new ToolExecutionComponent("read", "t", {}, {}, undefined, ui, "/local/workspace"));
  const live = computeFoldLayout(running.children, options, timingsSource(new Map([[T0, { startedAt: T0 }]])));
  assert.deepEqual([...live.keys()], [intermediate, running.children[1]]);
  assert.deepEqual(live.get(intermediate)?.summary, {
    toolCount: 1,
    thinkingRuns: 0,
    toolNames: ["read"],
    durationMs: 60_000,
    live: true,
  });
});

test("expanded runs and strategy switches change what is folded", () => {
  const chat = new Container();
  const first = assistantComponent(assistant({ timestamp: T0, thinking: "a", text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "…"));
  chat.addChild(final);

  assert.equal(computeFoldLayout(chat.children, { ...options, expanded: true }).size, 0);

  const toolsOnly = computeFoldLayout(chat.children, {
    ...options,
    hideIntermediateText: false,
  }, timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])));
  assert.equal(toolsOnly.get(first), undefined, "narration stays visible");
  assert.deepEqual([...toolsOnly.keys()], [chat.children[1]]);
  assert.deepEqual(toolsOnly.get(chat.children[1]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 0,
    toolNames: ["read"],
    durationMs: 60_000,
    live: true,
  });
});

test("custom cards stay inside a run and are never folded", () => {
  const chat = new Container();
  class CustomEntryComponent extends Container {}
  const first = assistantComponent(assistant({ timestamp: T0, tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const card = new CustomEntryComponent();
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "…"));
  chat.addChild(card);
  chat.addChild(final);

  const layout = computeFoldLayout(chat.children, options);
  assert.equal(layout.get(card), undefined);
  assert.equal(layout.get(first)?.summary?.toolCount, 1, "the run keeps its summary host");
});

test("summary text is compact and truncates to the render width", () => {
  assert.equal(formatToolNames(["read", "read", "bash"]), "read ×2, bash");
  assert.equal(formatToolNames(["a", "b", "c", "d", "e"]), "a, b, c +2");
  assert.equal(
    formatRunSummary({
      toolCount: 2,
      thinkingRuns: 1,
      toolNames: ["read", "bash"],
      durationMs: 12_340,
      live: false,
    }),
    "▸ read, bash · 1 thinking · 12.3s  (f2 to expand)",
  );
  assert.equal(
    formatRunSummary({ toolCount: 0, thinkingRuns: 2, toolNames: [], live: true, durationMs: 3_400 }),
    "▸ 2 thinking · 3s  (f2 to expand)",
  );

  const wide = plain(renderRunSummaryLines(
    { toolCount: 3, thinkingRuns: 1, toolNames: ["read", "bash", "edit"], durationMs: 4_200, live: false },
    60,
    theme,
  ));
  assert.equal(wide.length, 1);
  assert.match(wide[0]!, /^ ▸ read, bash, edit · 1 thinking · 4\.2s/);
  assert.ok(stripVTControlCharacters(wide[0]!).length <= 60);

  const narrow = plain(renderRunSummaryLines(
    { toolCount: 3, thinkingRuns: 1, toolNames: ["read", "bash", "edit"], durationMs: 4_200, live: false },
    14,
    theme,
  ));
  assert.ok(narrow[0]!.length <= 14);
  assert.match(narrow[0]!, /…$/);
});

test("thinking runs count consecutive thinking blocks only", () => {
  const one = assistantComponent(assistant({ timestamp: T0, thinking: "a", text: "answer" }));
  const two = assistantComponent(assistant({ timestamp: T0, thinking: "a", text: "x" }));
  // Two thinking blocks separated by text are two runs.
  (two as unknown as { lastMessage: AssistantMessage }).lastMessage.content = [
    { type: "thinking", thinking: "a" },
    { type: "text", text: "x" },
    { type: "thinking", thinking: "b" },
  ] as never;
  assert.equal(countThinkingRuns(one), 1);
  assert.equal(countThinkingRuns(two), 2);
  assert.equal(countThinkingRuns(new Container()), 0);
});

test("the render patch folds live components and restores them on dispose", () => {
  const chat = new Container();
  const first = assistantComponent(assistant({ timestamp: T0, text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const tool = toolComponent("t", "read", "hello\nworld");
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "final answer" }));
  chat.addChild(first);
  chat.addChild(tool);
  chat.addChild(final);

  const nativeLines = plain(chat.render(70)).filter(Boolean).length;
  const patch = installRunFoldPatch({ ...options, expanded: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([
    [T0, { startedAt: T0 - 100, completedAt: T0 + 100 }],
    [T0 + 1_000, { startedAt: T0 + 900, completedAt: T0 + 1_900 }],
  ])));
  try {
    const folded = plain(chat.render(70)).filter(Boolean);
    assert.equal(folded.length, 2);
    assert.match(folded[0]!, /▸ read · 2\.0s\s+\(f2 to expand\)/);
    assert.doesNotMatch(folded.join("\n"), /narration|hello|world/);
    assert.match(folded.join("\n"), /final answer/);

    patch.setOptions({ expanded: true });
    const expanded = plain(chat.render(70)).filter(Boolean).length;
    assert.equal(expanded, nativeLines);
  } finally {
    patch.dispose();
  }

  const restored = plain(chat.render(70)).filter(Boolean);
  assert.equal(restored.length, nativeLines);
  assert.match(restored.join("\n"), /narration|hello|world/);
});

test("assertRunFoldPatch re-applies after another party restores the render", () => {
  const chat = new Container();
  const first = assistantComponent(assistant({ timestamp: T0, text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "…"));
  chat.addChild(final);

  const native = AssistantMessageComponent.prototype.render;
  const patch = installRunFoldPatch({ ...options, expanded: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  try {
    assert.notEqual(AssistantMessageComponent.prototype.render, native);
    // Simulate another extension restoring the native method during its reload.
    (AssistantMessageComponent.prototype as unknown as { render: unknown }).render = native;
    assert.equal(AssistantMessageComponent.prototype.render, native);
    assertRunFoldPatch();
    assert.notEqual(AssistantMessageComponent.prototype.render, native);
    const folded = plain(chat.render(70)).filter(Boolean);
    assert.equal(folded.length, 2);
    assert.match(folded[0]!, /▸ read/);
  } finally {
    patch.dispose();
    (AssistantMessageComponent.prototype as unknown as { render: unknown }).render = native;
  }
});

test("folding survives a transcript rebuild (/compact, /tree, resume)", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  const root = new Container();
  const document = new Container();
  const chat = new Container();
  document.addChild(chat);
  root.addChild(document);

  let bridge: { render(width: number): number extends never ? never : string[]; dispose?(): void } | undefined;
  const entries: Array<{ type: string; message: AssistantMessage; timestamp: string }> = [];
  const bridgeTui = root as unknown as TUI;
  (bridgeTui as unknown as { requestRender: () => void }).requestRender = () => {};
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, factory: ((tui: TUI) => typeof bridge) | undefined) {
        bridge?.dispose?.();
        bridge = factory?.(bridgeTui) as typeof bridge;
      },
      notify() {},
    },
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  const intermediate = assistant({
    timestamp: T0,
    thinking: "先看代码",
    tools: [{ id: "t", name: "read" }],
    stopReason: "toolUse",
  });
  const final = assistant({ timestamp: T0 + 5_000, text: "最终回答" });
  entries.push(
    { type: "message", message: intermediate, timestamp: new Date(T0 + 1_000).toISOString() },
    { type: "message", message: final, timestamp: new Date(T0 + 6_000).toISOString() },
  );

  const nativeAssistantRender = AssistantMessageComponent.prototype.render;
  runFoldExtension(pi);
  try {
    await emit("session_start");

    // Pi paints a frame before the first component exists, and rediscovers the
    // chat container on the next frame; the extension therefore folds from the
    // frame after the transcript appears.
    assert.equal(findChatContainer(root), undefined);
    bridge?.render(80);
    chat.addChild(assistantComponent(intermediate));
    chat.addChild(toolComponent("t", "read", "file body"));
    chat.addChild(assistantComponent(final));
    bridge?.render(80); // next frame
    const live = plain(chat.render(70)).filter(Boolean);
    assert.equal(live.length, 2);
    assert.match(live[0]!, /▸ read · 1 thinking · 6\.0s/);

    chat.clear();
    chat.addChild(assistantComponent(intermediate));
    chat.addChild(toolComponent("t", "read", "file body"));
    chat.addChild(assistantComponent(final));
    const rebuilt = plain(chat.render(70)).filter(Boolean);
    assert.equal(rebuilt.length, 2, "folding re-applies to rebuilt components");
    assert.match(rebuilt[0]!, /▸ read · 1 thinking · 6\.0s/, "durations come from session entries");
    assert.match(rebuilt[1]!, /最终回答/);
  } finally {
    await emit("session_shutdown", {});
  }
  assert.equal(AssistantMessageComponent.prototype.render, nativeAssistantRender);
});

test("an aborted run expands again so its error output stays visible", async () => {
  const chat = new Container();
  const aborted = assistant({ timestamp: T0, thinking: "先跑测试", tools: [{ id: "x", name: "bash" }], stopReason: "toolUse" });
  chat.addChild(assistantComponent(aborted));
  const running = new ToolExecutionComponent("bash", "x", {}, {}, undefined, ui, "/local/workspace");
  chat.addChild(running);

  const patch = installRunFoldPatch({ ...options, expanded: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0 }]])));
  try {
    assert.equal(plain(chat.render(70)).filter(Boolean).length, 1, "folded while the tool runs");

    // Pi marks the pending tool as an error during abort recovery.
    running.updateResult({ content: [{ type: "text", text: "Aborted after 1 retry attempt" }], isError: true });
    patch.refresh();
    const settled = plain(chat.render(70)).filter(Boolean);
    assert.match(settled.join("\n"), /先跑测试/);
    assert.match(settled.join("\n"), /Aborted after 1 retry attempt/);
    assert.doesNotMatch(settled.join("\n"), /to expand/);
  } finally {
    patch.dispose();
  }
});

test("findChatContainer locates the container that holds messages", () => {
  const root = new Container();
  const document = new Container();
  const chat = new Container();
  document.addChild(new Container());
  document.addChild(chat);
  root.addChild(document);
  chat.addChild(assistantComponent(assistant({ timestamp: T0, text: "hi" })));

  assert.equal(findChatContainer(root), chat);
  assert.equal(findChatContainer(new Container()), undefined);
});

test("the extension folds a live transcript, toggles with the shortcut, and cleans up", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => unknown }>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut(key: string, shortcut: { handler: (ctx: ExtensionContext) => unknown }) {
      shortcuts.set(key, shortcut);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  const root = new Container();
  const document = new Container();
  const chat = new Container();
  document.addChild(chat);
  root.addChild(document);

  let bridge: { render(width: number): string[]; dispose?(): void } | undefined;
  let renders = 0;
  const bridgeTui = root as unknown as TUI;
  (bridgeTui as unknown as { requestRender: () => void }).requestRender = () => {
    renders += 1;
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, factory: ((tui: TUI) => typeof bridge) | undefined) {
        bridge?.dispose?.();
        bridge = factory?.(bridgeTui);
      },
      notify() {},
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: assistant({ timestamp: T0, text: "restored answer" }),
          timestamp: new Date(T0 + 1_500).toISOString(),
        },
      ],
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  const nativeAssistantRender = AssistantMessageComponent.prototype.render;
  runFoldExtension(pi);
  try {
    await emit("session_start");
    assert.ok(bridge, "render bridge installed");
    assert.deepEqual(bridge!.render(80), [], "bridge never renders rows");
    assert.equal(findChatContainer(root), undefined, "empty transcript has no chat container yet");

    // Pi creates the transcript after session_start.
    const first = assistantComponent(assistant({ timestamp: T0 + 10_000, text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
    chat.addChild(first);
    bridge!.render(80);
    chat.addChild(toolComponent("t", "read", "file body"));
    const final = assistantComponent(assistant({ timestamp: T0 + 12_000, text: "final answer" }));
    chat.addChild(final);

    await emit("message_start", { message: assistant({ timestamp: T0 + 12_000, text: "final answer" }) });
    const folded = plain(chat.render(70)).filter(Boolean);
    assert.equal(folded.length, 2, "summary plus final answer");
    assert.match(folded[0]!, /▸ read · \(f2 to expand\)|▸ read/);
    assert.match(folded[1]!, /final answer/);

    const before = renders;
    await shortcuts.get("f2")!.handler(ctx);
    assert.ok(renders > before, "toggle requests a redraw");
    const expanded = plain(chat.render(70)).filter(Boolean);
    assert.ok(expanded.length > 2);
    assert.match(expanded.join("\n"), /narration|file body/);

    await emit("message_end", { message: assistant({ timestamp: T0 + 12_000, text: "final answer" }) });
    await emit("agent_settled");
  } finally {
    await emit("session_shutdown", {});
  }

  assert.equal(bridge, undefined, "bridge released on shutdown");
  assert.equal(AssistantMessageComponent.prototype.render, nativeAssistantRender);
  assert.doesNotMatch(plain(chat.render(70)).join("\n"), /f2 to expand/);
});
