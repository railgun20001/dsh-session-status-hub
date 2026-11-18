# 设计与实现 —— dsh-session-status-hub（中文）

> 面向维护者。用户文档：[README.md](../README.md)（英文门面） / [README.zh-CN.md](../README.zh-CN.md)（中文完整行为文档）。英文技术版：[design.md](design.md)。

## 0. 状态判定的技术依据

| 状态 | 判定依据（客户端可观测事实） |
|---|---|
| **报错** `error` | 宿主投影 `hubTurnOutcome.outcome ∈ error / interrupted`，且该 `seq` 未被确认 |
| **等待回答** `answer` | `uiSession.sessionStatus.pendingInteraction.kind ∈ approval / plan-review / question` |
| **待查看** `unread` | `sessionStatus.completionUnread === true`（原生「未读完成」绿点）**或**本插件补记的「后台完成」 |
| **运行中** `running` | `sessionStatus.running` 或会话行 `running` |
| **未开始** `draft` | `localStorage["dsh.conversation.<sessionId>"].draft.text` 去空白后非空；当前主视图会话还读 `uiSession.current.hooks.input.draft`（ui-conversation 的实时输入草稿） |
| **后台任务** `jobs` | 宿主半聚合的「该会话仍有状态为 running / stopping 的后台任务」（`POST /dsh-session-status-hub/jobs` 的轮询快照） |

- **判定顺序**（一个会话归到哪一类，取第一个命中的）与显示顺序无关：等待回答 > 报错 > 运行中 > 待查看 > 未开始 > 后台任务。既在等你回答、上一轮又还没确认失败时按「等待回答」显示；全部既有状态（含草稿）都优先于「后台任务」兜底。

## 1.1 会话行状态点：现状与同步

侧栏每行行首那个圆点是**官方** ui-workspace 画的，插件改不了；这里把它的来源列清楚，并说明本插件在哪一层补上「失败」这个官方缺失的语义。

### 官方行首圆点（`SessionStatusDots` → `StateDot`）

判定顺序（`ui-workspace` 的 `sessionStatuses`，取第一个作为行首点）：

| 优先级 | 条件 | 圆点 | 说明 |
|---|---|---|---|
| 1 | `pendingInteraction.kind` ∈ approval / plan-review / question | 🟡 warning | 等你批/等你答 |
| 2 | `sessionStatus.running`（含子代理运行） | 🔵 ongoing | 正在跑 |
| 3 | `completionUnread === true` | 🟢 done | 「已完成未查看」 |
| 4 | 以上都不是 | — | 空闲；此时行首位置才轮到插件插槽 `sidebar.session.row.leading` |

### 已知错位：失败/中断的会话也显示绿色「已完成」

`ui-session` 的 `observeRunning` 在「running → 停止」时**无条件**把会话记成
`completionUnread`，不区分这一轮是正常完成、报错还是中断。于是：

- 一轮因 503 / 中断结束的会话 → 行首照样是绿点「已完成」；
- 官方行状态机里**没有 error 态**，插件也无法覆盖非空闲行首（`sidebar.session.row.leading` 只在第 4 档才渲染）。

### 本插件的同步方式

- **不改官方圆点**（改不了，也不该去碰别人的 DOM）；
- 在**我们能控制的最近位置**补上真相：`sidebar.session.row.hover`（行悬停卡片的内容位，list 插槽）里加一行红色提示——`本轮失败` / `本轮中断`，带投影里的 `code`（若有）；
- 判据与状态栏完全一致（`failureKindOf`），已确认的失败不再提示；
- 打开该会话即成为 main view，官方 `completionUnread` 会清掉，绿点自然消失。

> 想让**行首圆点本身**变成红色「失败」，需要上游在 `ui-session` 里区分失败结局（或给行状态机加 error 态）——这不是插件能做的，本插件只负责不再让用户被绿点误导。

## 1.2 当前对话在后台跑完：为什么绿点要插件自己补

官方 `ui-session` 的 `observeRunning` 只在「running → 停止」且**该会话不是主视图**（`retainedBy.mainView === 0`）时才记 `completionUnread`，`reconcileStatus` 还会对主视图会话主动清掉它。于是最常见的等任务姿势——**正开着这个对话、切去别的应用干活、任务在后台跑完**——在官方状态里是「什么都没发生」：没有绿点、没有绿灯、状态栏也不会出现条目。

插件的补法是**同一份边沿、两份用途**（`planNotifications` 的 `completions` 返回值）：

| 观测事实 | 窗口在前台 | 窗口不在前台（被盖住 / 最小化 / 别的虚拟桌面） |
|---|---|---|
| 当前对话的回合结束（`completed` / `max-tokens`） | 静默（结果就在眼前），不点灯 | 弹「DSH · 任务完成」+ 补记「待查看」→ **绿点 + 任务栏绿灯** |

- 「窗口在不在前台」由 `document.visibilityState === "visible"` 且 `document.hasFocus()` 判定（`requireVisibleForFocus` 控制前者），一次观察只判定一次，状态栏 / 通知 / 记账同源；
- 记账落盘在 `localStorage` 的 `dsh-session-status-hub/local-unread-v1`（`{ [sessionId]: seq }`），刷新页面后绿点仍在；
- 熄灭条件：窗口回到前台且**正在看这个会话**，或用户点了它的通知 / 状态栏 chip（`openSession` 即视为已查看）。窗口焦点变化会主动触发一次观察，不用等下一次会话推送；
- 失败 / 中断不走这条路：它们本来就有「报错」红灯（红 > 绿），不需要再补绿点。

## 1.3 未开始：输入框草稿从哪来、怎么更新

DSH 的 `ui-conversation` 会把**每个会话**的输入框草稿持久化到浏览器存储：

```text
localStorage["dsh.conversation.<sessionId>"] = {
  draft: "纯文本"                                       // 旧版
       | { text: "…", references: [...], command? }   // 当前版本
  view: null,
  viewRequest: null
}
```

插件只读这个键，不碰 DOM、不碰编辑器、不 retain 会话。判定很简单：把 `draft.text` `trim()` 后长度大于 0 就算「未开始」；**正文不进入插件状态、不落盘、不外发、不渲染**，内存里只有 `{ chars: 数字 }`（见 `src/hub-drafts.js` 的隐私边界说明）。

更新路径有四条：

| 触发 | 时机 | 作用 |
|---|---|---|
| `input` / `compositionend` | 打字后 200ms 合并一次 | 当前页面立即出现 / 消失，不用等轮询 |
| `storage` 事件 | 其他标签页 / 窗口写入 `dsh.conversation.*` | 多标签页同步 |
| 2 秒轮询 | 页面可见时 | 兜住程序化写入、会话切换等没有输入事件的路径 |
| 焦点 / 可见性变化 | 回到窗口时 | 隐藏期间轮询是停的，回来补一次 |

为什么不用 `ctx.conversation.input.shell(id).draftSnapshot`：那个服务只覆盖已经 retain 的会话，而且会顺带创建整台输入机与 Lexical 编辑器；为了读一个「有没有草稿」的布尔值，代价不成比例。持久化键是 `ui-conversation` 自己读回草稿的同一份数据，页面刷新后草稿还在，插件也就跟着还在。

**空白「新会话」的补充路径**：新会话在发出第一条消息前不一定有 `dsh.conversation.<sessionId>` 键（实测旧数据里 40 个 blank 会话没有 conversation 键），所以当前主视图会话还会读 `uiSession.current.getSnapshot().hooks.input.getSnapshot().draft` 这一实时 hook——它是 `ui-conversation` 公开提供给会话内容的输入状态，包含空白会话。这条路只用于当前会话，同样只取 `trim()` 后的长度；好处是清空输入框能立刻撤掉灰点，不用等持久化写回。`uiSession.current` 不可用的旧版本 / 测试桩会自动退回 localStorage 扫描。

边界：

- **只算文本**：只有附件、没有文字的草稿在持久化里没有 `text`，不会显示「未开始」；
- **空白新会话占位行**没有草稿时不显示；一旦输入框里有未发送文字，就会以「未开始」出现，标题统一显示「新会话」（与侧栏一致）；子代理会话仍不显示；
- **不自动过期**：草稿会一直保留到你发送或清空输入框，这与 DSH 自己的草稿行为一致；
- **格式依赖上游**：如果未来 `ui-conversation` 改了存储键或 `draft` 形状，本状态会静默消失；其他五类状态、通知与任务栏不受任何影响（解析失败一律当作「没有草稿」）。

## 1.4 后台任务：对话结束了，活儿还在后台跑

DSH 的后台任务（`run_in_background` 的 shell 命令等）注册在**宿主进程内**的任务注册表（`ctx.jobs`）里。有一个关键事实：**回合是否结束与任务是否结束是两回事**——agent 交了总结回复、回合正常 `completed`，它启动的后台任务可以继续跑几个小时。这时候会话在前面的状态眼睛里是「空闲」，但其实还有东西在转。

- **为什么蓝色「运行中」覆盖不了它**：`sessionStatus.running` 只表示 agent 回合在跑；回合结束后它立刻变 `false`，哪怕后台任务还挂着。两者语义不同，不能互相替代。
- **为什么走宿主半聚合而不走投影**：任务的 `job/registered` / `job/settled` 事件虽然写进会话日志，但**宿主崩溃后没有合成收尾**（turn 有 `interrupted`，任务没有）——投影会把崩溃前「registered 且未 settled」的任务永远记成运行中，重启后状态栏就躺着一枚假青点。进程内注册表没有这个问题：宿主重启时它随 teardown 一并取消、清空，读到的永远是真相。
- **数据通路**：客户端每 5 秒 `POST /dsh-session-status-hub/jobs`，宿主半遍历**在挂会话**，对每个会话读一次 `jobs.list(sessionId)`，过滤 `status ∈ running / stopping` 且 `owner === sessionId` 的任务，回 `{ ok: true, sessions: [{ sessionId, jobs: [...] }] }`（`ok` 字段是客户端解析的硬契约，缺了它整条数据会被当作「这次没拿到」丢弃）。归属判定用注册表自己的所有者围栏；无主任务不属于任何「对话」，跳过。
- **性能**：单次聚合是「在挂会话数 × 一次内存读」，远低于为每个会话开一条 roster 流（那是会话头任务列表的方案）。5 秒的轮询周期对「状态栏提醒」粒度绰绰有余。
- **降级**：宿主半是旧构建（路由返回 `unknown-action`）时，客户端**锁定降级**——不再请求，「后台任务」状态静默消失，其余五类状态、通知与任务栏完全不受影响；重启 DSH 对齐版本后自动恢复。普通网络失败只算「这次没拿到」，保留上一份快照（青点不闪没），下一轮照常再试。
- **隐私边界**：任务标签（label）是 agent 自己起的命令行，状态栏只显示**第一个任务**的标签与任务数（`×N`），悬停提示同源；任务输出一个字节都不进入插件状态。

## 2. 界面实现细节

- 状态栏注册在官方 `shell.overlay` 浮动层（官方声明它是单占位、`replaceRisk: none`，插件无需替换任何既有 UI），固定在软件顶端标题栏，随顶栏高度（40px）垂直居中；菜单被侧栏收起改变位置时，用 `--dsh-windows-menu-start` 自动跟随。该层本身点击穿透，状态栏条目自己恢复 `pointer-events` 并标记 `-webkit-app-region: no-drag`，所以 chip 可点、标题栏其余空白仍可拖动窗口。
- Web / 非 Windows 顶栏环境回落到官方 `conversation.header.leading`（同为单占位插槽），位于会话标题之前、工作区内容之上。
- **状态栏分两层**：外层是不滚动的固定带，`‹` `›` 导航按钮常驻左端；内层才是 `overflow-x:auto` 的 chip 滚动区（两组标题与条目都在里面）。
- **滚轮横滚的机制**：内层滚动区滚动条隐藏，鼠标只有纵向滚轮、浏览器不会自动折算，所以外层固定带上挂了非被动的 `wheel` 监听（鼠标停在导航按钮上滚轮也管用），用 `hub-scroll` 的 `wheelScrollDelta` 读内层滚动区的宽度 / `scrollLeft`，把纵向滚轮换成内层的 `scrollLeft` 增量。没溢出、横向意图（触控板左右滑 / Shift+滚轮）、已经滚到头尾时**不吃事件**，交回宿主页面 / 祖先滚动容器。
- **chip 点击不请求窗口前置**：窗口本来就在前台，而且这样可以完全避免触碰窗口状态——旧实现无条件调用 `SW_RESTORE`，会把最大化的 DSH 窗口打回普通尺寸，这就是「点一下对话最大化被取消」的根因。通知点击也只在窗口确实不在前台时才请求前置；宿主半现在按 `IsIconic` / `IsZoomed` 分支，最小化才 `SW_RESTORE`，最大化用 `SW_SHOWMAXIMIZED` 保持。
- **跳转后列表滚动**：官方 ui-workspace 的列表 reveal（展开折叠分组 + `scrollIntoView`）只挂在**侧栏搜索结果点击**上，公开的 `uiWorkspace.openSession()` 只切换主视图、不滚动列表。插件因此自己补一次「滚到行」（`src/hub-scroll.js`）：按官方列表行的 `data-row-key`（`session:<id>`）定位，`scrollIntoView({ block: "center" })` 把目标行滚到列表**垂直居中**；列表首尾的行无法真正居中时浏览器自动收敛到可滚动边界。会话行始终找不到（分组被折叠 / 被归档过滤）时退化到它所属的 `workspace:<id>` 分组行。跳转后列表要等 React 提交才渲染目标行，所以用 rAF 重试到 1.5 秒；找不到就静默放弃，任何异常都被吞掉，绝不影响跳转本身。
- 「未开始」chip 用三级文字灰（`--dsw-alias-label-tertiary`）；全部空闲时显示低调的「全部空闲」。

## 3. 通知实现细节

### 为什么 tag 必须是短哈希（2026-10-26 定位）

Windows 的 toast 对 `tag` 长度有硬限制，**超了会让整条通知在 Chromium 内部被静默丢弃**：`new Notification()` 构造成功、`show` 和 `failed` 都不派发、Windows 的 `PushNotification-Platform` 连 `2416`（本地通知提交）都没有——表现和「插件压根没发」完全一样。同机对照实验（Windows 11 + Electron 44.7.0，都在渲染进程里 `new Notification`）：

| tag | 结果 |
|---|---|
| 不带 tag | `show`，Windows 有 2416 |
| `ab-x`（4 字符） | `show`，Windows 有 2416 |
| `abcdefghij123456`（16 字符） | `show`，Windows 有 2416 |
| `dsh-session-status-hub:<会话 id>#completed:<seq>`（示意，远超 16 字符） | 无 `show`、无 `failed`、Windows 无 2416 |

所以 tag 只放哈希（`dsh` + 12 位十六进制 = 15 字符，低于实验安全上限 16），可读身份记在诊断日志的 `key` 字段里。去重不依赖 tag：同一事件只弹一次由 `claimEvent` + 水位负责。

> 2026-10-23 曾把同一现象归因为「平台的替换 / renotify 分支」，并据此加了「唯一 tag」；实际根因是 **tag 太长**，唯一的可读 tag 依然几十个字符，所以那段时间通知照丢。

### 常驻通知与按钮的取舍

「需要你回应」恢复常驻（`requireInteraction`）：问答通知的价值就在于人不在屏幕前也能看到；非常驻只闪几秒就沉进通知中心，回来的人什么都看不见（0.4.1 之后短暂去掉过它，实测当天用户就以为「不弹通知了」，0.5.x 起恢复）。按钮由插件自己给：`actions: [{ action: 'open-session', title: '打开对话' }]`——点它和点正文走的是同一个 `click`，都跳回会话；右上角原生「×」仍然只是关掉。形状是 **Web Notifications API** 的 `{ action, title }`（`action` 是激活回传的 ID，`title` 是按钮文字）：Electron **主进程** `Notification` 的 `{ type, text }` 结构在渲染进程里构造即抛 `TypeError`（`action` 成员缺失），2026-11-18 曾因此让一批问答通知全部停在 `construct-failed`；同页的教训还有一条硬规则——**带按钮的构造失败必须先降级重试（去掉 `actions` 再弹）**，按钮可有可无，通知本身不能丢。

> Windows 的硬规则：想在屏幕上停留（不自动收走）的 toast **必须至少带一颗动作按钮**。不给按钮的话，平台会自动补一颗「关闭」（whatwg/notifications#236），而那颗自动按钮的激活事件会被 Electron 当成一次 `click` 回调（electron#27088）——表现为**点「关闭」也跳回会话、还把窗口提到前台**，名字和行为完全拧着。

### 为什么颜色是 emoji 而不是彩色图标

Windows 的 toast 图标固定取**应用图标**（AUMID 对应的快捷方式），HTML5 `Notification` 的 `icon` 在 Windows 上不会落到 toast 里，`badge` 更是只在 macOS / Android 实现。要换图标只能放弃 HTML5 Notification、改用宿主半直接发 WinRT toast，但那样**点击就回不到页面里**，所以颜色只能进文本——Windows 用 Segoe UI Emoji 把圆点渲染成真实彩色字形。

### 诊断日志

通知到底有没有落到系统上，看客户端半的落地日志（`localStorage` 的 `dsh-session-status-hub/notify-log-v1`，保留最近 20 条）：

| `stage` | 含义 |
|---|---|
| `shown` | 浏览器确认已显示 |
| `failed` | 浏览器/系统明确拒绝（Electron 派发 `failed`；HTML5 叫 `error`，两个事件名都挂） |
| `permission` / `unsupported` | 权限没给 / 环境没有 `Notification` |
| `deduped` | 同一事件已被别的标签页弹过 |
| `construct-failed` / `hook-failed` | 构造或挂回调时抛异常（带 `detail`） |
| `construct-failed-actions` | 带按钮的构造抛异常，已降级（去掉 `actions`）重试并成功弹出 |
| `no-event` | 2.5 秒内什么事件都没来，**只是「未确认」**，不能当成功也不能当失败，更不能用它触发重发 |

要确认系统侧，查 `Microsoft-Windows-PushNotification-Platform/Operational` 里的 2416 / 3052 / 3153 事件——**没有 2416 就说明通知根本没离开 Electron**。

## 4. 任务栏状态点（实现说明）

Electron 的 `BrowserWindow.setOverlayIcon` 没有暴露给渲染进程，preload 里也没有任何任务栏 API。本插件走的是**宿主半 + PowerShell worker + Win32**：

```
渲染进程                          宿主半（Electron 主进程的子进程）
  │ POST dsh-session-status-hub/taskbar          │
  │ {state: red|yellow|green|none}        │
  └──────────────────────────────────────▶│  createWindowRaiser.overlay()
                                          │  ├─ EnumWindows(ppid) 找主窗口 HWND
                                          │  └─ stdin: overlay:red:13944
                                          ▼
                                  常驻 PowerShell worker
                                  预生成 3 个 HICON（红/黄/绿，32×32，白描边）
                                  ITaskbarList3.SetOverlayIcon(hwnd, hicon, "DSH red")
```

- 跨进程调用已实测有效：宿主进程是 Electron 主进程的直接子进程，`process.ppid` 就是持有窗口的 `DeepSeek Harness.exe`；`ITaskbarList3` 以 HWND 为目标，由 Explorer 绘制。
- worker 在启动时一次性 `Add-Type` 编译 C#（约 6 秒），之后每条指令只是写一行 stdin；状态点亮着时**不会**因空闲退出（否则 HICON 随进程销毁，任务栏点可能消失）。
- 插件卸载 / 页面卸载 / `pagehide` 都会发 `none` 清掉状态点，避免红灯残留。
- 只有桌面外壳（`location.protocol === 'dsh-app:'`）会发任务栏请求；浏览器里的 Web 页面不会互相抢状态。

**颜色优先级**：`red`（任一报错）> `yellow`（任一等待回答）> `green`（任一待查看）> `none`。

## 5. 架构

```
plugins/dsh-session-status-hub/
├── index.js                 宿主半：hubTurnOutcome 投影 + 路由（ping/debug/raise/warmup/taskbar/jobs）
├── lib/
│   ├── raise-window.js      宿主半：窗口前置 + 任务栏状态点（PowerShell worker）
│   └── client.js            客户端 bundle（build/bundle.mjs 生成，勿手改）
├── src/
│   ├── hub-identity.js      插件 id / 投影键 / 路由前缀 / 签名头 / 存储键（两半共用）
│   ├── hub-strings.js       界面文案 zh/en（单一来源）
│   ├── hub-model.js         状态栏 / 任务栏纯逻辑（可单测）
│   ├── hub-history.js       会话导航（前进 / 后退）历史（纯逻辑，可单测）
│   ├── hub-drafts.js        未发送草稿的读取与归一化（纯逻辑，可单测）
│   ├── notify-core.js       通知边沿引擎（纯逻辑，可单测）
│   ├── hub-scroll.js        侧栏会话行定位、滚动与揭示控制器（可单测）
│   ├── hub-json-store.js    localStorage JSON 读写（读失败回落、写失败只告警）
│   ├── hub-stores.js        配置 / 水位 / 报错确认 / 后台完成记账
│   ├── hub-notify.js        通知落地：短 tag、跨标签页去重、过期通知撤回、落地诊断日志
│   ├── hub-host.js          宿主半路由：前置窗口 / 任务栏状态 / 在线探活
│   ├── hub-ui.js            React 状态栏 / 行悬停提示 / 详情页设置组件
│   ├── hub-slots.js         四处插槽注册（含插件详情页设置区块）
│   └── client-main.js       接线：服务 → 模型 → 通知 / 状态栏 / 任务栏
├── build/bundle.mjs         把 src/ 下的源文件按顺序内联成单文件浏览器 bundle（--check 校验）
├── test/                    212 个用例（node:test，零依赖）
├── locale/{zh,en}.json      插件管理器的标题与描述
├── icon.svg                 插件图标
├── cordis.patch.yml         bundle patch：插入 session-hub 行
└── .github/workflows/ci.yml CI：产物与源码一致性校验 + 全部用例
```

**为什么事件要自己算边沿**：DSH 给客户端的两路数据都是「当前状态」而不是事件流（`running` 是布尔、`pendingInteraction` 是当前值、投影是「最后一个回合的结局」）。通知必须由状态边沿推导，不能每收到一次推送就弹一次。边沿只有一份实现（`src/notify-core.js` 的 `planNotifications`），它同时产出两样东西：**该弹哪些通知**（`notifications`）和**这一轮真的结束了哪些会话**（`completions`）。后者与通知开关、静默无关，用来补官方缺失的「待查看」绿点（见 1.2 节）。

**为什么失败要靠宿主投影**：客户端拿不到「上一轮为什么结束」。`turn/end` 事件带 `reason.kind`，但只在会话被打开（retain）时才有事件流。会话投影是受支持的正解：框架驱动**所有**会话（含未打开的冷会话）折叠，值经三条受支持通道到达客户端（会话列表 RPC 的 projections 块 / `session.projections` RPC / 打开会话时的尾页基线）。因此本插件**不 retain 任何会话**。

**启动基线**：插件刚激活时已有状态只记为水位、不弹通知；只有真正的新边沿才通知。事件时间早于 2 分钟（`freshnessWindowMs`）的边沿只推进水位，宿主重启后补写的历史事件不会变成一串迟到的通知。

## 6. 完整诊断命令

```js
__DSH_SESSION_HUB__.inspect()
// → { version, sessions, uiSession, uiWorkspace, permission, statusRows, taskbarState,
//     localUnread, focused, desktopShell, hostHalf, jobSessions, jobsRoute, ... }

__DSH_SESSION_HUB__.getRows()          // 当前状态栏行
__DSH_SESSION_HUB__.getTaskbarState()  // red / yellow / green / none
__DSH_SESSION_HUB__.getDrafts()        // { [sessionId]: { chars } }：有未发送草稿的会话（只有字符数，没有正文）
__DSH_SESSION_HUB__.getRunningJobs()   // { [sessionId]: { count, label } }：有运行中后台任务的会话（只有数量与首个标签）
__DSH_SESSION_HUB__.refreshJobs()      // 立刻拉一次后台任务快照并返回（排障用）
__DSH_SESSION_HUB__.getLocalUnread()   // { [sessionId]: seq }：补记的「后台完成、尚未查看」
__DSH_SESSION_HUB__.clearLocalUnread() // 手动清掉全部补记（绿灯随之熄灭）
__DSH_SESSION_HUB__.setTaskbarState('red')    // 手动试任务栏红点（排障）
__DSH_SESSION_HUB__.setTaskbarState('none')   // 清掉
__DSH_SESSION_HUB__.testNotification() // 弹一条测试通知，点它应跳回当前会话
__DSH_SESSION_HUB__.getLiveNotifications() // 仍然挂在系统里、可被自动撤回的通知
__DSH_SESSION_HUB__.getNotifyLog()      // 最近 20 条通知的落地结果
__DSH_SESSION_HUB__.clearNotifyLog()    // 清空落地日志
__DSH_SESSION_HUB__.revealSessionRow('session-…') // 'session' / 'workspace' / null：验证左侧列表能滚到该会话行（不跳转）
__DSH_SESSION_HUB__.getNavHistory()    // { entries, index, canBack, canForward }：状态栏左端 ‹ › 背后的会话访问历史
__DSH_SESSION_HUB__.getSettings()      // { showRecentSessions }：状态栏显示设置
__DSH_SESSION_HUB__.goBack()           // 后退一个会话（与 ‹ 按钮同一条路径），返回是否真的跳了
__DSH_SESSION_HUB__.goForward()        // 前进一个会话（与 › 按钮同一条路径）
__DSH_SESSION_HUB__.pingHost()         // 'present' / 'absent' / 'unknown'
```

## 7. 技术边界（已知边界的技术层）

- **宿主半的窗口状态修复需要重启一次 DSH**：`lib/raise-window.js` 的 worker 脚本在宿主启动时加载，旧进程里仍是旧协议。`POST /dsh-session-status-hub/ping` 返回的 `workerProtocol` 为 `2` 才表示运行中的 worker 已保留最大化；客户端 chip 点击的修复不需要重启，刷新页面即可。
- **「窗口在不在前台」用浏览器语义判定**：`document.visibilityState === "visible"` 且 `document.hasFocus()`（Electron 的窗口失活会同时让 `hasFocus()` 变 `false`，被完全遮挡时 `visibilityState` 可能变 `hidden`）。若上游换了外壳实现导致焦点语义漂移，通知静默与绿点补记都会跟着错——`inspect().focused` 是这条链路的体检点。
- **安装前的历史冷会话**不显示报错：投影检查点按 (sessionId, key) 落盘，本插件注册前结束的冷会话没有该键的行，需等该会话被打开一次（全量重折叠）才补齐。
- **左侧列表滚动依赖官方 DOM 约定**：会话行 / 分组行按 `data-row-key`（`session:<id>` / `workspace:<id>`）定位。上游若改掉该属性，滚动会静默失效（跳转本身不受影响）——`revealSessionRow(id)` 返回 null 即可确认约定漂移。
- **「最近会话」是近似口径，不是「移出事件」记账**：客户端拿到的是会话状态的**当前快照**（不是事件流），「刚才还在报错、现在被确认了」与「一直空闲」在两次快照之间不可区分，精确记录「移出」需要额外一张会漂移的持久化表。所以这一组按「状态组里没有的会话 + 最近更新时间」推导：刚读完 / 刚确认 / 刚跑完 / 刚切过去的会话必然排在最前，效果等价。它不落盘、不跨会话持久，只随列表快照变化。
- **归档过滤依赖工作区注册表**：`archivedSessionIds` 取自 `useWorkspaces` 快照（状态栏），以及 `uiWorkspace.workspaces.list` / `workspaces.list`（任务栏聚合）。拿不到这两处（例如工作区 UI 没加载的自定义组合）时按「没有归档」处理——状态栏照常渲染，`inspect().archivedSessions` 返回 `null`，这是刻意的降级而不是故障。
- **依赖与命名**：`engines.dsh` 声明为 `>=0.2.0-rc.2`（实际验证过的宿主版本，非静态推断下限）；零 npm 依赖（宿主半只用 `node:child_process` / `node:fs`，客户端半只用浏览器 API、React 与 DSH 服务）；仓库名、npm 包名、`cordis.patch.yml` 的 `name`、`window.__ModuleLoader__` 注册 id、`PLUGIN_ID` 统一为 `dsh-session-status-hub`，只有 Cordis 节点 id 保持短名 `session-hub`（仅 profile 树内部使用）。
- **从 0.1.x 升级**：插件 id 变了，localStorage 键前缀随之变化；客户端半启动时会把旧前缀下的配置 / 报错确认 / 补记搬一次（新键已有数据则不覆盖），搬完删掉旧键。
- **宿主半挂内部路由**：`POST /dsh-session-status-hub/{ping,debug,warmup,raise,taskbar,jobs}`。同源，且只接受 POST + 签名头；只做「提窗口 / 画状态点 / 聚合后台任务 / 只读诊断」，`/jobs` 只回任务数与命令标签，不读任务输出。签名头只用来挡跨站触发，不是鉴权；worker 空闲 10 分钟退出，状态点亮着时保持。

## 8. 手工验收（16 条）

1. 在 A 会话发一个长任务，切到 B 会话 / 别的应用 → **任务栏不点灯**（运行中不亮），状态栏出现蓝色脉冲点「运行中」；
2. 任务完成后 → 弹「DSH · 任务完成」，状态栏出现绿点「待查看」，任务栏转绿，点 chip / 通知回到 A；
3. **当前对话本身**发一个长任务，然后切到别的应用（窗口不置顶，但 A 仍是主视图）→ 任务跑完必须同时出现：系统通知「DSH · 任务完成」、任务栏图标**绿点**、状态栏「待查看」；切回窗口（且仍在看 A）后绿点与绿灯立刻熄灭；若改成点通知回来，也应当熄灭；验证 `inspect().focused` 在切走时是 `false`、切回时是 `true`；
4. 让一轮失败 → 弹「DSH · 任务失败」，状态栏红点「报错」，任务栏变红（优先级高于黄/绿），把鼠标停在该会话行上，悬停卡片里出现红点「本轮失败」/「本轮中断」；
5. 触发提问 / 审批 → 弹「DSH · 需要你回应」，状态栏黄点「等待回答」，任务栏变黄；
6. 点击红点条目 → 报错确认，红点与任务栏红灯消失，行悬停提示同时消失；
7. 制造一个长列表（展开很多会话 / 把列表滚到远处），点击状态栏 chip 或通知跳转 → **左侧列表自动滚到目标会话行**；目标所在分组折叠时，至少滚到它所属的分组标题；
8. 在某个会话的输入框里打几个字但**不要发送** → 状态栏出现灰点「未开始」，任务栏不变；清空输入框或发送后灰点消失；刷新页面（`Ctrl+R`）后如果草稿还在，灰点也应重新出现。控制台 `getDrafts()` 只应看到 `{ chars }`，不应出现草稿正文；
9. 在工作区里点「新对话」进入空白会话，直接输入几个字但**不要发送** → 状态栏出现灰色「未开始：新会话」chip；清空输入框后应立即消失；
10. 打开另一个空闲会话再回到刚才那个会话 → 状态栏第二组「最近会话」里应当能找到它们，最多 5 个、按最近更新时间排序，**默认只显示 3 条**，点 `+2` 才展开到 5 条；已经在第一组里的会话不会重复出现。点最近会话 chip 只切换会话，不应确认任何报错、也不应改变任务栏灯；
11. 在侧栏把一个**正在报错 / 有未发送草稿**的会话归档 → 它的 chip 应当立刻从状态栏消失，任务栏红灯（如果是唯一红灯）同时熄灭；取消归档后 chip 回来。`inspect().archivedSessions` 是插件读到的归档集合大小；
12. 把鼠标移到「状态会话」/「最近会话」标题上 → 出现 hover 底色（说明可点）；点一下整组收起，标题后的 chevron 从 `⌄` 转到 `›`、后面多出小号数字，再点一下恢复；
13. 开到状态栏横向溢出（多个会话 / 把窗口拉窄）→ 鼠标停在状态栏上滚轮，这一排应当**横向滚动**；滚到最右后继续滚轮，事件交回宿主页面 / 祖先滚动容器（不出现「卡住不动」）。触控板左右滑 / Shift+滚轮保持原生行为。**滚到最右时最左端的 `‹` `›` 仍固定可见**；把鼠标停在这两个按钮上滚轮，chip 区一样能横滚；
14. 依次点开 A → B → C 三个会话，然后点状态栏最左端的 `‹` → 回到 B，再点 `‹` 回到 A（此时 `‹` 置灰），点 `›` 又回到 B / C；在 B 的位置直接点开新会话 D，`›` 应当置灰（前进分支被截断）。`getNavHistory()` 能看到 `entries` 与 `index` 的变化；
15. 打开「插件」→ 本插件详情页 → 设置区块里取消勾选「显示『最近会话』组」：状态栏第二组立刻消失、第一组与 ‹ › 按钮不变；刷新页面后仍然不显示；重新勾选后回来；
16. 在 A 会话里发一个带 `run_in_background` 的长任务，等 agent 交差（回合完成）→ 状态栏出现青色圆点「后台任务」，任务栏不点灯、不弹额外通知；悬停 chip 能看到命令标签；多个任务时显示 `×N`。任务结束后（下一轮轮询，最多 5 秒）青点消失。控制台 `getRunningJobs()` 只应看到 `{ count, label }`，不应出现任务输出；`inspect().jobsRoute` 应为 `supported`。
