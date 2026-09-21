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
import { Container, Spacer, Text, TuiAltScreen, TuiMainScreen, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
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
  statusText,
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

// The fully-folded strategy: what the tests below describe when they say a run
// "folds". The shipped default keeps intermediate text visible.
const options: RunFoldOptions = { ...DEFAULT_RUN_FOLD_OPTIONS, hideIntermediateText: true };

function plain(lines: string[]): string[] {
  return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

/**
 * A left click on one row of a component, the way Pi's layout dispatch delivers
 * it: coordinates are local to the component the pointer landed on.
 */
function clickRow(component: Component, y: number) {
  return component.handleMouse?.({
    type: "click",
    button: "left",
    x: 2,
    y,
    screenX: 2,
    screenY: 10,
    width: 70,
    height: component.render(70).length,
    shift: false,
    alt: false,
    ctrl: false,
  });
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

test("a settled answer folds its reasoning and an answerless run keeps its output", () => {
  const chat = new Container();
  const only = assistantComponent(assistant({ timestamp: T0, thinking: "hmm", text: "answer" }));
  const trailingTool = toolComponent("t1", "read", "…");
  chat.addChild(only);
  chat.addChild(trailingTool);
  // The run's only folded content is the reasoning inside its answer: the
  // answer stays and hosts the summary, so the reasoning is never lost.
  const layout = computeFoldLayout(chat.children, options);
  const entry = layout.get(only);
  assert.equal(entry?.hidden, false, "the answer stays visible");
  assert.deepEqual(entry?.mask, { thinking: true }, "its reasoning folds into the summary");
  assert.equal(entry?.summary?.thinkingRuns, 1);
  assert.equal(layout.get(trailingTool), undefined, "a plain trailing tool is a boundary, not part of the run");

  // An aborted run leaves settled tool output behind, and it ends the transcript
  // here: that output is the result the user needs, so it is never folded away.
  const aborted = new Container();
  const intermediate = assistantComponent(
    assistant({ timestamp: T0, tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }),
  );
  aborted.addChild(intermediate);
  aborted.addChild(toolComponent("t", "read", "error: aborted"));
  assert.equal(computeFoldLayout(aborted.children, options).size, 0);

  // While a tool is still running there is no answer yet, but the run is
  // clearly in flight: its finished steps fold and the running tool - the live
  // tail - stays on screen.
  const running = new Container();
  const pending = new ToolExecutionComponent("read", "t", {}, {}, undefined, ui, "/local/workspace");
  running.addChild(intermediate);
  running.addChild(pending);
  const live = computeFoldLayout(running.children, options, timingsSource(new Map([[T0, { startedAt: T0 }]])));
  assert.deepEqual([...live.keys()], [intermediate], "only the finished step is hidden");
  assert.deepEqual(live.get(intermediate)?.summary, {
    toolCount: 0,
    thinkingRuns: 0,
    toolNames: [],
    durationMs: 60_000,
    live: true,
  });
});

test("a settled answer keeps its text and folds its reasoning into the summary", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "先看测试",
      text: "让我看一下。",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  const final = assistantComponent(
    assistant({ timestamp: T0 + 5_000, thinking: "测试入口在 package.json", text: "答案是 bun test。" }),
  );
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "file body"));
  chat.addChild(final);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([
    [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
    [T0 + 5_000, { startedAt: T0 + 5_000, completedAt: T0 + 9_000 }],
  ])));
  try {
    const lines = plain(chat.render(70)).filter(Boolean);
    // The answer's reasoning has no mark of its own: the run's last mark already
    // sits right above the answer, so it takes that reasoning with it.
    assert.match(lines[0]!, /▸ read · 2 thinking · 9\.0s\s+\(f2 to expand\)/, "both reasoning runs count");
    assert.doesNotMatch(lines.join("\n"), /▸ 1 thinking/, "the answer does not print a second mark");
    assert.match(lines.join("\n"), /答案是 bun test。/, "the answer text stays");
    assert.doesNotMatch(lines.join("\n"), /测试入口在 package\.json/, "the answer's reasoning is masked");
    assert.doesNotMatch(lines.join("\n"), /先看测试|让我看一下|file body/, "the steps stay folded");

    patch.toggle(); // F2 brings the native rendering back, reasoning included
    assert.match(plain(chat.render(70)).join("\n"), /测试入口在 package\.json/);
    patch.toggle();
    assert.doesNotMatch(plain(chat.render(70)).join("\n"), /测试入口在 package\.json/);
  } finally {
    patch.dispose();
  }
});

test("reasoning stays while it is the live tail and folds as soon as text arrives", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({ timestamp: T0, tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }),
  );
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "file body"));
  const answer = assistantComponent(assistant({ timestamp: T0 + 5_000, thinking: "正在推理" }));
  chat.addChild(answer);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])));
  patch.setRunActive(true);
  patch.refresh();
  try {
    // The reasoning is the newest activity: it is on screen, and the steps
    // before it are already folded.
    const live = plain(chat.render(70)).join("\n");
    assert.match(live, /正在推理/);
    assert.match(live, /▸ read · \d+s/, "the finished step is folded while the tail streams");

    // The same message starts emitting text: the reasoning is history now.
    answer.updateContent(assistant({ timestamp: T0 + 5_000, thinking: "正在推理", text: "答案来了" }), true);
    patch.refresh();
    const folded = plain(chat.render(70)).join("\n");
    assert.match(folded, /答案来了/);
    assert.doesNotMatch(folded, /正在推理/);
    assert.match(folded, /1 thinking/, "the masked reasoning joins the summary");
  } finally {
    patch.dispose();
  }
});

test("reasoning of a visible step folds without leaving a blank row behind", () => {
  const chat = new Container();
  // With intermediate text shown, a thinking-then-tool message stays visible - 
  // but its reasoning is history, and masking it would leave nothing behind.
  const step = assistantComponent(
    assistant({ timestamp: T0, thinking: "只有思考", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }),
  );
  chat.addChild(step);
  chat.addChild(new ToolExecutionComponent("read", "t", {}, {}, undefined, ui, "/local/workspace"));

  const patch = installRunFoldPatch({ ...options, hideIntermediateText: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  patch.setRunActive(true);
  patch.refresh();
  try {
    const lines = plain(chat.render(70)).filter(Boolean);
    assert.match(lines[0]!, /▸ 1 thinking · \d+s\s+\(f2 to expand\)/, "the step's reasoning is summarized");
    assert.doesNotMatch(lines.join("\n"), /只有思考/);
    assert.equal(
      lines.filter((line) => line.includes("只有思考")).length,
      0,
      "the masked reasoning leaves no blank row where the message was",
    );
  } finally {
    patch.dispose();
  }
});

test("reasoning wrapped for mouse handling is masked the same way", () => {
  const chat = new Container();
  const answer = assistantComponent(assistant({ timestamp: T0, thinking: "包起来的推理", text: "可见答案" }));
  // Pi 0.85+ wraps each reasoning child in a MouseRegion; masking must work on
  // the wrapper without changing the child count the layout mirror sees.
  const content = (answer as unknown as { contentContainer: { children: unknown[] } }).contentContainer;
  const reasoning = content.children[1] as { render(width: number): string[]; invalidate?(): void };
  content.children[1] = {
    child: reasoning,
    render: (width: number) => reasoning.render(width),
    invalidate: () => reasoning.invalidate?.(),
  };
  chat.addChild(answer);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  try {
    const rendered = plain(chat.render(70)).join("\n");
    assert.match(rendered, /可见答案/);
    assert.doesNotMatch(rendered, /包起来的推理/);
    assert.match(rendered, /1 thinking/);
  } finally {
    patch.dispose();
  }
});

test("an unrecognized message layout falls back to native rendering", () => {
  const chat = new Container();
  const answer = assistantComponent(assistant({ timestamp: T0, thinking: "推理内容", text: "答案内容" }));
  const content = (answer as unknown as { contentContainer: { children: unknown[] } }).contentContainer;
  // Simulate a Pi release that builds a layout this module does not know: the
  // reasoning must stay visible instead of being mangled or hidden by mistake.
  content.children.push({ render: () => ["unexpected"], invalidate() {} });
  chat.addChild(answer);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  try {
    const rendered = plain(chat.render(70)).join("\n");
    assert.match(rendered, /推理内容/);
    assert.match(rendered, /答案内容/);
  } finally {
    patch.dispose();
  }
});

test("turning folding off, and keeping a kind of content, change what is folded", () => {
  const chat = new Container();
  const first = assistantComponent(assistant({ timestamp: T0, thinking: "a", text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "…"));
  chat.addChild(final);

  assert.equal(computeFoldLayout(chat.children, { ...options, folded: false }).size, 0);

  const toolsOnly = computeFoldLayout(chat.children, {
    ...options,
    hideIntermediateText: false,
  }, timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])));
  assert.equal(toolsOnly.get(first)?.hidden, false, "narration stays visible");
  assert.deepEqual(toolsOnly.get(first)?.mask, { thinking: true }, "its reasoning still folds");
  assert.equal(toolsOnly.size, 2, "the tool folds and hosts the summary");
  assert.deepEqual(toolsOnly.get(chat.children[1]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 1,
    toolNames: ["read"],
    durationMs: 60_000,
    live: true,
  });
});

test("the shipped default keeps intermediate text and folds tools and thinking", () => {
  const chat = new Container();
  const step = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "hmm",
      text: "narration",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(step);
  chat.addChild(toolComponent("t", "read", "file body"));
  chat.addChild(final);

  const layout = computeFoldLayout(
    chat.children,
    DEFAULT_RUN_FOLD_OPTIONS,
    timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])),
  );
  assert.equal(layout.get(step)?.hidden, false, "the step stays: its text is not folded");
  assert.deepEqual(layout.get(step)?.mask, { thinking: true }, "only its reasoning goes");
  // The tool row is the first thing the fold takes away whole, so it hosts the
  // summary; the narration above it is untouched.
  assert.equal(layout.get(chat.children[1]!)?.hidden, true);
  assert.deepEqual(layout.get(chat.children[1]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 1,
    toolNames: ["read"],
    durationMs: 60_000,
    live: true,
  });
  assert.equal(layout.get(final), undefined, "the answer renders natively");
});

test("keeping thinking while folding text leaves the reasoning in place", () => {
  const chat = new Container();
  const step = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "想一想",
      text: "半截正文",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(step);
  chat.addChild(toolComponent("t", "read", "file body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "答案" })));

  const patch = installRunFoldPatch({ hideIntermediateText: true, hideThinking: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  try {
    const lines = plain(chat.render(70));
    const rendered = lines.join("\n");
    assert.match(rendered, /想一想/, "the reasoning survives");
    assert.doesNotMatch(rendered, /半截正文/, "the step's text is masked");
    assert.doesNotMatch(rendered, /file body/, "the tool row is still folded");
    assert.match(rendered, /答案/, "the answer follows");
    // The summary block leads with its own blank line; a masked text row that
    // left one behind would put a second blank between it and the reasoning.
    const reasoningAt = lines.findIndex((line) => /想一想/.test(line));
    const summaryAt = lines.findIndex((line) => /▸ read/.test(line));
    assert.equal(summaryAt - reasoningAt, 2, "no blank row is left where the text was");
  } finally {
    patch.dispose();
  }
});

test("masking text never takes the truncation note with it", () => {
  const chat = new Container();
  const step = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "想一想",
      text: "半截正文",
      tools: [{ id: "t", name: "read" }],
      stopReason: "length",
    }),
  );
  chat.addChild(step);
  chat.addChild(toolComponent("t", "read", "file body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "答案" })));

  const patch = installRunFoldPatch({ hideIntermediateText: true, hideThinking: false });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  try {
    const rendered = plain(chat.render(70)).join("\n");
    assert.doesNotMatch(rendered, /半截正文/, "the step's text is masked");
    assert.match(rendered, /想一想/, "its reasoning survives");
    assert.match(rendered, /Response was truncated before completion/, "the result row is not content");
  } finally {
    patch.dispose();
  }
});

test("every folded stretch between two visible steps gets its own summary", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "想",
      text: "first narration",
      tools: [{ id: "a", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  // A step with no reasoning of its own has nothing to fold, so it stays on
  // screen and ends the stretch above it.
  const second = assistantComponent(
    assistant({ timestamp: T0 + 3_000, text: "second narration", tools: [{ id: "b", name: "bash" }], stopReason: "toolUse" }),
  );
  const third = assistantComponent(
    assistant({ timestamp: T0 + 6_000, text: "third narration", tools: [{ id: "c", name: "grep" }], stopReason: "toolUse" }),
  );
  const answer = assistantComponent(assistant({ timestamp: T0 + 9_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("a", "read", "body"));
  chat.addChild(second);
  chat.addChild(toolComponent("b", "bash", "body"));
  chat.addChild(third);
  chat.addChild(toolComponent("c", "grep", "body"));
  chat.addChild(answer);

  const timings = timingsSource(
    new Map([
      [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
      [T0 + 3_000, { startedAt: T0 + 3_500, completedAt: T0 + 4_000 }],
      [T0 + 6_000, { startedAt: T0 + 6_500, completedAt: T0 + 7_000 }],
      [T0 + 9_000, { startedAt: T0 + 9_500, completedAt: T0 + 12_000 }],
    ]),
  );
  const layout = computeFoldLayout(chat.children, DEFAULT_RUN_FOLD_OPTIONS, timings);

  assert.deepEqual(layout.get(first), {
    hidden: false,
    mask: { thinking: true },
    keepTrailingReasoning: false,
  });
  assert.deepEqual(layout.get(second), undefined, "a step with nothing to fold stays native");
  assert.deepEqual(layout.get(third), undefined);
  assert.deepEqual(layout.get(answer), undefined);

  // One summary per stretch, counting only what that stretch took away. The
  // shells tile the run: each starts where the next visible message started and
  // the last one ends where the run did.
  assert.deepEqual(layout.get(chat.children[1]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 1,
    toolNames: ["read"],
    durationMs: 3_500,
    live: false,
  });
  assert.deepEqual(layout.get(chat.children[3]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 0,
    toolNames: ["bash"],
    durationMs: 3_000,
    live: false,
  });
  assert.deepEqual(layout.get(chat.children[5]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 0,
    toolNames: ["grep"],
    durationMs: 5_500,
    live: false,
  });
  assert.equal(layout.size, 4, "the masked step and the three folded tool rows");
});

test("the summaries land between the visible steps, not once at the top", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({ timestamp: T0, thinking: "想", text: "first narration", tools: [{ id: "a", name: "read" }], stopReason: "toolUse" }),
  );
  const second = assistantComponent(
    assistant({ timestamp: T0 + 3_000, text: "second narration", tools: [{ id: "b", name: "bash" }], stopReason: "toolUse" }),
  );
  const answer = assistantComponent(assistant({ timestamp: T0 + 6_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("a", "read", "tool body one"));
  chat.addChild(second);
  chat.addChild(toolComponent("b", "bash", "tool body two"));
  chat.addChild(answer);

  const patch = installRunFoldPatch(DEFAULT_RUN_FOLD_OPTIONS);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])));
  try {
    const lines = plain(chat.render(70)).filter((line) => line.trim() !== "");
    const summaryRows = lines.filter((line) => line.includes("▸"));
    assert.equal(summaryRows.length, 2, "one fold mark per stretch");
    assert.match(summaryRows[0]!, /▸ read/);
    assert.match(summaryRows[1]!, /▸ bash/);
    assert.doesNotMatch(summaryRows.join("\n"), /×2/);
    assert.deepEqual(
      lines.map((line) => (line.includes("▸") ? "summary" : line.trim().startsWith("first") ? "first" : line.trim().startsWith("second") ? "second" : "other")),
      ["first", "summary", "second", "summary", "other"],
      "each summary sits where the content it folded used to be",
    );
  } finally {
    patch.dispose();
  }
});

test("a row that renders nothing does not split a stretch", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({ timestamp: T0, thinking: "想", text: "narration", tools: [{ id: "a", name: "edit" }], stopReason: "toolUse" }),
  );
  // Pi draws a message whose only content is the tool call as zero rows: it is
  // neither folded nor visible, so it cannot end the stretch around it.
  const callOnly = assistantComponent(
    assistant({ timestamp: T0 + 1_000, tools: [{ id: "b", name: "bash" }], stopReason: "toolUse" }),
  );
  const answer = assistantComponent(assistant({ timestamp: T0 + 2_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("a", "edit", "--- a"));
  chat.addChild(callOnly);
  chat.addChild(toolComponent("b", "bash", "ok"));
  chat.addChild(answer);

  const timings = timingsSource(
    new Map([
      [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
      [T0 + 1_000, { startedAt: T0 + 1_000, completedAt: T0 + 1_500 }],
      [T0 + 2_000, { startedAt: T0 + 2_000, completedAt: T0 + 3_000 }],
    ]),
  );
  const layout = computeFoldLayout(chat.children, DEFAULT_RUN_FOLD_OPTIONS, timings);

  assert.equal(layout.get(callOnly), undefined, "the empty message keeps rendering natively");
  assert.deepEqual(layout.get(chat.children[1]!)?.summary, {
    toolCount: 2,
    thinkingRuns: 1,
    toolNames: ["edit", "bash"],
    durationMs: 3_000,
    live: false,
  });
  assert.equal(layout.get(chat.children[3]!)?.summary, undefined, "no second summary for the same stretch");
  assert.equal(layout.size, 3, "the masked step and the two folded tool rows");

  const patch = installRunFoldPatch(DEFAULT_RUN_FOLD_OPTIONS);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timings);
  try {
    const lines = plain(chat.render(70)).filter((line) => line.trim() !== "");
    assert.equal(
      lines.filter((line) => line.includes("▸")).length,
      1,
      "one fold mark, not two stacked with nothing in between",
    );
  } finally {
    patch.dispose();
  }
});

test("a masked step that keeps its text ends the stretch above it", () => {
  const chat = new Container();
  const first = assistantComponent(
    assistant({ timestamp: T0, thinking: "想", text: "first narration", tools: [{ id: "a", name: "read" }], stopReason: "toolUse" }),
  );
  const second = assistantComponent(
    assistant({ timestamp: T0 + 3_000, thinking: "再想", text: "second narration", tools: [{ id: "b", name: "bash" }], stopReason: "toolUse" }),
  );
  const answer = assistantComponent(assistant({ timestamp: T0 + 6_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("a", "read", "tool body one"));
  chat.addChild(second);
  chat.addChild(toolComponent("b", "bash", "tool body two"));
  chat.addChild(answer);

  const timings = timingsSource(
    new Map([
      [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
      [T0 + 3_000, { startedAt: T0 + 4_000, completedAt: T0 + 5_000 }],
      [T0 + 6_000, { startedAt: T0 + 7_000, completedAt: T0 + 8_000 }],
    ]),
  );
  const layout = computeFoldLayout(chat.children, DEFAULT_RUN_FOLD_OPTIONS, timings);

  // Both steps render their narration, so each one's folded reasoning and the
  // tool row below it belong to their own mark. Whether the provider happened to
  // return reasoning for a step must not move the marks: the reader sees the
  // same paragraph either way.
  assert.deepEqual(layout.get(chat.children[1]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 1,
    toolNames: ["read"],
    durationMs: 4_000,
    live: false,
  });
  assert.deepEqual(layout.get(chat.children[3]!)?.summary, {
    toolCount: 1,
    thinkingRuns: 1,
    toolNames: ["bash"],
    // The last mark runs to the end of the run, so the marks add up to the run's
    // own clock instead of dropping whatever the answer spent streaming.
    durationMs: 4_000,
    live: false,
  });

  const patch = installRunFoldPatch(DEFAULT_RUN_FOLD_OPTIONS);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timings);
  try {
    const lines = plain(chat.render(70)).filter((line) => line.trim() !== "");
    assert.deepEqual(
      lines.map((line) =>
        line.includes("▸") ? "summary" : line.trim().startsWith("first") ? "first" : line.trim().startsWith("second") ? "second" : "answer",
      ),
      ["first", "summary", "second", "summary", "answer"],
      "each narration keeps its own mark under it",
    );
  } finally {
    patch.dispose();
  }
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
  assert.equal(wide.length, 2, "the summary block keeps one blank line above it");
  assert.equal(wide[0], "");
  assert.match(wide[1]!, /^ ▸ read, bash, edit · 1 thinking · 4\.2s/);
  assert.ok(stripVTControlCharacters(wide[1]!).length <= 60);

  const narrow = plain(renderRunSummaryLines(
    { toolCount: 3, thinkingRuns: 1, toolNames: ["read", "bash", "edit"], durationMs: 4_200, live: false },
    14,
    theme,
  ));
  assert.equal(narrow.length, 2);
  assert.ok(narrow[1]!.length <= 14);
  assert.match(narrow[1]!, /…$/);
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
  const patch = installRunFoldPatch(options);
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

    patch.setOptions({ folded: false });
    const expanded = plain(chat.render(70)).filter(Boolean).length;
    assert.equal(expanded, nativeLines);
  } finally {
    patch.dispose();
  }

  const restored = plain(chat.render(70)).filter(Boolean);
  assert.equal(restored.length, nativeLines);
  assert.match(restored.join("\n"), /narration|hello|world/);
});

test("clicking a summary row opens its stretch and clicking it again folds it back", () => {
  const chat = new Container();
  const step = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "先看测试",
      text: "first narration",
      tools: [{ id: "a", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  const answer = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "first answer" }));
  // The answer's own reasoning is a stretch of its own: it folds into a summary
  // row that the answer itself hosts, above content that stays on screen.
  const second = assistantComponent(
    assistant({ timestamp: T0 + 5_000, thinking: "再看一遍", text: "second answer" }),
  );
  chat.addChild(step);
  chat.addChild(toolComponent("a", "read", "file body"));
  chat.addChild(answer);
  chat.addChild(new UserMessageComponent("换个方向", markdownTheme, 1, []));
  chat.addChild(second);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setClickToToggle(true);
  patch.setTimingSource(
    timingsSource(
      new Map([
        [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
        [T0 + 1_000, { startedAt: T0 + 1_500, completedAt: T0 + 2_000 }],
        [T0 + 5_000, { startedAt: T0 + 5_000, completedAt: T0 + 6_000 }],
      ]),
    ),
  );
  try {
    const folded = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(folded, /▸ read · 1 thinking · 2\.0s\s{2}\(click or f2 to expand\)/);
    assert.match(folded, /▸ 1 thinking · 1\.0s\s{2}\(click or f2 to expand\)/);
    assert.doesNotMatch(folded, /first narration|file body|先看测试|再看一遍/);

    assert.notEqual(step.handleMouse, Container.prototype.handleMouse, "the summary row is reachable");
    assert.equal(clickRow(step, 0), undefined, "the blank row above the summary is not a target");
    assert.deepEqual(clickRow(step, 1), { handled: true });

    const opened = plain(chat.render(70)).join("\n");
    assert.match(opened, /▾ read · 1 thinking · 2\.0s\s{2}\(click to collapse\)/);
    assert.match(opened, /first narration/);
    assert.match(opened, /file body/);
    assert.match(opened, /先看测试/, "the stretch opens everything it folded, reasoning included");
    assert.match(opened, /▸ 1 thinking · 1\.0s\s{2}\(click or f2 to expand\)/, "expanding is per stretch");
    assert.doesNotMatch(opened, /再看一遍/);

    assert.deepEqual(clickRow(step, 1), { handled: true });
    const refolded = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(refolded, /▸ read · 1 thinking · 2\.0s\s{2}\(click or f2 to expand\)/);
    assert.doesNotMatch(refolded, /first narration|file body/);

    // The second stretch folds content out of a message that stays visible, so
    // opening it leaves the paragraph alone and brings back only the reasoning.
    assert.deepEqual(clickRow(second, 1), { handled: true });
    const secondOpened = plain(chat.render(70)).join("\n");
    assert.match(secondOpened, /▾ 1 thinking · 1\.0s\s{2}\(click to collapse\)/);
    assert.match(secondOpened, /再看一遍/);
    assert.match(secondOpened, /second answer/);
    assert.doesNotMatch(secondOpened, /first narration|file body/, "the first stretch is still folded");
  } finally {
    patch.dispose();
  }
});

test("a summary row names the mouse only where the TUI routes it, and dispose puts the host back", () => {
  const chat = new Container();
  const step = assistantComponent(
    assistant({ timestamp: T0, text: "narration", tools: [{ id: "a", name: "read" }], stopReason: "toolUse" }),
  );
  const tool = toolComponent("a", "read", "file body");
  chat.addChild(step);
  chat.addChild(tool);
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" })));

  const patch = installRunFoldPatch(DEFAULT_RUN_FOLD_OPTIONS);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(
    timingsSource(
      new Map([
        [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
        [T0 + 1_000, { startedAt: T0 + 1_500, completedAt: T0 + 2_000 }],
      ]),
    ),
  );
  try {
    // Regular mode hands the scrollback to the terminal, which never reports a
    // click on it: the row keeps naming the key, and the host keeps Pi's handler.
    const keyOnly = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(keyOnly, /▸ read · 2\.0s\s{2}\(f2 to expand\)/);
    assert.equal(tool.handleMouse, ToolExecutionComponent.prototype.handleMouse);

    patch.setClickToToggle(true);
    patch.refresh();
    const clickable = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(clickable, /▸ read · 2\.0s\s{2}\(click or f2 to expand\)/);
    assert.notEqual(tool.handleMouse, ToolExecutionComponent.prototype.handleMouse);

    // Every other row of a tool stays Pi's business: its own handler forwards
    // clicks into the output it drew, and must not be swallowed by ours.
    assert.equal(clickRow(tool, 3), undefined);
    assert.match(
      plain(chat.render(70)).filter(Boolean).join("\n"),
      /▸ read · 2\.0s\s{2}\(click or f2 to expand\)/,
    );
  } finally {
    patch.dispose();
  }
  assert.equal(tool.handleMouse, ToolExecutionComponent.prototype.handleMouse, "given back on dispose");
});

test("every other row of a host still reaches Pi's own mouse handlers", () => {
  const chat = new Container();
  // Folding the step's text keeps its reasoning on screen, where Pi wrapped it
  // in a mouse region of its own - and the message is the stretch's host, so the
  // summary row now sits above everything that region measures from.
  const first = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "先看测试",
      text: "first narration",
      tools: [{ id: "a", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(first);
  chat.addChild(toolComponent("a", "read", "file body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "first answer" })));

  const patch = installRunFoldPatch({
    folded: true,
    hideIntermediateText: true,
    hideThinking: false,
    hideToolCalls: false,
  });
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setClickToToggle(true);
  patch.setTimingSource(
    timingsSource(
      new Map([
        [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
        [T0 + 1_000, { startedAt: T0 + 1_500, completedAt: T0 + 2_000 }],
      ]),
    ),
  );
  try {
    const rows = plain(first.render(70));
    assert.match(rows[1]!, /▸ 2\.0s\s{2}\(click or f2 to expand\)/, "the message hosts the summary");
    const thinkingRow = rows.findIndex((line) => line.includes("先看测试"));
    assert.ok(thinkingRow > 1, "the reasoning is under the summary block");

    assert.equal(clickRow(first, thinkingRow)?.handled, true, "Pi's mouse region took the click");
    const after = plain(first.render(70)).join("\n");
    assert.doesNotMatch(after, /先看测试/, "Pi's own toggle closed the reasoning");
    assert.match(after, /Thinking\.\.\./, "and drew its collapsed label");
    assert.match(after, /▸ 2\.0s\s{2}\(click or f2 to expand\)/, "the stretch itself stayed folded");
  } finally {
    patch.dispose();
  }
});

test("assertRunFoldPatch re-applies after another party restores the render", () => {
  const chat = new Container();
  const first = assistantComponent(assistant({ timestamp: T0, text: "narration", tools: [{ id: "t", name: "read" }], stopReason: "toolUse" }));
  const final = assistantComponent(assistant({ timestamp: T0 + 1_000, text: "answer" }));
  chat.addChild(first);
  chat.addChild(toolComponent("t", "read", "…"));
  chat.addChild(final);

  const native = AssistantMessageComponent.prototype.render;
  const patch = installRunFoldPatch(options);
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
      setStatus() {},
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

test("a steer folds the steps it cut off instead of leaving them expanded", () => {
  const chat = new Container();
  // A steer arrives the way Pi renders one: the interrupted run, then the spacer
  // and `UserMessageComponent` a fresh prompt gets too. Nothing in those
  // components says "steer" - what says it is that the run before them never
  // answered, because the steer took the answer away from it.
  chat.addChild(
    assistantComponent(
      assistant({
        timestamp: T0,
        thinking: "先看看这个",
        tools: [{ id: "a", name: "read" }],
        stopReason: "toolUse",
      }),
    ),
  );
  chat.addChild(toolComponent("a", "read", "file body"));
  chat.addChild(new Spacer(1));
  chat.addChild(new UserMessageComponent("请你先说说方案", markdownTheme));
  // The run the steer started ends in an answer and folds as it always did.
  chat.addChild(
    assistantComponent(
      assistant({
        timestamp: T0 + 10_000,
        thinking: "他说要方案",
        tools: [{ id: "b", name: "bash" }],
        stopReason: "toolUse",
      }),
    ),
  );
  chat.addChild(toolComponent("b", "bash", "output body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 20_000, thinking: "方案从这里开始", text: "方案如下。" })));

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(
    timingsSource(
      new Map([
        [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
        [T0 + 10_000, { startedAt: T0 + 10_000, completedAt: T0 + 12_000 }],
        [T0 + 20_000, { startedAt: T0 + 20_000, completedAt: T0 + 25_000 }],
      ]),
    ),
  );
  try {
    const text = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(text, /▸ read · 1 thinking · 1\.0s\s+\(f2 to expand\)/, "the cut-off steps fold into a mark");
    assert.doesNotMatch(text, /先看看这个|file body/, "and nothing of them stays on screen");
    assert.match(text, /请你先说说方案/, "the steer itself stays where Pi put it");
    assert.match(text, /▸ bash · 2 thinking · 15\.0s/, "the run it started folds as usual");
    assert.match(text, /方案如下。/, "and keeps its answer");
    assert.doesNotMatch(text, /方案从这里开始/, "the answer's reasoning folds into that mark");

    // The steer landed while the agent was still working, which is when this has
    // to hold: the cut-off steps are already history on that frame, not once the
    // run after them settles.
    patch.setRunActive(true);
    patch.refresh();
    const live = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(live, /▸ read · 1 thinking · 1\.0s/, "the cut-off steps stay folded while the agent works");
    assert.doesNotMatch(live, /先看看这个|file body/);
    assert.match(live, /请你先说说方案/);
  } finally {
    patch.dispose();
  }
});

test("an aborted run keeps its error row on screen, and nothing else once a boundary arrives", async () => {
  const chat = new Container();
  const aborted = assistant({ timestamp: T0, thinking: "先跑测试", tools: [{ id: "x", name: "bash" }], stopReason: "toolUse" });
  chat.addChild(assistantComponent(aborted));
  const running = new ToolExecutionComponent("bash", "x", {}, {}, undefined, ui, "/local/workspace");
  chat.addChild(running);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0 }]])));
  try {
    const rows = plain(chat.render(70));
    const live = rows.filter(Boolean);
    assert.match(live[0]!, /▸ 1 thinking · \d+s\s+\(f2 to expand\)/, "the finished step folds into the summary");
    assert.doesNotMatch(live.join("\n"), /先跑测试/, "the folded reasoning is gone");
    // The fold takes whole rows or nothing: what is left of the running tool is
    // exactly what Pi draws for it.
    const runningRows = plain(running.render(70));
    assert.deepEqual(rows.slice(-runningRows.length), runningRows, "the running bash tool is the live tail");

    // Pi marks the pending tool as an error during abort recovery.
    running.updateResult({ content: [{ type: "text", text: "Aborted after 1 retry attempt" }], isError: true });
    patch.refresh();
    const settled = plain(chat.render(70)).filter(Boolean);
    assert.match(settled.join("\n"), /先跑测试/);
    assert.match(settled.join("\n"), /Aborted after 1 retry attempt/);
    assert.doesNotMatch(settled.join("\n"), /to expand/);

    // The next prompt makes the aborted run a superseded one: its step is history
    // now, so it folds - and the row the run failed on is all that stays, because
    // that error output is the result the reader is after.
    chat.addChild(new Spacer(1));
    chat.addChild(new UserMessageComponent("换个方向", markdownTheme));
    patch.refresh();
    const afterNextPrompt = plain(chat.render(70)).filter(Boolean).join("\n");
    assert.match(afterNextPrompt, /▸ 1 thinking · \d+s\s+\(f2 to expand\)/, "the step folds under its own mark");
    assert.doesNotMatch(afterNextPrompt, /先跑测试/, "and takes its reasoning with it");
    assert.match(afterNextPrompt, /Aborted after 1 retry attempt/, "the failing row stays");
    assert.match(afterNextPrompt, /换个方向/, "as does the prompt that cut the run off");
  } finally {
    patch.dispose();
  }
});

test("a failed run folds the steps that led to it and keeps only the row it failed on", () => {
  const chat = new Container();
  // The shape a real session left behind: three steps, the last one interrupted,
  // and Pi's abort recovery marking the tool that was running as an error. The
  // error row is the result; the two steps before it are history.
  chat.addChild(
    assistantComponent(
      assistant({
        timestamp: T0,
        thinking: "先撤掉上次那个 pick",
        text: "明白，开始整改。",
        tools: [{ id: "a", name: "bash" }],
        stopReason: "toolUse",
      }),
    ),
  );
  chat.addChild(toolComponent("a", "bash", "HEAD is now at 6cf7c1256d"));
  chat.addChild(
    assistantComponent(
      assistant({
        timestamp: T0 + 5_000,
        thinking: "核对一致性",
        tools: [{ id: "b", name: "bash" }],
        stopReason: "toolUse",
      }),
    ),
  );
  chat.addChild(toolComponent("b", "bash", "M  epros-i18n/…"));
  chat.addChild(
    assistantComponent(
      assistant({
        timestamp: T0 + 11_000,
        thinking: "再验一次",
        tools: [{ id: "c", name: "bash" }],
        stopReason: "aborted",
      }),
    ),
  );
  // Pi marks every tool still running when it aborts as an error, with the abort
  // reason as its output (`interactive-mode.ts`, the `message_end` branch).
  const abortedTool = new ToolExecutionComponent("bash", "c", {}, {}, undefined, ui, "/local/workspace");
  abortedTool.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
  chat.addChild(abortedTool);
  chat.addChild(new Spacer(1));
  chat.addChild(new UserMessageComponent("不是合并成一个提交，你就直接去掉再重新迁移就行。", markdownTheme));

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(
    timingsSource(
      new Map([
        [T0, { startedAt: T0, completedAt: T0 + 1_000 }],
        [T0 + 5_000, { startedAt: T0 + 5_000, completedAt: T0 + 6_000 }],
        [T0 + 11_000, { startedAt: T0 + 11_000, completedAt: T0 + 12_000 }],
      ]),
    ),
  );
  try {
    const lines = plain(chat.render(70));
    const text = lines.filter(Boolean).join("\n");
    assert.equal(lines.filter((line) => line.includes("▸")).length, 1, "the three steps fold into one mark");
    assert.match(text, /▸ bash ×2 · 3 thinking · 12\.0s\s+\(f2 to expand\)/, "the mark counts what it took away");
    assert.doesNotMatch(
      text,
      /先撤掉上次那个 pick|明白，开始整改|HEAD is now at|核对一致性|再验一次/,
      "nothing of the steps that led to the failure stays",
    );
    assert.match(text, /Operation aborted/, "the row the run failed on stays");
    assert.match(text, /不是合并成一个提交/, "and so does the prompt that cut the run off");
  } finally {
    patch.dispose();
  }
});

test("the extension offers the mouse only where Pi routes it", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  const root = new Container();
  const chat = new Container();
  root.addChild(chat);
  const bridgeTui = root as unknown as TUI;
  const setMode = (mode: "regular" | "fullscreen") => {
    (bridgeTui as unknown as { mode: string }).mode = mode;
  };
  setMode("fullscreen");
  (root as unknown as { requestRender: () => void }).requestRender = () => {};

  let bridge: { render(width: number): string[] } | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, factory: ((tui: TUI) => unknown) | undefined) {
        bridge = factory?.(bridgeTui) as { render(width: number): string[] } | undefined;
      },
      setStatus() {},
      notify() {},
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  runFoldExtension(pi);
  try {
    await emit("session_start");
    // A run in flight: its finished step folds, the tool it is running stays.
    const message = assistant({
      timestamp: T0,
      thinking: "先看测试",
      text: "narration",
      tools: [{ id: "a", name: "read" }],
      stopReason: "toolUse",
    });
    await emit("message_start", { message });
    const step = assistantComponent(message);
    chat.addChild(step);
    const tool = toolComponent("a", "read", "file body");
    chat.addChild(tool);
    bridge!.render(80); // the bridge frame that discovers the chat container

    assert.match(plain(chat.render(80)).join("\n"), /▸ 1 thinking · 0s\s{2}\(click or f2 to expand\)/);
    assert.notEqual(step.handleMouse, AssistantMessageComponent.prototype.handleMouse);

    // Pi rebuilt its renderer without mouse input: the row stops offering it.
    setMode("regular");
    bridge!.render(80);
    assert.match(plain(chat.render(80)).join("\n"), /▸ 1 thinking · 0s\s{2}\(f2 to expand\)/);
    assert.equal(step.handleMouse, AssistantMessageComponent.prototype.handleMouse);
  } finally {
    await emit("session_shutdown", {});
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

test("/run-fold command and value aliases reach the same branch as their canonical names", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    on() {},
    registerShortcut() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  // The command echoes `describeOptions()` after every branch, so two runs that
  // land on the same option state report the same text.
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setStatus() {},
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;

  runFoldExtension(pi);
  const run = async (args: string) => {
    notifications.length = 0;
    await commands.get("run-fold")!.handler(args, ctx);
    return notifications.at(-1);
  };

  assert.equal(await run("intermediateText on"), await run("text on"), "intermediateText is text");
  assert.equal(await run("intermediateText off"), await run("text off"), "and off is off either way");
  assert.equal(await run("toolcalls on"), await run("tool on"), "tool is toolcalls");
  assert.equal(await run("toolcalls off"), await run("tool off"), "including with an argument");
  assert.equal(await run("think on"), await run("thinking on"), "think is thinking");
  assert.equal(await run("think expand"), await run("thinking expand"), "both spellings take the aliases");

  // The values say the same thing from the other end: hiding is collapsing.
  assert.equal(await run("text collapse"), await run("text on"));
  assert.equal(await run("text expand"), await run("text off"));
  assert.equal(await run("text show"), await run("text off"), "show still means off");
  assert.equal(await run("thinking collapse"), await run("thinking on"));
  assert.equal(await run("tool expand"), await run("tool off"));
  assert.equal(await run("fold collapse"), await run("fold on"));
  assert.equal(await run("fold expand"), await run("fold off"));
  // The same two words also work as actions, with no sub-command in front.
  assert.equal(await run("collapse"), await run("fold on"));
  assert.equal(await run("expand"), await run("fold off"));

  // Guard against the assertions above being vacuous.
  assert.notEqual(await run("text on"), await run("text off"));
  assert.notEqual(await run("tool on"), await run("tool off"));

  const unknown = await run("tools on");
  assert.match(unknown ?? "", /Usage: \/run-fold/, "the old plural name is not an alias");
});

test("the status line names the kinds the fold hides", () => {
  const base = { ...DEFAULT_RUN_FOLD_OPTIONS };
  assert.equal(statusText(base), "folded(think,tool)", "the shipped default hides two kinds");
  assert.equal(statusText({ ...base, hideIntermediateText: true }), "folded", "all three needs no parentheses");
  assert.equal(statusText({ ...base, hideIntermediateText: true, hideThinking: false }), "folded(text,tool)");
  assert.equal(statusText({ ...base, hideThinking: false }), "folded(tool)");
  assert.equal(statusText({ ...base, hideToolCalls: false }), "folded(think)");
  assert.equal(
    statusText({ ...base, hideIntermediateText: false, hideThinking: false, hideToolCalls: false }),
    undefined,
    "a fold that takes nothing away says nothing",
  );
  assert.equal(statusText({ ...base, folded: false }), undefined, "and neither does a fold that is off");
});

test("the status line follows the commands and can be turned off", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    on() {},
    registerShortcut() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  // The footer prints extension statuses undimmed while the rest of its lines are
  // dim, so the extension has to dim its own text - remember the colors it asks
  // for and let the text through unchanged.
  const colors: string[] = [];
  const spyTheme = {
    fg(color: string, text: string) {
      colors.push(`${color}:${text}`);
      return text;
    },
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme: spyTheme,
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;

  runFoldExtension(pi);
  const run = async (args: string) => {
    statuses.length = 0;
    notifications.length = 0;
    colors.length = 0;
    await commands.get("run-fold")!.handler(args, ctx);
    return statuses.at(-1);
  };

  // Start from a known strategy rather than whatever the tests before left behind.
  await run("fold on");
  await run("text off");
  await run("thinking on");
  await run("tool on");
  await run("statusline on");

  assert.equal(await run("status"), "folded(think,tool)");
  assert.deepEqual(colors, ["dim:folded(think,tool)"], "dim, like the rest of the footer");
  assert.equal(await run("text on"), "folded");
  assert.equal(await run("think off"), "folded(text,tool)");
  assert.equal(await run("tool off"), "folded(text)");
  assert.equal(await run("text off"), undefined, "nothing to hide: the line is cleared");
  assert.equal(await run("fold off"), undefined);
  assert.equal(await run("think on"), undefined, "folding is off, so the flag does not matter");
  await run("fold on");
  assert.equal(await run("think on"), "folded(think)");

  assert.equal(await run("statusline off"), undefined, "turned off, the line is cleared");
  assert.equal(await run("statusline on"), "folded(think)");
  assert.equal(await run("statusline toggle"), undefined, "toggle flips it off");
  assert.equal(await run("statusline"), "folded(think)", "and with no value it flips back");

  statuses.length = 0;
  notifications.length = 0;
  await commands.get("run-fold")!.handler("statusline maybe", ctx);
  assert.equal(statuses.length, 0, "an unknown value leaves the line alone");
  assert.match(notifications.at(-1) ?? "", /Usage: \/run-fold statusline/);
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
      setStatus() {},
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
    // The shipped default keeps intermediate text: the narration stays in place,
    // the tool row folds and hosts the summary, and the answer follows it.
    assert.equal(folded.length, 3, "narration, summary, final answer");
    assert.match(folded[0]!, /narration/);
    assert.match(folded[1]!, /▸ read/);
    assert.match(folded[2]!, /final answer/);

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

test("an in-flight run stays folded between a finished tool and the next message", () => {
  const chat = new Container();
  const intermediate = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "look",
      text: "narration",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  const tool = toolComponent("t", "read", "file body");
  chat.addChild(intermediate);
  chat.addChild(tool);

  // A1 finished and its tool returned, but the run has no answer yet: without
  // run-level liveness this is indistinguishable from an aborted run.
  const timings = timingsSource(new Map([[T0, { startedAt: T0 - 1_000, completedAt: T0 + 2_000 }]]));
  assert.equal(computeFoldLayout(chat.children, options, timings).size, 0, "settled and answerless: visible");
  const active = computeFoldLayout(chat.children, options, timings, true);
  assert.deepEqual([...active.keys()], [intermediate], "in flight: the finished step folds, the tail stays");
  assert.deepEqual(active.get(intermediate)?.summary, {
    toolCount: 0,
    thinkingRuns: 1,
    toolNames: [],
    durationMs: 61_000,
    live: true,
  });
});

test("toggling in the tool-to-message gap folds immediately instead of waiting for the next message", () => {
  const chat = new Container();
  const intermediate = assistantComponent(
    assistant({
      timestamp: T0,
      text: "narration",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(intermediate);
  chat.addChild(toolComponent("t", "read", "file body"));

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 2_000 }]])));
  patch.setRunActive(true);
  patch.refresh();
  try {
    assert.match(plain(chat.render(70)).join("\n"), /▸ \d+s\s+\(f2 to expand\)/, "folded while in flight");
    assert.match(plain(chat.render(70)).join("\n"), /read/, "the finished tool is the live tail");

    patch.toggle(); // F2: expand
    assert.match(plain(chat.render(70)).join("\n"), /narration/, "expanded");

    patch.toggle(); // F2: fold again, with no pending child and no answer yet
    const folded = plain(chat.render(70)).filter(Boolean);
    assert.match(folded[0]!, /▸ \d+s\s+\(f2 to expand\)/, "the collapse takes effect right away");
    assert.match(folded.join("\n"), /read/, "the newest step - the finished tool - stays as the tail");
    assert.doesNotMatch(folded.join("\n"), /narration/, "the earlier step is folded");

    patch.setRunActive(false); // the run settled without an answer (abort): show the output
    const settled = plain(chat.render(70)).join("\n");
    assert.match(settled, /narration/);
    assert.doesNotMatch(settled, /to expand/);
  } finally {
    patch.dispose();
  }
});

test("the run clock covers tool execution and the gaps between messages", () => {
  const chat = new Container();
  const intermediate = assistantComponent(
    assistant({
      timestamp: T0,
      tools: [{ id: "b", name: "bash" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(intermediate);
  chat.addChild(new ToolExecutionComponent("bash", "b", {}, {}, undefined, ui, "/local/workspace"));

  const summaryAt = (now: number) => {
    const source: TimingSource = {
      timingFor: (timestamp) => (timestamp === undefined ? undefined : timings.get(timestamp)),
      now: () => now,
    };
    const timings = new Map([[T0, { startedAt: T0, completedAt: T0 + 3_000 }]]);
    return [...computeFoldLayout(chat.children, options, source, true).values()].find((e) => e.summary)
      ?.summary;
  };

  // Message A1 ended after 3s; the tool then runs for a minute without a new
  // message, so the clock must keep counting instead of freezing at 3.0s. The
  // running tool is the live tail, so it is not counted as folded yet.
  assert.deepEqual(summaryAt(T0 + 30_000), {
    toolCount: 0,
    thinkingRuns: 0,
    toolNames: [],
    durationMs: 30_000,
    live: true,
  });
  assert.equal(summaryAt(T0 + 60_000)?.durationMs, 60_000);
  assert.equal(summaryAt(T0 + 60_000)?.live, true);
});

test("the ticker runs for the whole agent run, not only while a message streams", async () => {
  const intervals = new Set<unknown>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const handle = realSetInterval(fn, ms);
    intervals.add(handle);
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    intervals.delete(handle);
    return realClearInterval(handle as never);
  }) as unknown as typeof clearInterval;

  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const pi = {
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  const root = new Container();
  const chat = new Container();
  root.addChild(chat);
  const bridgeTui = root as unknown as TUI;
  (bridgeTui as unknown as { requestRender: () => void }).requestRender = () => {};

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, factory: ((tui: TUI) => unknown) | undefined) {
        factory?.(bridgeTui);
      },
      setStatus() {},
      notify() {},
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  runFoldExtension(pi);
  try {
    await emit("session_start");
    assert.equal(intervals.size, 0);

    // The chat container is rediscovered on the next bridge frame.
    chat.addChild(assistantComponent(assistant({ timestamp: T0, text: "answer" })));
    root.render(80);

    await emit("agent_start");
    assert.equal(intervals.size, 1, "the clock starts with the run");

    await emit("message_start", { message: assistant({ timestamp: T0 }) });
    await emit("message_end", { message: assistant({ timestamp: T0 }) });
    assert.equal(intervals.size, 1, "still ticking while tools run");

    await emit("agent_end");
    assert.equal(intervals.size, 0);

    await emit("agent_start");
    await emit("agent_settled");
    assert.equal(intervals.size, 0, "settled stops the clock");
  } finally {
    await emit("session_shutdown", {});
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

class FakeTerminal implements Terminal {
  writes: string[] = [];
  constructor(
    private readonly columns_: number,
    private readonly rows_: number,
  ) {}
  start() {}
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.writes.push(data);
  }
  get columns() {
    return this.columns_;
  }
  get rows() {
    return this.rows_;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

test("a click in fullscreen lands on the summary row Pi's layout dispatch points at", () => {
  const terminal = new FakeTerminal(80, 24);
  const tui = new TuiAltScreen(terminal, false, "/tmp");
  const chat = new Container();
  const step = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "先看测试",
      text: "first narration",
      tools: [{ id: "a", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(step);
  chat.addChild(toolComponent("a", "read", "file body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "first answer" })));
  tui.addChild(chat);

  const patch = installRunFoldPatch(options);
  patch.setContainer(chat);
  patch.setTheme(theme);
  patch.setClickToToggle(true);
  patch.setTimingSource(timingsSource(new Map([[T0, { startedAt: T0, completedAt: T0 + 1_000 }]])));
  try {
    tui.start();
    tui.renderNow(true);
    const painted = stripVTControlCharacters(terminal.writes.join(""));
    assert.match(painted, /▸ read/, "the fold is painted");

    // Fullscreen delivers the click through the containers Pi mounted, each
    // taking its own rows off the top, so the row the pointer has to hit is the
    // one the summary block puts it on: the second line, under its blank line.
    terminal.writes = [];
    const at = "\x1b[<0;3;2";
    (tui as unknown as { handleViewportInput(data: string): unknown }).handleViewportInput(`${at}M`);
    (tui as unknown as { handleViewportInput(data: string): unknown }).handleViewportInput(`${at}m`);
    assert.match(plain(chat.render(80)).join("\n"), /▾ read · .*\(click to collapse\)/, "the click opened the stretch");

    tui.renderNow(true);
    assert.match(stripVTControlCharacters(terminal.writes.join("")), /first narration/, "what it hid is painted");
  } finally {
    patch.dispose();
    tui.stop();
  }
});

test("/run-fold redraw repaints offscreen runs through a scrollback preserver", async () => {
  const PRESERVE = Symbol.for("pi-preserve-scrollback.stdout-patch-state");
  const stdout = process.stdout as unknown as Record<PropertyKey, unknown> & {
    write: (data: string) => boolean;
  };
  const realWrite = stdout.write;
  const seen: Array<{ via: string; data: string }> = [];
  const originalWrite = (data: string) => {
    seen.push({ via: "original", data });
    return true;
  };
  const patchedWrite = (data: string) => {
    seen.push({ via: "patched", data });
    return true;
  };

  const terminal = new FakeTerminal(80, 10);
  const tui = new TuiMainScreen(terminal, false, "/tmp");
  const chat = new Container();
  tui.addChild(chat);

  // An old run, followed by enough output to push it above the viewport.
  const run = assistantComponent(
    assistant({
      timestamp: T0,
      thinking: "first thought",
      text: "narration",
      tools: [{ id: "t", name: "read" }],
      stopReason: "toolUse",
    }),
  );
  chat.addChild(run);
  chat.addChild(toolComponent("t", "read", "file body"));
  chat.addChild(assistantComponent(assistant({ timestamp: T0 + 1_000, text: "old answer" })));
  chat.addChild(new UserMessageComponent("next prompt", markdownTheme, 1, []));
  for (let i = 0; i < 12; i += 1) {
    chat.addChild(new Text(`tail line ${i}`, 1, 0));
  }

  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  const notifications: string[] = [];
  let bridge: { render(width: number): string[] } | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      setWidget(_key: string, factory: ((tui: TUI) => unknown) | undefined) {
        bridge = factory?.(tui as unknown as TUI) as { render(width: number): string[] } | undefined;
      },
      setStatus() {},
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  runFoldExtension(pi);
  try {
    await emit("session_start");
    assert.ok(bridge, "the widget factory handed over the live TUI");
    bridge!.render(80); // the bridge frame that discovers the chat container
    tui.renderNow(true);

    const viewportTop = (tui as unknown as { previousViewportTop: number }).previousViewportTop;
    assert.ok(viewportTop > 0, "the setup has offscreen rows");
    const firstFrame = terminal.writes.join("");
    assert.match(stripVTControlCharacters(firstFrame), /▸ read/, "the fold was painted");

    // Simulate the installed preserve-scrollback patch.
    stdout.write = patchedWrite;
    Object.defineProperty(stdout, PRESERVE, {
      configurable: true,
      value: { originalWrite, patchedWrite, owners: new Set(), transformedFullRedraws: 0 },
    });

    terminal.writes = [];

    // A plain toggle cannot repaint offscreen rows, so it says so - once.
    await commands.get("run-fold")!.handler("toggle", ctx);
    await commands.get("run-fold")!.handler("toggle", ctx);
    const hints = notifications.filter((message) => message.includes("/run-fold redraw"));
    assert.equal(hints.length, 1, "the offscreen hint appears once");

    await commands.get("run-fold")!.handler("redraw", ctx);
    const redraw = terminal.writes.join("");
    assert.deepEqual(
      seen.map((entry) => entry.via),
      ["original"],
      "the clear bypasses the preserver's rewrite",
    );
    assert.equal(seen[0]!.data, "\x1b[2J\x1b[H\x1b[3J", "Pi's own full-redraw clear");
    const repainted = stripVTControlCharacters(redraw);
    assert.match(repainted, /▸ read/, "the folded run is repainted");
    assert.match(repainted, /next prompt/, "the whole transcript is repainted");
    assert.match(repainted, /tail line 11/);
  } finally {
    delete stdout[PRESERVE];
    stdout.write = realWrite;
    await emit("session_shutdown", {});
  }
});
