# pi-run-fold

> Fold each agent run in Pi's TUI into summary lines. A run keeps its prompt, its
> intermediate text (by default), and its final answer; tool rows, tool output,
> and reasoning collapse into one summary line per folded stretch - while the run
> works, the newest step (the running tool, the streaming text, or the reasoning
> being produced) stays on screen as the live tail. Intermediate text, thinking,
> and tool calls fold independently (`/run-fold text|thinking|tool on|off`), and
> `F2` turns folding off entirely.
> Display-only: no session entries, no message mutation, no model-context change.
> *This document is written in Chinese because it is a design note; the extension
> itself and its API are English.*

一个 Pi 扩展原型：把**一个 agent run** 折叠成"用户输入 + 摘要 + 最终回答"，
运行期间只额外保留**最新的一步**当作实时尾部。留在屏幕上的行会把折叠**切成若干段**，
每一段各出一行摘要（见 §2.2 决策三）。

运行中的样子（第 4 步 = 下一轮思考正在流式输出）：

```text
> 读一下 package.json 再看 tests 目录

  让我先看看根目录。

  ▸ read · 1 thinking · 2.1s  (f2 to expand)

  测试入口是 bun test
```

run 结束后的样子：

```text
> 读一下 package.json 再看 tests 目录

  让我先看看 package.json。

  ▸ read · 2 thinking · 6.3s  (f2 to expand)

  这是 bun 工作区，测试入口是 bun run test。
```

默认（`hideIntermediateText: false`）连中间正文一起留在原地，只把工具行和思考折进摘要行，
所以上面那句叙述在折叠后依然看得见。三类内容互不影响，`/run-fold text on` 是最紧的形态：
折叠前同一份 transcript 是 40 行工具输出 + 3 段中间叙述，全折掉后只剩 6 行。
`F2` 关掉折叠、回到原生渲染，再按一次折回。

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
| `F2` | 折叠总开关（关 = 原生渲染） |
| `/run-fold` | 同上（toggle） |
| `/run-fold fold on\|off` | 同上，显式开关 |
| `/run-fold collapse` / `expand` | 同上，不带子命令的动作写法（= `fold on` / `fold off`） |
| `/run-fold text on\|off`（别名 `intermediateText`） | 隐藏 / 保留中间正文（默认**保留**） |
| `/run-fold thinking on\|off`（别名 `think`） | 隐藏 / 保留思考（默认隐藏） |
| `/run-fold tool on\|off`（别名 `toolcalls`） | 隐藏 / 保留工具调用行（默认隐藏） |
| `/run-fold repaint on\|off` | 折叠涉及视口上方时整屏重绘 |
| `/run-fold statusline on\|off\|toggle` | 开关 footer 上的 `folded` 状态（不带值 = toggle） |
| `/run-fold redraw` | 立刻整屏重绘一次 |
| `/run-fold status` | 打印当前策略 |

取值统一：`on` = `collapse`（折起 / 隐藏），`off` = `show` = `expand`（展开 / 保留）；
不给值等于 `on`。所以 `/run-fold text collapse`、`/run-fold text on`、`/run-fold text` 是同一件事。
（`statusline` 自己一套：`on` / `off` / 不带值或 `toggle`。）

**footer 状态栏**：`folded` 会显示在 Pi footer 的最后一行，和别的扩展的状态并排（按 key
字母序）。三项都折才写裸的 `folded`，否则括号里列出**被折掉的类目**，按正文、思考、工具的顺序：
默认是 `folded(think,tool)`，`/run-fold text on` 后是 `folded`，`/run-fold think off` 后是
`folded(tool)`。三项都不折（插件此时等于没作用）或 `fold off` 时不显示任何东西。
它读的是**策略**而不是当前屏幕（O(1)，不扫 transcript）：一个没有工具调用的 run 上也会写
`folded(think,tool)`。文本自己套 `theme.fg("dim", …)` —— Pi 打印扩展状态时不套颜色，而 footer
其余行都是 dim，不自己 dim 就会比周围亮一档。`/run-fold statusline off` 把它关掉，`statusline` 或
`statusline toggle` 来回切。

默认就是"工具和思考太吵"模式：中间正文留在原地，工具行与思考折进摘要那一行
（`▸ read · 2 thinking · 6.3s`）。三类内容各管各的：`/run-fold text on` 连正文一起折，
`/run-fold thinking off` 把思考留在屏幕上（包括最终回答自己的思考），
`/run-fold tool off` 让工具行留在原地。被折掉的思考只可能"正在流式（实时尾部）"或
"计入摘要的 `N thinking`"，不会静默消失。

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
| `pi.registerMarkdownTransformer(…)` | 只能改 markdown 文本；不过 thinking 块是独立渲染的 `Markdown`，**transform 返回 `""` 会让它整体 0 行**（`tui/src/components/markdown.ts:285`：先 transform、再判空返回 `[]`）。真实障碍是缓存：`Markdown.cachedLines` 的 key 是 `(text,width)`，不含 transform 结果，F2 切换后会吐旧结果 | `markdown-transform.ts`、`tui/src/components/markdown.ts` |
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

同一条路还有一个更细的粒度：assistant 消息**内部**的思考块。它不是一个独立的消息组件，而是
`contentContainer` 里的一个子组件（`assistant-message.ts:138-172`），所以藏不掉整条消息的时候，
本扩展就**临时把那几个子组件的 `render` 换成 `() => []`**，再走消息自己的原生 render：

- 只遮罩 `reasoning`（思考）子组件，答案文本照旧；
- 先按 `updateContent()` 的布局镜像（前导 Spacer → 每个 text/thinking run → 思考后的条件 Spacer
  → length/abort/error 尾行）算出下标，**数量对不上就不动手**（Pi 改布局只会丢掉这个特性，
  不会把消息画错）；
- 遮罩是渲染期临时的，`finally` 里还给原函数，所以 Pi 的 `Container.render` 仍会把这些子组件的
  真实高度记进 `mouseLayout`（高度 0 与输出一致），鼠标命中不会错位；
- 0.85+ 的 `MouseRegion` 包装层一并遮罩（镜像只看子组件个数，包装多少层都不影响）。

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

#### 决策三：每一段连续的折叠各出一行摘要，宿主是"该段第一个被整条折掉的行"

不在 run 级别只出一行，是因为**留在屏幕上的行会把折叠切段**：默认策略下正文留在原地，
中间的工具行就成了正文之间的几个空档。若全 run 只出一行，它只能挂在第一段上，后面几段就
渲染成 0 行——内容凭空消失，而那一行上的 `read ×3` 又和它所在的位置（只折了一次）对不上。
所以按"夹在可见内容之间的折叠"切段，每段自己造摘要、自己数数、自己计时（§2.4），印在它折掉的
东西原来的位置上。

归附方向：一条被遮罩的行折掉的内容（也就是它自己的思考）算在**它下面那个标记**里（它的正文
在屏上，标记落在它下面）；下面没有标记时算在**上面那个**里；上下都没有（整条 run 只有它一个可折
的东西）才自己印一行。所以回答的思考通常被上一行吸收（得到 `▸ read · 2 thinking`，而不是
`▸ read · 1 thinking` 紧跟 `▸ 1 thinking`），而合并只发生在**相邻**的两段之间 —— 标记永远不会
跳过读者看得见的东西去合并。

切段的判据是"这一行**画不画得出东西**"，而不是"它有没有被折掉"（`drawsRows()`：被折掉的行看
`mask` 之后还剩什么，没被折掉的行看它自己有没有正文/思考/截断备注）。两个方向都得堵住：

- 模型经常单独发一条**只含 tool call** 的 assistant 消息，Pi 给它的渲染结果是 **0 行**（没有正文、
  没有思考，`updateContent` 连前导 Spacer 都不建）。这种行必须**透明**，否则两行摘要会贴在一起、
  中间什么都没有，计数和时长也会从它那里被硬生生截断。
- 反过来，"**思考被遮罩、正文留屏**"的步骤必须**切断**段落：它的正文就在屏幕上。若它不算边界，
  那么标记落在哪里就取决于 provider 这一轮有没有返回 reasoning —— 同一份 transcript 的观感会随机
  变样（这正是本条被拆两次才定下来的原因）。

宿主仍是段内某个被折掉的现有组件，不新插入：它**本来就在摘要该在的位置上**，高度变化由 Pi 的
`mouseLayout` 自动记账，点击区域也天然落在它身上（后续要做"点摘要展开"只需给这个实例挂
`handleMouse`）。优先选段内第一个被**整条**折掉的行（默认策略下就是第一条工具行）；若这一段
没有任何东西被整条折掉（比如只有段内多个步骤的思考被遮罩），就选第一个被遮罩的步骤，摘要
印在它上面。关掉折叠时布局表为空，摘要随之消失——因为渲染它的组件自己也不再被隐藏。

#### 决策四：实时尾部 + 「最终回答」

两条规则叠加，覆盖所有实际形态。下表按**三类内容全都折**
（`hideIntermediateText: true, hideThinking: true, hideToolCalls: true`）描述，也就是
`/run-fold text on` 的最紧形态；默认只折思考与工具调用，中间正文留在原地（上面的"藏"相应地
只是"遮掉那条消息的正文/思考"，消息本身还在）。

| 画面上的情形 | 分类结果 |
| --- | --- |
| `[A1(stop)]`（直接回答、无思考） | 没有可藏的东西 → 原生渲染，一行都不多 |
| `[A1(thinking), …]` 正在思考 | thinking 是实时尾部 → 原生渲染（你能看到它在想什么） |
| `[A1(thinking, text)]` 开始出正文 | 思考折进摘要，正文留下 |
| `[A1(toolUse), T1]`（工具正在跑） | A1 折成摘要行，**T1（正在跑的工具）是实时尾部，留在屏幕上** |
| `[A1(toolUse), T1]`（工具已返回、下一条消息还没开始） | 上游 `agent_start`→`agent_settled` 仍是 in-flight → 已完成的 T1 继续当尾部，计时继续走 |
| `[A1(toolUse), T1, T2, A2(stop)]`（run 结束） | 藏 A1/T1/T2，保留 A2，**并遮掉 A2 自己的思考**（它已经是历史，不再是最新活动） |
| `[A1(stop, thinking only)]`（只思考、被 abort / settle） | 没有正文可留 → 思考原样保留（那是结果，不是过程） |
| `[A1(toolUse), T1(错误)]`（abort 之后 `agent_settled` 已到） | 没有回答、run 也已结束 → **不折叠**，错误输出留给用户 |
| 同上，但后面又接了新 prompt | run 变成“被边界截断”，但它是**失败收尾**的 → 仍然**不折叠** |
| steer：`[A1(toolUse), T1, <用户消息>, A2(stop)]` | 边界截住了它、而它既没有回答也没失败 → A1/T1 **折成摘要**，用户消息留在 Pi 放它的位置 |
| auto-retry：`[A1(error), A2(stop)]` | 失败的尝试跟着步骤一起折进去（想要的效果） |

"实时尾部" = `inFlight` 时 run 里最后一个非 decor 子节点；`inFlight` = `anyPending || active`
（`computeFoldLayout()` 的 `active` 参数由 `index.ts` 的 `agent_start` / `agent_settled` 维护）。
run 结算后尾部就是最后一条 "不含 toolCall 的 assistant"（决策四的老规则），此时 `hideThinking`
开着的话，任何仍可见的思考都会被遮罩。

思考的"实时"判据是**消息内容级**的，不是状态机级的：一个 thinking run 只有在"它后面没有可见内容"
且"这条消息是尾部"时才留在屏幕上。所以模型从思考切到正文的那一帧，思考就折了（`index.ts` 在
`message_update` 上 `refresh()`，不必等下一秒的 tick）。

"abort 之后不折叠"是刻意的：那时工具行里的错误文本就是用户要的结果，折成一个空摘要等于藏了它。
于是“没有回答的 run”要分两种：**失败**（abort / error / 最后一行工具报错）保留输出，**被边界截断**
（steer、follow-up、banner、compaction summary 来了）则按普通 run 折叠——它没有回答只是因为回答被
用户下一句话接走了，不是因为它留下了结果。被截断的 run 连“最新一步”也不再算实时尾部（`isTail` 只在
run 还没结束时成立），它最后的 thinking 一样折进摘要。判据是 run 里**最后一个非 decor 子节点**：只有
它失败才算这个 run 是失败收尾的（中途某个工具报错不影响）。
反过来说，“工具返回但下一条消息还没开始”这个空档必须靠 run 级状态判定：只看子组件的 pending
标志时它和 abort 长得一模一样，会让 `F2` 在这一瞬失效、并在下一条消息开始流式时突然自己折上。

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
   `AssistantMessageComponent.render` 不存在时直接自禁用并 `notify`。思考遮罩同样：布局镜像与
   实际子组件对不上（Pi 改了 `updateContent` 的构造顺序）就整条消息走原生渲染。
6. **思考要么可见、要么计入摘要。** 被遮罩的 thinking run 会加进摘要的 `N thinking`，不会出现
   "屏幕上没了、摘要里也没算"的静默丢失；反过来，只有思考、没有正文的尾部永远不会被遮罩
   （否则那条消息会变成空白）。

### 2.4 计时

`message_start` / `message_end` 给每条 assistant 消息打点（key 用 `message.timestamp`，
跨重渲染、跨恢复都稳定），`agent_start` / `agent_settled` 界定整个 run；恢复会话时从
`sessionManager.getEntries()` 的 `entry.timestamp` 反推完成时刻。

**ticker 跟着 run 走，不跟着消息走**：从 `agent_start` 到 `agent_end` / `agent_settled`
每秒 tick 一次。只在 assistant 流式期间 tick 的话，工具执行（`message_end` 之后、下一条消息
开始之前）整段是死的，摘要就停在上一段消息的时长上。

每一段的时长 = `该段开始 → 下一段可见消息开始`，其中"该段开始"就是上一段的结束（第一段则从 run
的第一个 assistant 开始），所以各段首尾相接；最后一段结束于 run 的结束。run 还在飞时"结束"就是
`now`（所以工具时间计入、数字一直走），`agent_settled` 之后用最后一个 assistant 的完成时刻——
两者连续，结算时不会跳变。折叠开关不持久化。

摘要里的 `toolCount` / `N thinking` 统计的是**这一段里已经被折掉的东西**：正作为实时尾部显示的那
一步（正在跑的工具、正在流的思考）不算在内，等它折下去时才 +1。所以运行期间数字只增不减，且屏幕
上看得见的东西不会被重复计入。

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
| `components/assistant-message.ts:80,91` | `render` / `updateContent` | 被包装的方法；`lastMessage`、`isStreaming`、`hasToolCalls`、`hasText` 的来源 |
| `components/assistant-message.ts:98,138-172` | `updateContent` 的子组件构造顺序（前导 Spacer / thinking run / 条件 Spacer / length·abort·error 尾行）；0.85+ 每个 thinking 子组件外层多一层 `MouseRegion` | 推理遮罩的布局镜像依据（`renderer.ts` 的 `reasoningChildIndexes`） |
| `tui/src/components/markdown.ts:285` | `transform` 后判空 `return []` | 为什么 `registerMarkdownTransformer` 返回 `""` 也能藏掉 thinking 块（本项目仍选了子组件遮罩，因为 transform 结果不进 `Markdown` 的渲染缓存 key） |
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
streaming 组件并清 `pendingTools`。下表同样按三类全折的策略描述。

| 场景 | 结果 |
| --- | --- |
| 完整 run：思考流式 → 正文 → toolCall → 工具跑 → 下一轮思考 → 回答 | 思考先以实时尾部显示；正文一到就折进摘要；toolCall 到达时 A1 整体收拢、**正在跑的工具行接管尾部**；工具输出可见但不落地为历史；下一轮思考再次成为尾部；run 结算后只剩摘要 + 回答 |
| 工具跑到一半 abort | 工具被标错误后**自动展开**，错误文本可见 |
| 回答自带思考（本轮修的）：`思考 → 正文` | 思考不再卡在最后（`...-Thinking-Text`），正文照旧；思考计入摘要的 `N thinking` |
| `/compact` 后 `clear()` + 从 entries 重建 | **自动重新折叠**，计时取自 `entry.timestamp` |
| steer（流式中插话） | 摘要位置不动；插话成为新的 run 边界，被截断的那一段没有回答也没失败 → **折成摘要** |
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

34 个测试覆盖：run 分组与边界、被 steer 截断的 run（vs 失败收尾的 run）、实时尾部（工具在手 /
工具已返回的空档 / 思考流式）、
推理遮罩（答案自带思考、思考切正文、`MouseRegion` 包装层、布局不识别时退回原生）、
run 级 ticker 与时长、摘要格式化与按宽截断、prototype 包装与还原、外来补丁后的自愈、
abort 后展开、transcript 重建、container 发现、offscreen 重绘（假 terminal + 真 `TuiMainScreen` +
模拟 preserve-scrollback 状态）、扩展完整生命周期。
测试用**真实的 Pi 组件**（`AssistantMessageComponent` / `ToolExecutionComponent` /
`UserMessageComponent`）和假的 TUI/ctx 断言渲染出来的行。

验证矩阵：

| Pi 版本 | 怎么验的 | 结果 |
| --- | --- | --- |
| 0.83.0 | 还在 `pi-extensions` 工作区里时跑的全套单测 + headless 回放 | 通过 |
| 0.84.4 | 本目录独立安装后跑 `bun run check` + headless 回放 + 上面的逐帧回放 | 23/23 通过 |
| 0.85.1 / 0.86.1 | 对照 `reference/pi` 与 npm 上 0.86.1 的 `assistant-message.js` / `markdown.ts` 逐行核对布局镜像（带 `MouseRegion`、同顺序的 Spacer） | 布局一致；未在该版本跑测试 |
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
  恢复会话时这意味着启动阶段那帧原生 transcript 需要靠 `/run-fold redraw`（或 fullscreen）才能
  显示折叠后的样子（见下一条）。
- **失败收尾的 run 保留输出。** abort、或最后一行工具报错时，工具行与错误文本留给你看，不会折
  成一个空摘要。回答生成前被 steer 打断则不同：那一段没有回答、也不算失败，会折成摘要（见 §2.2
  决策四）。代价是"steer 之前那一步正好报错"这种形状会整段留在屏幕上——它在转录里和 abort 长得
  一模一样，没有可靠的信号可以区分。
- **run 运行期间 transcript 会一涨一缩。** 实时尾部意味着每出现一步就多几行、下一步开始时再
  收回去；regular 模式下这些变矮会走 clear-on-shrink（见下一条）。fullscreen 模式里 transcript
  是 ScrollView，原地重排，没有这个问题——如果你在意实时尾部的观感，`--tui-mode fullscreen`。
- **视口以上的轮次需要整屏重绘才能改。** regular 模式下已经打印过的行属于终端 scrollback，
  Pi 只能走 clear-on-shrink（清屏 + `\x1b[3J` 清 scrollback + 重写整条 transcript，
  `tui-main-screen.ts:357,451`）。于是：
  - 没装 scrollback 保留类扩展时：折叠老轮次会触发一次整屏重绘（内容正确，代价是终端
    scrollback 被清），这是 §2.2 决策一以来的固有性质。
  - 装了 `awoaCrim/preserveScrollbackPatch`（或同类）时：它的 `maskOffscreenChanges()` 会把
    "视口以上"的差异当成已渲染丢弃，`preserveScrollbackInOutput()` 又把整屏重绘改写成只重写
    可见尾巴——**折叠老轮次根本到不了终端**，而 Pi 内部还认为已显示了。F2 会自动检测这种情况
    并提示（退出：`/run-fold redraw`、`/run-fold repaint on`，或 `--tui-mode fullscreen`）。
  - 完全平滑的做法始终是 `--tui-mode fullscreen`（transcript 是 ScrollView，原地重排，
    且那个补丁在 fullscreen 下根本不安装）。
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
4. **配置持久化**：接 `@99percentpeople/pi-shared-settings`（或独立 JSON），把策略与快捷键写盘；
   顺便把两个新行为做成开关：`tail on|off`（实时尾部）、`思考是否也遮罩`。
5. **遮罩改走官方 API**：`pi.registerMarkdownTransformer` 在折叠时对 `assistant-thinking` 返回 `""`
   （`markdown.ts:285` 会直接 `return []`）。代码更短，但要额外处理 `Markdown` 的渲染缓存
   （transform 结果不在 cache key 里）和 Pi 自加的空 Spacer 行；当前选择子组件遮罩就是为了绕开这两点。
6. **上游化**：Pi 若提供 transcript 渲染钩子，这套 patch 可以整体退化成钩子里的一次过滤
   （`computeFoldLayout()` 已经是纯函数，与 patch 层解耦）。
