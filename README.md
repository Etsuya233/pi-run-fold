# pi-run-fold

> Fold each agent run in Pi's TUI into one summary line. A run keeps its prompt
> and its final answer; tool rows, tool output, intermediate assistant text, and
> reasoning collapse into a single live line. `F2` expands everything again.
> Display-only: no session entries, no message mutation, no model-context change.
> *This document is written in Chinese because it is a design note; the extension
> itself and its API are English.*

一个 Pi 扩展原型：把**一个 agent run** 折叠成"用户输入 + 一行摘要 + 最终回答"。

```text
> 读一下 package.json 再看 tests 目录

  ▸ read, ls · 1 thinking · 6.3s  (f2 to expand)

  这是 bun 工作区，测试入口是 bun run test。
```

折叠前，同一份 transcript 是 40 行工具输出 + 3 段中间叙述；折叠后只剩上面 6 行。
`F2` 展开回原生渲染，再按一次折回。

---

## 1. 快速开始

```bash
# 不改任何配置，直接加载源码（Pi 自己会跑 TS，不需要构建）
pi -e ~/programming/run-fold/index.ts

# 或者登记进 settings（本地路径，不复制）
pi install ~/programming/run-fold
pi remove  ~/programming/run-fold
```

按键与命令：

| 入口 | 作用 |
| --- | --- |
| `F2` | 全局展开 / 折叠 |
| `/run-fold` | 同上（toggle） |
| `/run-fold expand` / `collapse` | 显式展开 / 折叠 |
| `/run-fold text on\|off` | 保留 / 隐藏中间叙述 |
| `/run-fold tools on\|off` | 保留 / 隐藏工具行 |
| `/run-fold status` | 打印当前策略 |

`/run-fold text off` 是"只有工具太吵"模式：中间叙述留下，工具行折成摘要那一行。

**为什么是 `F2`**：`ctrl+o`（工具展开）和 `ctrl+t`（thinking 展开）在 Pi 的
`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 里，扩展注册会被拒绝并告警；
`ctrl+y` 是编辑器的 yank；其余 `ctrl+<字母>` 基本都被编辑器占满（`ctr+h/i/m` 还是
backspace/tab/enter 的别名）。`f1`–`f12` 完全没有被 Pi 使用，所以默认 `f2`。
想换键改 `renderer.ts` 的 `DEFAULT_RUN_FOLD_TOGGLE_KEY`。

---

## 2. 设计思路

### 2.1 起点：一个不存在的钩子

需求很直白——"一个 run 只留用户输入和最终输出，中间告诉我调了几次工具、思考了几次"。
难点是 Pi **没有提供 transcript 层的扩展点**：

| 看起来可用的 API | 实际限制 | 源码依据 |
| --- | --- | --- |
| `pi.registerMessageRenderer(customType, …)` | 只对 `pi.sendMessage()` 产生的 `customType` 消息生效 | `core/extensions/loader.ts`（`registerMessageRenderer` 只写 `extension.messageRenderers`，`interactive-mode.ts` 只在 `role === "custom"` 时查表） |
| `pi.registerEntryRenderer(customType, …)` | 只对 `pi.appendEntry()` 的自定义条目生效，且只能**新增**行，不能隐藏已有消息 | 同上 |
| `pi.registerMarkdownTransformer(…)` | 只能改 markdown 文本，改不了组件、藏不掉整块 | `markdown-transform.ts` |
| `ctx.ui.setToolsExpanded(false)` | 工具块收成"每工具 1 行"，不是合并成 1 行 | `interactive-mode.ts` |
| `pi.on("context")` | 那是**发给模型**的上下文，与显示无关 | `core/agent-session.ts` |

于是只剩组件层。这决定了整个设计的形状：**扩展必须去包裹 Pi 用来渲染那条 transcript 的组件。**

### 2.2 四个核心决策

#### 决策一：折叠 = 让组件 `render()` 返回 `[]`，而不是替换/删除组件

`Container.render()` 只是把子组件的行顺次拼起来（`tui/src/tui.ts:366`），某个子组件返回空数组
就等于**彻底消失且不留下空行**。更重要的是 `Container.handleMouse` 在渲染时把每个子组件的
行数记进 `mouseLayout`（`tui/src/tui.ts:344`），所以被隐藏的组件高度为 0，鼠标命中自动落到
相邻组件——不需要我们修任何坐标。

对比另外两条路：

- **直接改 `chatContainer.children`**（插一个摘要组件、把中间组件摘掉）：视觉上等价，但要
  自己维护 Pi 的 `indexOf(this.streamingComponent)`、`pendingTools`、`showStatus` 的相邻去重
  等一堆隐式约定，`chatContainer.clear()` 时还要善后。
- **让 `renderCall/renderResult` 返回空组件**（官方 API，见 2.5）：只能管工具行，管不了
  assistant 消息，而且普通 Box 外壳会留下 1 行空白（我实测过，见 2.5）。

所以选择"**只替换输出，不动结构**"：包装 `AssistantMessageComponent.prototype.render` 与
`ToolExecutionComponent.prototype.render`，宿主结构一个字节都不改。

#### 决策二：run 分组从「当前 transcript 的子节点」推导，而不是维护事件状态机

run 的边界不是事件给的，而是**画面上看得见的东西**：

```text
[用户消息] [A1] [T1] [T2] [A2]   [用户消息] [A3] [T3] [A4]
 └────── 一个 run：只有 A2 可见 ──┘
```

实现上把 children 切成"连续的 assistant/tool 段落"，任何其它类型（用户消息、`!` bash、
compaction 卡片、状态文本、Spacer、横幅）都是边界；`CustomMessageComponent`/
`CustomEntryComponent` 视作段落内的装饰（保持 run 连续但不参与折叠）。

这样做换来三个性质：

- **不需要事件时序**：`chatContainer.clear()` + 从 session entries 重建（`/compact`、`/tree`、
  resume）之后，下一帧的 children 就是新的真相，折叠自动重新成立（有回归测试）。
- **不需要知道"run 什么时候开始"**：Pi 的 `agent_end` 只意味着"低层 run 结束"，之后还可能
  auto-retry / auto-compact / 跟进消息（文档明确说要用 `agent_settled`）；依赖这些事件去
  标记 run 边界很容易踩空。
- **顺序天然正确**：摘要行要插在哪、谁该被藏，全部由数组顺序决定。

分类判据只读 Pi 在运行时已经存在的字段（TS `private` 但运行时可见）：

| 判断 | 读什么 |
| --- | --- |
| 是不是 run 内组件 | `instanceof AssistantMessageComponent` / `instanceof ToolExecutionComponent` |
| 这条 assistant 是不是"最终回答" | 消息 content 里有没有 `toolCall` 块（有 = 中间步骤） |
| 还在流式吗 | `component.isStreaming`，或 `stopReason === "pending"` |
| 工具还在跑吗 | `result === undefined \|\| isPartial === true` |
| 思考了几次 | content 里**连续** thinking 块算 1 次 |
| 用了哪些工具 | `component.toolName` |

#### 决策三：摘要行由「该 run 第一个被隐藏的组件」渲染，而不是新插入一个组件

因为第一个被隐藏的组件**本来就在摘要该在的位置上**（用户消息之后第一个中间步骤），它的高度变化
由 Pi 的 `mouseLayout` 自动记账，点击区域也天然落在它身上（后续要做"点摘要展开"只需给这个
实例挂 `handleMouse`）。

一个 run 里只有一个组件负责渲染摘要，其余返回 `[]`。展开状态下布局表为空，摘要随之消失——
因为渲染它的组件自己也不再被隐藏。

#### 决策四：保留条件 = run 里最后一个「不含 toolCall 的 assistant」

这条一行规则覆盖了所有实际形态：

| 画面上的情形 | 分类结果 |
| --- | --- |
| `[A1(toolUse), T1, T2, A2(stop)]` | 藏 A1/T1/T2，保留 A2 |
| `[A1(toolUse), T1]`（工具正在跑） | 还没有回答，但 A1 在流式/工具在跑 → **整个 run 折叠**，摘要显示计时 |
| `[A1(toolUse), T1(错误)]`（abort 之后） | 没有回答、也没有东西在跑 → **不折叠**，错误输出留给用户 |
| `[A1(stop)]`（直接回答） | 没有可藏的东西 → 原生渲染，一行都不多 |
| auto-retry：`[A1(error), A2(stop)]` | 失败的尝试跟着步骤一起折进去（想要的效果） |

"abort 之后不折叠"是刻意的：那时工具行里的错误文本就是用户要的结果，折成一个空摘要等于藏了它。

### 2.3 不变量

1. **Display-only。** 不改消息、不写 session entry、不动模型上下文、不新增 session 数据。
   折叠只是一个渲染函数。
2. **只读宿主结构。** 不插入、不删除、不重排 `chatContainer.children`，因此 Pi 的
   `streamingComponent` / `pendingTools` / `mouseLayout` / 状态行去重逻辑全部照旧。
3. **单例 + 可还原。** patch 记录挂在 `Symbol.for(...)` 上（同一 prototype 不重复包装），
   包装函数捕获"下层原始实现"并链式调用（与别的扩展共存），`session_shutdown` 时只在
   "当前装的还是我自己"的前提才还原。
4. **可自愈。** 别的扩展在 `/reload` 时可能把 `prototype.render` 还原掉；本扩展在
   `session_start` 和每条 assistant `message_start` 上重新断言（`assertRunFoldPatch`）。
5. **失败即退让。** 找不到组件类、找不到 chat container、分类抛异常，一律走原生渲染；
   `AssistantMessageComponent.render` 不存在时直接自禁用并 `notify`。

### 2.4 计时

Pi 的流式事件（`message_start` / `message_end` / `agent_end`）打点，key 用
`message.timestamp`（跨重渲染、跨恢复都稳定）；恢复会话时从 `sessionManager.getEntries()`
的 `entry.timestamp` 反推完成时刻。计时只在 assistant 流式期间每秒 tick 一次（ticker 只在
有未完成计时的时候存在）。

run 的时长 = `最后一个 assistant 的完成时刻 − 第一个 assistant 的开始时刻`。语义上是
"这个 run 里模型的活跃时间窗口"，不是秒表：工具执行期间它停在上一段消息的窗口上，下一段回答
开始时才跳。展开状态不持久化，时长在 run 内是精确的。

### 2.5 一条没走的路（以及为什么）

工具块其实可以用**官方 API** 变成 0 行：`pi.registerTool` 覆盖内置工具，配
`renderShell: "self"` + 渲染器返回空组件。我在 `tool-execution.ts:259` 的
`self` 分支里确认了这条路径会走到 `return []`，并实测过：

| 定义 | `component.render(80)` |
| --- | --- |
| 默认 Box 外壳 + 空 `Text` | `[""]` ← 只藏掉内容，剩 1 行空白 |
| `renderShell: "self"` + 0 行内容 | `[]` ← 完全消失 |

不用它的原因：① 它管不到 assistant 消息，run 折叠的主干仍然要 patch；② 接管 `self` 外壳意味着
要自己画边框/内边距/展开提示，还要克隆 `parameters`、`description`、prompt 元数据，并把
`execute` 委托给 `createReadTool()` 之类的工厂；③ 会和已装的其他渲染扩展抢同名工具
（`MasuRii/pi-tool-display` 就是靠"发现别人占有就退让"来共存的）。这条路线留作后续选项
（见 §7）。

---

## 3. 参考项目与源码位置

本机路径（`reference/` 下是两个只读的上游克隆，`~/programming/pi-extensions` 是原型诞生的仓库）：

```text
~/programming/run-fold/reference/pi               # Pi 本体，v0.85.1，commit e4ce7b4
~/programming/run-fold/reference/pi-tool-display  # MasuRii/pi-tool-display，v0.5.0，commit 91cef75
~/programming/pi-extensions/extensions/thinking-fold
~/programming/pi-extensions/extensions/cursor-effect
```

刷新参考克隆见 `reference/README.md`。

### 3.1 Pi 本体（事实依据，不是灵感来源）

所有"能不能这么干"的判断都来自这里。关键位置（相对 `reference/pi/packages/`）：

| 文件:行 | 内容 | 对本项目的意义 |
| --- | --- | --- |
| `coding-agent/src/modes/interactive/interactive-mode.ts:385,550` | `chatContainer` 的定义与组装（`documentContainer` → header/loadedResources/chat） | 折叠对象的身份与查找方式 |
| `…/interactive-mode.ts:3225,3249,3284,3329,3372` | UI 侧对 `message_start/update/end`、`tool_execution_start`、`agent_end` 的处理 | 复刻了真实时序来压测（见 §4） |
| `…/interactive-mode.ts:3584,3693,3893` | `addMessageToChat` / `renderSessionItems` / `renderInitialMessages` | children 的顺序与"重建"路径 |
| `…/interactive-mode.ts:2193` | `setExtensionWidget`：widget 工厂能拿到 `TUI` | 零高度 widget 同时充当 `requestRender` 桥和 chat container 的发现入口 |
| `components/assistant-message.ts:80,91` | `render` / `updateContent` | 被包装的方法；`lastMessage`、`isStreaming`、`hasToolCalls` 的来源 |
| `components/tool-execution.ts:254,259,401` | `render` 的 `hideComponent` 分支、`self` 外壳、空渲染判定 | 隐藏的可行性依据；没走官方路线的对照 |
| `core/agent-session.ts:682` | `// Emit to extensions first` | **扩展事件早于组件创建**，所以不能在 `message_start` 里抓组件 |
| `tui/src/tui.ts:319,344,366` | `Container` 的 `handleMouse` / `render` | 返回 `[]` 等于零高度零空行，鼠标自动落到邻居 |
| `tui/src/tui-main-screen.ts:277,357,451` | `fullRender(true)` 触发条件（clear-on-shrink、改动行在视口上方） | regular 模式下"变矮"会清屏+清 scrollback 重写（§5） |
| `core/extensions/runner.ts:77` | `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` | 为什么默认键不是 `ctrl+o/t` |
| `core/extensions/loader.ts:121,517` | jiti `alias` / 二进制 `virtualModules` | 扩展的 `@earendil-works/*` 由 Pi 注入 → 独立目录不需要运行时依赖，且 `instanceof` 必然成立 |

### 3.2 `99percentpeople/pi-extensions`（同一作者仓库，借鉴最多）

**`extensions/thinking-fold`** —— 本项目的工程范式直接来自它：

| 借鉴点 | 它在哪里做 | 本项目对应 |
| --- | --- | --- |
| prototype patch 的单例/引用计数/还原 | `renderer.ts` 的 `PATCH_SYMBOL` + `owners` + `dispose` | `installRunFoldPatch()` |
| 按 `message.timestamp` 记时长，恢复会话时从 entries 重建 | `index.ts` 的 `restoreTimings()` | 同款 |
| 零高度 widget 当 `requestRender` 桥；widget 工厂拿 `TUI` | `index.ts` 的 `RENDER_BRIDGE_WIDGET` | 同款，并额外用它做 container 发现 |
| 每秒 tick 只在需要时重绘 | `startItemTimer` / `refreshItemTimer` | `startTicker()` |
| display-only、不动 session/上下文 | README 的 "not modified" 承诺 | 不变量 1 |
| 测试手法：假 TUI + **真组件** + 断言渲染出来的行 | `tests/thinking-fold.test.ts` | `tests/run-fold.test.ts` |
| 失败降级并 `notify` | `patchError` 分支 | 同款 |

**`extensions/cursor-effect`** —— 提供了更严格的 patch 写法：保存 `PropertyDescriptor`、按
引用计数释放、给每个实例的状态用 `WeakMap`（`runtime-patch.ts`）。本项目的
`assertRunFoldPatch()`（重新捕获"下层实现"再包一层）与"只在还是自己的函数时才还原"来自这里。

**它的 `updateContent` patch 我没有碰**：thinking-fold 的 `dispose()` 是
`prototype.updateContent = record.originalUpdate` 无条件还原。如果我也包 `updateContent`，
它 shutdown 时会把我的补丁一起抹掉——所以本扩展改为**读** `lastMessage` 而不拦截
`updateContent`，两个扩展可以同时装。

### 3.3 `MasuRii/pi-tool-display`

它解决的问题相邻（工具显示），但走的是**官方 API 路线**，是最重要的对照物：

| 从它这里学到 / 对照了什么 | 它在哪里 | 本项目对应 |
| --- | --- | --- |
| 官方覆盖内置工具：`pi.registerTool` + `createXTool()` 委托执行 + 克隆 parameters/prompt 元数据 | `src/tool-overrides.ts` 的 `registerToolDisplayOverrides` / `createBuiltinToolBase` | 主动**不**走（§2.5），留作 §7 |
| `renderShell: "self"` + 空渲染 = 工具块 0 行 | `src/tool-overrides.ts`（`hidden` 模式）、`tool-execution.ts:259` | 实测确认了这条路径 |
| prototype patch 的 **stale 守卫**：把原函数存在 prototype 上（`__piUserMessageOriginalRender` + owner + version），发现别人换过就先还原再重包 | `src/user-message-box-patch.ts` | `assertRunFoldPatch()` 的"重新捕获下层" |
| 每次 `session_start` / `before_agent_start` **重申补丁**，对抗别的扩展的还原 | `src/user-message-box-native.ts` | 在 `session_start` + 每条 assistant `message_start` 重申 |
| 每帧全量重渲染 → 渲染结果要 `WeakMap` 缓存（它专门有性能回归测试 `tests/user-message-box-performance-red.test.ts`） | `src/user-message-box-renderer.ts` | 布局表按 `revision + children.length + 末子节点身份` 缓存 |
| ownership 发现（`pi.getAllTools()` 的 `sourceInfo`）+ `/reload` 生命周期清理（`src/disposable.ts`） | `src/tool-overrides.ts`、`src/disposable.ts` | §7 做工具层时要抄 |
| **另一条流派**：直接改消息文本加展示标签，再用 `pi.on("context")` 在进模型前擦掉 | `src/thinking-label.ts` | 明确**不采用**：折叠不该污染落盘内容 |

### 3.4 官方文档

`reference/pi/packages/coding-agent/docs/`：`extensions.md`（消息渲染器只对 customType、
"Overriding Built-in Tools"、"Custom Rendering" 与 `renderShell`）、`tui.md`（组件 API）、
`keybindings.md`（默认键位表）。

---

## 4. 验证情况

### 4.1 按 Pi 真实时序回放（headless）

时序是照 `interactive-mode.ts` 逐行复刻的：扩展事件先于 UI 组件创建、流式用
`streamingComponent`、工具行由 `message_update` 的 `toolCall` 块创建、`agent_end` 摘掉残留
streaming 组件并清 `pendingTools`。

| 场景 | 结果 |
| --- | --- |
| 完整 run：正文流式 → toolCall 出现 → 工具跑 → 回答 | 正文出现后于 toolCall 到达时收拢（整个 run 唯一一次"变矮"）；工具输出全程不落地；最终回答保留 |
| 工具跑到一半 abort | 工具被标错误后**自动展开**，错误文本可见 |
| `/compact` 后 `clear()` + 从 entries 重建 | **自动重新折叠**，计时取自 `entry.timestamp` |
| steer（流式中插话） | 摘要位置不动；插话成为新的 run 边界 |
| `session_shutdown` | 补丁卸载，transcript 完全恢复原生渲染 |

### 4.2 性能

800 个组件（100 个 run × 每 run 5 个工具行，5100 行原生输出）：

```text
native render                    2.81 ms/frame    5100 visible lines
folded, layout cache warm        1.84 ms/frame     600 visible lines   ← 比原生更快（少画 4500 行）
folded + refresh() every frame   2.09 ms/frame     ← 最坏情况；实际每秒只 tick 一次
```

布局重算 ~0.25 ms，只在子节点变化 / tick / 选项变化时发生。

### 4.3 测试

13 个测试覆盖：run 分组与边界、live/settled run 的布局、摘要格式化与按宽截断、prototype
包装与还原、外来补丁后的自愈、abort 后展开、transcript 重建、container 发现、扩展完整生命周期。
测试用**真实的 Pi 组件**（`AssistantMessageComponent` / `ToolExecutionComponent` /
`UserMessageComponent`）和假的 TUI/ctx 断言渲染出来的行。

验证矩阵：

| Pi 版本 | 怎么验的 | 结果 |
| --- | --- | --- |
| 0.83.0 | 还在 `pi-extensions` 工作区里时跑的全套单测 + headless 回放 | 通过 |
| 0.84.4 | 本目录独立安装后跑 `bun run check` + headless 回放 | 13/13 通过 |
| 0.85.1 | 临时 `bun add -d …@0.85.1` 后跑 `bun run lint` + 测试 | 13/13 通过 |
| 任何版本 | `pi -e ~/programming/run-fold/index.ts --print "reply ok"` | 宿主加载成功（非 TUI 模式按设计不生效） |

跨版本踩到的一个真实差异：**`TUI` 从 0.84 起不再由 `@earendil-works/pi-coding-agent`
再导出**，要从 `@earendil-works/pi-tui` 引（`index.ts` 一直是从 pi-tui 引的，只有测试文件需要改）。
临时切到 0.85.1 复验：

```bash
bun add -d @earendil-works/pi-ai@0.85.1 @earendil-works/pi-coding-agent@0.85.1 @earendil-works/pi-tui@0.85.1
bun run check
bun install   # 回到 ^0.84.3
```

---

## 5. 已知限制

- **一个 run 只保留最后一条回答。** 对 auto-retry 是想要的（失败尝试跟着步骤折叠）；但如果
  transcript 里真出现"连续两条完整回答"（需要 steer / 树导航这类非典型顺序），前一条会被藏。
- **chat container 的发现晚一帧。** `session_start` 时 transcript 是空的，`findChatContainer`
  要等桥接组件下一次 render 才成功；中间那一帧按原生渲染（此时本来也没内容可折）。
- **还没产出回答就被打断的 run 保留输出。** abort、或回答生成前被 steer 打断时，工具行与
  错误文本留给你看，不会折成一个空摘要。见 §2.2 决策四。
- **时长是窗口不是秒表。** 见 §2.4。
- **regular 模式会触发全屏重绘。** 把已经打印过的中间内容收起来会让 Pi 走 clear-on-shrink
  （清屏 + `\x1b[3J` 清 scrollback + 重写整条 transcript，`tui-main-screen.ts:357,451`）。
  每个中间步骤最多一次；"边跑边折"（工具还在跑时就折）通常不触发，因为那一帧总行数还在增长。
  想要完全平滑请用 `--tui-mode fullscreen`（transcript 是 ScrollView，原地重排）。
- **只有 TUI 模式生效**（`--print` / `--mode json` / rpc 下什么都不做，也不该做）。
- **`instanceof` 依赖 Pi 的模块别名。** 扩展里的 `@earendil-works/*` 由 Pi 的 jiti
  alias/virtualModules 注入（`loader.ts:121,517`），所以独立目录不需要运行时依赖、也保证
  `instanceof` 与 Pi 新建的组件是同一个类。若把代码搬到别的宿主里自己 import，会拿到第二份类，
  `instanceof` 就会失效——这也是为什么这里始终用 `instanceof` 而不是 `constructor.name`
  （后者只用于 Pi 没导出的 `CustomMessageComponent`/`CustomEntryComponent`）。
- 配置只在内存里（没接 settings 文件）；展开状态不持久化；没有 per-run 展开 / 点击摘要行。

---

## 6. 目录结构与开发

```text
run-fold/
├── index.ts              扩展入口：事件、计时、ticker、快捷键/命令、渲染桥
├── renderer.ts           纯渲染层：patch、分组、摘要格式化（可独立测试）
├── tests/run-fold.test.ts
├── package.json          pi.extensions -> ./index.ts（无需构建即可 pi -e）
├── tsconfig.json
└── reference/            上游克隆（gitignored）+ 说明
```

```bash
bun install
bun run lint     # tsc --noEmit
bun run test     # node --import tsx --test ...
bun run check    # 两者
bun run build    # 可选：bun build 出一份 minified dist（pi 直接读 index.ts 也行）

# 冒烟：让 Pi 真的加载一次这个目录（不需要构建，也不需要 TTY）
pi -e ~/programming/run-fold/index.ts --print "reply with the single word ok"
```

本项目的源码来自 `~/programming/pi-extensions` 工作区里的原型（当时作为 `extensions/run-fold`
接入过那套 workspace/build/pack 脚本），现在已从那个仓库移出、独立成项目；`pi-extensions` 已还原
到未引入本扩展的状态。

---

## 7. 后续可以做的方向

1. **per-run 展开 + 点击摘要行**：给渲染摘要的那个组件实例挂 `handleMouse`（位置与高度 Pi 已算好）。
2. **摘要内容扩展**：tokens/花费（`message.usage`）、错误标记、文件改动计数、工具失败高亮。
3. **可选工具层**：按 §2.5 走官方 `registerTool` 覆盖 + `renderShell: "self"`，把"工具块隐藏"
   变成配置项；必须同时抄 pi-tool-display 的 ownership 发现与 `/reload` 清理。
4. **配置持久化**：接 `@99percentpeople/pi-shared-settings`（或独立 JSON），把策略与快捷键写盘。
5. **上游化**：Pi 若提供 transcript 渲染钩子，这套 patch 可以整体退化成钩子里的一次过滤
   （`computeFoldLayout()` 已经是纯函数，与 patch 层解耦）。
