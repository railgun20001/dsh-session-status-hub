/**
 * dsh-session-status-hub —— 状态栏与任务栏的纯逻辑模型（零依赖，可在 Node 里单测）
 *
 * 这一层把「会话列表 + 统一会话状态 + 最后回合结局投影」折叠成状态栏要显示的行，
 * 以及任务栏要显示的聚合状态。它不碰 DOM、不碰 React、不碰 Cordis。
 *
 * ## 输入形状（均来自 DSH 受支持的客户端服务）
 *
 * 1. `ctx.sessions.list` 快照：
 *    - `byId[id]`：`{ displayTitle, title, running, blank, origin, updatedAt, retainedBy }`
 *    - `projectionsBySession[id].values.hubTurnOutcome`：宿主半折叠的最后一个回合结局
 *      三态语义：对象 = 有结局；`null` = 键已注册但还没有回合；**缺失** = 宿主半未加载。
 * 2. `ctx.uiSession.sessionStatus`：`{ running, pendingInteraction, completionUnread }`
 *    - `pendingInteraction.kind` ∈ `approval` | `plan-review` | `question`
 * 3. 草稿表：`{ [sessionId]: { chars } }`，由客户端半从 `dsh.conversation.<id>` 扫描
 *    （见 hub-drafts；只有字符数，没有正文），用来推导「未开始」灰点。
 *
 * ## 状态与优先级
 *
 *   报错（error，红） > 等待回答（answer，黄） > 待查看（unread，绿）
 *   > 运行中（running，蓝） > 未开始（draft，灰）
 *
 * 口径与任务栏一致：**红 → 黄 → 绿 → 蓝 → 灰**，越靠前的颜色越需要你介入。
 * 注意这只决定**显示顺序**；一个会话归到哪一类仍由 `deriveHubRows` 的判定顺序决定
 * （同时在等你回答又还没确认上一轮失败时，按「等待回答」显示，因为它更要求你动手）。
 *
 * 「未开始」= 输入框里有尚未发送的草稿（由客户端半从 `dsh.conversation.<id>` 读取，
 * 见 hub-drafts）。它是最弱的一类提示，排在所有状态之后：有报错 / 等待回答 / 待查看 /
 * 运行中时先显示它们，草稿只在前面的条目都排完之后才占位，避免挤掉真正需要你处理的状态。
 * 空白「新会话」占位行只在有草稿时进入状态栏，标题统一显示 `blankTitle`（默认「新会话」）。
 *
 * ## 两组条目：状态会话 + 最近会话
 *
 * 状态栏渲染成两组（见 hub-ui）：
 *
 *   1. **状态会话**（{@link deriveHubRows}）：上面那五类「当下有事」的会话；
 *   2. **最近会话**（{@link deriveRecentRows}）：状态组里没有的会话按更新时间取最近 5 个，
 *      作为「刚才那个会话」的回头入口——读完 / 确认完 / 跑完就从第一组消失的会话，
 *      还能在第二组点回去。两组不会重复显示同一个会话。
 *
 * 这两组只影响**状态栏显示**；任务栏聚合（{@link aggregateTaskbarState}）只看第一组。
 *
 * **已归档的会话两组都不显示**：归档集合来自工作区注册表快照的 `archivedSessionIds`
 * （会话列表行里没有这个字段，见 {@link isArchivedSession}）。归档意味着「我把它收起来了」，
 * 让它继续以报错 / 未开始 / 最近会话的形式挂在标题栏上是反直觉的。
 *
 * 任务栏只点「需要你处理」的灯：
 *   - 有报错 → red
 *   - 否则有等待回答 → yellow
 *   - 否则有**待查看**（未读完成）→ green
 *   - 都没有 → none（清除覆盖图标）
 *
 * ## 「待查看」为什么不能只信官方的 completionUnread
 *
 * 官方 `ui-session` 的 `observeRunning` 只在「running → 停止」且**该会话不是主视图**
 * （`retainedBy.mainView === 0`）时记 `completionUnread`；`reconcileStatus` 还会对
 * 主视图会话主动清掉它。于是「你正在看这个对话、但 DSH 窗口被别的窗口盖住」这种最常见
 * 的等任务场景里，回合结束**不会有任何待查看状态**——绿点、绿灯、状态栏 chip 全都不出现。
 *
 * 插件因此自带一份「后台完成」记账（`localUnread`）：窗口不在前台时观测到的回合完成
 * 由客户端半补记，等窗口回到前台且真的在看这个会话时再清掉。判定见 {@link hasLocalUnread}。
 *
 * **运行中不点灯**：正在跑是常态，不需要你介入；把它点亮只会让任务栏一直是绿的，
 * 反而盖掉真正的提示。运行中仍然出现在状态栏 chip 里（蓝色脉冲点）。
 *
 * @module dsh-session-status-hub/hub-model
 */

/** 三类「需要你回应」的待交互（与 dsh-client-ui-workspace 的 visiblePendingKind 同口径）。 */
export const HUB_PENDING_KINDS = Object.freeze(['approval', 'plan-review', 'question'])

/**
 * 状态排序：数字越小越靠前。
 *
 * 顺序刻意与颜色一致——**红（报错）> 黄（等待回答）> 绿（待查看）
 * > 蓝（运行中）> 灰（未开始）**：一眼扫过去就是「先看红的，最后才看草稿」。
 * 灰放最后是刻意的：「未开始」只是提醒，不该挤占真正需要你处理的状态。
 * 注意这只是**显示顺序**，不是状态判定顺序（判定见 deriveHubRows：
 * 等待回答 > 报错 > 运行中 > 待查看 > 未开始，同时在等你时优先按「等待回答」显示）。
 */
export const STATE_ORDER = Object.freeze({
  error: 0,
  answer: 1,
  unread: 2,
  running: 3,
  draft: 4,
})

/** 状态的中文短标签（状态栏 chip 与通知调试用）。 */
export const STATE_LABELS = Object.freeze({
  answer: '等待回答',
  error: '报错',
  running: '运行中',
  unread: '待查看',
  draft: '未开始',
})

/** 归到「报错」的回合结局。interrupted 是宿主异常退出后的合成收尾。 */
export const HUB_FAILURE_OUTCOMES = Object.freeze(['error', 'interrupted'])

/** 状态栏最多渲染多少行（防止极端情况下渲染上千个 chip）。 */
export const MAX_HUB_ROWS = 40

/**
 * 「最近会话」组最多显示多少个。
 *
 * 这一组是**状态消失后的回头入口**：状态栏只保留当下需要你处理 / 正在跑的会话，
 * 一个会话被读完、确认完、跑完之后就会从上面那组里消失；那一组只有 3 条默认可见，
 * 很快就没有地方回到刚才那个会话了。所以这里按「最近更新时间」补一排 5 个入口。
 *
 * 5 是刻意的上限：再多就会把状态栏挤成第二个侧栏，反而不如直接去侧栏点。
 */
export const MAX_RECENT_ROWS = 5

/**
 * 取会话展示标题。
 * @param {object} row 会话列表行。
 * @param {string} [blankTitle] 空白「新会话」占位行的标题（跟随界面语言）。
 * @returns {string} 标题；都没有时回落到 id。
 */
export function hubTitleOf(row, blankTitle = '新会话') {
  // 空白「新会话」的 displayTitle 可能是工作区名、也可能是空串 / id；
  // 侧栏统一显示「新会话」，状态栏跟随同一语义，避免一串原始 id。
  if (row?.blank === true) return blankTitle
  const display = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
  if (display !== '') return display
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  if (title !== '') return title
  return typeof row?.id === 'string' && row.id !== '' ? row.id : '未命名会话'
}

/**
 * 从会话列表快照里解析当前打开的会话。
 *
 * 判据与侧栏一致：`retainedBy.mainView > 0` 的那一行就是主视图中的会话
 * （dsh-client-ui-workspace 的 mainSessionId 同款）。
 * @param {object} list 会话列表快照。
 * @returns {string|undefined} 当前会话 id。
 */
export function currentSessionIdOf(list) {
  const byId = list?.byId
  if (byId === null || typeof byId !== 'object') return undefined
  for (const id of Object.keys(byId)) {
    const row = byId[id]
    if (row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

/**
 * 把「Map 或普通对象」统一成可按 id 查询的函数。
 * @param {unknown} container Map 或对象。
 * @returns {(id: string) => object|undefined} 查询函数。
 */
function lookupOf(container) {
  if (container instanceof Map) return (id) => container.get(id)
  if (container !== null && typeof container === 'object') return (id) => container[id]
  return () => undefined
}

/**
 * 取某会话的最后回合结局投影。
 *
 * 兼容两个位置：会话列表 RPC 的 `projectionsBySession`，以及单行 `projectionValues`
 * （搜索 / 本地 fallback 行的形状）。两者都没有时返回 `undefined`，保留「宿主半未加载」
 * 与「还没有回合」的三态区别。
 * @param {object} list 会话列表快照。
 * @param {string} id 会话 id。
 * @returns {object|null|undefined} 投影值。
 */
export function projectionOf(list, id) {
  const fromList = list?.projectionsBySession?.[id]?.values
  if (fromList !== null && typeof fromList === 'object' && Object.hasOwn(fromList, 'hubTurnOutcome')) {
    return fromList.hubTurnOutcome
  }
  const values = list?.byId?.[id]?.projectionValues
  if (values !== null && typeof values === 'object' && Object.hasOwn(values, 'hubTurnOutcome')) {
    return values.hubTurnOutcome
  }
  return undefined
}

/**
 * 判断一个投影是否构成「尚未确认的报错」。
 * @param {object|null|undefined} projection 投影值。
 * @param {number} ackedSeq 已确认到的 seq（没有确认过是 -1）。
 * @returns {boolean} 是否应显示报错。
 */
export function isUnackedFailure(projection, ackedSeq) {
  if (projection === null || typeof projection !== 'object') return false
  if (!HUB_FAILURE_OUTCOMES.includes(projection.outcome)) return false
  const seq = Number.isInteger(projection.seq) ? projection.seq : -1
  return seq > ackedSeq
}

/**
 * 判断某会话是否被本插件补记为「后台完成、尚未查看」。
 *
 * 接受的形状（都按 id 命中即可，值本身不参与判定）：
 *   - `{ [sessionId]: seq }`（客户端半落盘的形状）；
 *   - `Set<string>` / `Map<string, number>`（测试与调用方便利）。
 *
 * @param {object|Set<string>|Map<string, number>|null|undefined} localUnread 记账表。
 * @param {string} id 会话 id。
 * @returns {boolean} 是否属于「后台完成未查看」。
 */
export function hasLocalUnread(localUnread, id) {
  if (localUnread === null || localUnread === undefined) return false
  if (localUnread instanceof Set || localUnread instanceof Map) return localUnread.has(id)
  if (typeof localUnread !== 'object') return false
  const value = localUnread[id]
  return value !== undefined && value !== null && value !== false
}

/**
 * 判断某会话是否有「尚未发送的非空草稿」。
 *
 * 接受的形状（都按 id 命中）：
 *   - `{ [sessionId]: { chars: number } }`（hub-drafts 扫描结果，客户端半实际使用的形状）；
 *   - `{ [sessionId]: string }`（测试 / 调用方便利，非空即算）；
 *   - `Set<string>` / `Map<string, unknown>`（测试便利）。
 *
 * 注意：草稿正文永远不进入模型层，这里只判断「有没有」。
 * @param {object|Set<string>|Map<string, unknown>|null|undefined} drafts 草稿表。
 * @param {string} id 会话 id。
 * @returns {boolean} 是否有草稿。
 */
export function hasDraftContent(drafts, id) {
  if (drafts === null || drafts === undefined) return false
  let value
  if (drafts instanceof Set) value = drafts.has(id) ? true : undefined
  else if (drafts instanceof Map) value = drafts.get(id)
  else value = drafts[id]
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return value > 0
  if (value === null || typeof value !== 'object') return value === true
  if (typeof value.chars === 'number') return value.chars > 0
  return typeof value.text === 'string' && value.text.trim() !== ''
}

/**
 * 判断某会话是否属于「已归档」。
 *
 * ## 为什么归档要单独判
 *
 * 归档集合**不在会话列表行里**：官方把 `archivedSessionIds` 放在工作区注册表快照
 * （客户端 `useWorkspaces` 的 `archivedSessionIds`，宿主侧是 `workspaceRegistry` 的全局
 * 归档集）。会话列表 `byId` 的行仍会包含已归档会话（它们只是不在侧栏列表里显示），
 * 所以状态栏必须自己按这份 id 集合过滤——否则归档掉的旧对话会以「最近会话」甚至
 * 「未开始 / 报错」的形式一直挂在标题栏上。
 *
 * 接受的形状（都只做 id 命中判断）：
 *   - `string[]`（`useWorkspaces` 快照实际给的形状）；
 *   - `Set<string>` / `Map<string, unknown>`（调用方便利）；
 *   - `{ [sessionId]: true }`（调用方便利）。
 *
 * @param {readonly string[]|Set<string>|Map<string, unknown>|object|null|undefined} archivedIds 归档集合。
 * @param {string} id 会话 id。
 * @returns {boolean} 是否已归档。
 */
export function isArchivedSession(archivedIds, id) {
  if (archivedIds === null || archivedIds === undefined) return false
  if (archivedIds instanceof Set || archivedIds instanceof Map) return archivedIds.has(id)
  if (Array.isArray(archivedIds)) return archivedIds.includes(id)
  if (typeof archivedIds !== 'object') return false
  const value = archivedIds[id]
  return value !== undefined && value !== null && value !== false
}

/**
 * 归一化一张「会话 id → seq」的持久表：只保留非空字符串 id 与非负整数 seq。
 *
 * 「已确认的报错」与「补记的后台完成」是**同一形状**的两张表，以前各写了一份逐行相同的
 * 实现；现在共用这一个函数（下面两个名字是语义别名，保留是为了调用处的可读性）。
 * @param {unknown} value 读到的 JSON。
 * @returns {object} `{ [sessionId]: number }`。
 */
export function normalizeSeqMap(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [id, seq] of Object.entries(value)) {
    if (typeof id === 'string' && id !== '' && Number.isInteger(seq) && seq >= 0) out[id] = seq
  }
  return out
}

/**
 * 归一化持久化的「后台完成」记账：只保留整数 seq（>= 0）的会话。
 *
 * seq 是「补记时那一轮回合的投影序号」，只用于诊断与去重；判定只看键是否存在。
 * @type {(value: unknown) => object}
 */
export const normalizeLocalUnread = normalizeSeqMap

/**
 * 从快照推导状态栏行。
 *
 * @param {object} input 输入。
 * @param {object} input.list 会话列表快照。
 * @param {Map|object} input.statuses 统一会话状态（Map 或对象）。
 * @param {object} [input.ackErrors] 已确认的报错 seq：`{ [sessionId]: number }`。
 * @param {object|Set<string>|Map<string, number>} [input.localUnread] 本插件补记的
 *   「后台完成、尚未查看」会话（见 {@link hasLocalUnread}）。
 * @param {object|Set<string>|Map<string, unknown>} [input.drafts] 有未发送草稿的会话
 *   （见 {@link hasDraftContent}；正文不会传进来，只传元数据）。
 * @param {string} [input.blankTitle] 空白「新会话」占位行的显示标题（默认「新会话」）。
 * @param {boolean} [input.includeSubagents] 是否包含子代理会话（默认 false）。
 * @param {readonly string[]|Set<string>|object} [input.archivedIds] 已归档会话 id 集合
 *   （见 {@link isArchivedSession}）；已归档会话一律不显示。
 * @param {number} [input.now] 当前时间（保留给未来排序/过期策略）。
 * @returns {Array<{id: string, title: string, state: string, pendingKind: string|null, errorSeq: number|null, updatedAt: number}>}
 *   按颜色优先级（红 > 黄 > 绿 > 蓝 > 灰）与更新时间排好序的行。
 */
export function deriveHubRows({
  list,
  statuses,
  ackErrors = {},
  localUnread = {},
  drafts = {},
  blankTitle = '新会话',
  includeSubagents = false,
  archivedIds = null,
  now = 0,
} = {}) {
  const byId = list?.byId
  if (byId === null || typeof byId !== 'object') return []
  const statusOf = lookupOf(statuses)
  const rows = []

  for (const [id, row] of Object.entries(byId)) {
    if (row === null || typeof row !== 'object') continue
    // 已归档的会话不显示：归档 = 用户主动收起来的东西，不该继续在标题栏上提醒。
    if (isArchivedSession(archivedIds, id)) continue
    // 「未开始」只代表输入框里有未发送草稿；它是最弱的一类事实，不能盖住任何既有状态。
    // 需要先算出来：空白「新会话」占位行只有在有草稿时才值得进入状态栏。
    const draft = hasDraftContent(drafts, id)
    // 空白「新会话」占位行没有内容时不进入状态栏；已经打了字但还没发送时，
    // 它就是一个真实的「未开始」会话，应当显示。
    if (row.blank === true && !draft) continue
    // 子代理会话默认不打扰用户；一次任务会被子代理的成败淹没。
    if (row.origin === 'subagent' && !includeSubagents) continue

    const status = statusOf(id)
    const pendingKind = HUB_PENDING_KINDS.includes(status?.pendingInteraction?.kind)
      ? status.pendingInteraction.kind
      : null
    const projection = projectionOf(list, id)
    const acked = Number.isInteger(ackErrors[id]) ? ackErrors[id] : -1
    const failed = isUnackedFailure(projection, acked)
    const running = status?.running === true || row.running === true
    // 「待查看」有两个来源：官方 completionUnread（非主视图会话），以及本插件为
    // 「窗口不在前台时完成的当前会话」补记的记账（官方对主视图会话永远不会置位）。
    const unread = status?.completionUnread === true || hasLocalUnread(localUnread, id)

    // 判定顺序（一个会话只归一类，取第一个命中的）：等待回答 > 报错 > 运行中 > 待查看 > 未开始。
    // 这与 STATE_ORDER（显示顺序 红 > 黄 > 绿 > 蓝 > 灰）是两件事：同时「等你回答」又「上一轮
    // 还没确认失败」时，归为「等待回答」——它才是当下马上要你动手的那件事。
    let state = null
    if (pendingKind !== null) state = 'answer'
    else if (failed) state = 'error'
    else if (running) state = 'running'
    else if (unread) state = 'unread'
    else if (draft) state = 'draft'
    if (state === null) continue

    rows.push({
      id,
      title: hubTitleOf(row, blankTitle),
      state,
      pendingKind,
      errorSeq: failed && typeof projection?.seq === 'number' ? projection.seq : null,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    })
  }

  // 显示顺序：红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）> 灰（未开始）；
  // 同一类里更新时间新的靠前，最后用 id 兜底保证顺序稳定（避免 React key 跳动）。
  rows.sort((a, b) => {
    const byState = (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99)
    if (byState !== 0) return byState
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.id.localeCompare(b.id)
  })
  return rows.slice(0, MAX_HUB_ROWS)
}

/**
 * 推导「最近会话」组的行：按更新时间取最近若干个**不在**「状态会话」组里的会话。
 *
 * ## 为什么是「不在状态组里」而不是「曾经进过状态组又移出的」
 *
 * 「移出」这个事件在客户端没有可靠的观测点：会话的状态是**当前值快照**而不是事件流
 * （见 README 第 5 节），一个会话「刚才还在报错、现在被你确认了」与「一直空闲」在两次
 * 快照之间完全不可区分。要精确记录「移出」就得维护一张持久化移出表，还要处理刷新、
 * 多标签页、宿主重启后的对账——代价与收益不成比例。
 *
 * 等价的观察结果是：**状态组已经不显示的会话**，按最近更新时间取前 N 个，就是用户
 * 刚才在处理的那批会话（刚读完 / 刚确认 / 刚跑完 / 刚切换过去的会话必然排在最前）。
 * 所以这里直接按 `updatedAt` 排序，不再引入第二份会漂移的状态。
 *
 * ## 排除规则
 *
 *   - 已经在状态组里显示的会话（`statusRows` 里出现过的 id）：同一行状态栏里出现两次
 *     只会让人怀疑自己点错了；
 *   - 已归档会话（见 {@link isArchivedSession}）：归档是「收起来」的意思，不该在标题栏复活；
 *   - 空白「新会话」占位行（`blank === true`）：没有内容，列出来就是一串同名「新会话」；
 *   - 子代理会话（`origin === 'subagent'`，除非显式 `includeSubagents`）：与状态栏同口径，
 *     一次任务子代理的成败不该出现在这里。
 *
 * @param {object} input 输入。
 * @param {object} input.list 会话列表快照（`byId` 形状与 {@link deriveHubRows} 相同）。
 * @param {Array<{id: string}>} [input.statusRows] 「状态会话」组当前已经显示的行。
 * @param {number} [input.limit] 最多返回多少行（默认 {@link MAX_RECENT_ROWS}；<= 0 表示不显示该组）。
 * @param {string} [input.blankTitle] 空白占位行标题（这里只会用来做兜底，正常不会出现）。
 * @param {boolean} [input.includeSubagents] 是否包含子代理会话（默认 false）。
 * @param {readonly string[]|Set<string>|object} [input.archivedIds] 已归档会话 id 集合
 *   （见 {@link isArchivedSession}）；已归档会话一律不出现。
 * @returns {Array<{id: string, title: string, updatedAt: number}>} 按更新时间倒序的行。
 */
export function deriveRecentRows({
  list,
  statusRows = [],
  limit = MAX_RECENT_ROWS,
  blankTitle = '新会话',
  includeSubagents = false,
  archivedIds = null,
} = {}) {
  const byId = list?.byId
  if (byId === null || typeof byId !== 'object') return []
  if (!Number.isFinite(limit) || limit <= 0) return []

  const shown = new Set()
  if (Array.isArray(statusRows)) {
    for (const item of statusRows) {
      if (typeof item?.id === 'string' && item.id !== '') shown.add(item.id)
    }
  }

  const rows = []
  for (const [id, row] of Object.entries(byId)) {
    if (row === null || typeof row !== 'object') continue
    if (shown.has(id)) continue
    if (isArchivedSession(archivedIds, id)) continue
    if (row.blank === true) continue
    if (row.origin === 'subagent' && !includeSubagents) continue
    rows.push({
      id,
      title: hubTitleOf(row, blankTitle),
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    })
  }

  // 更新时间新的靠前；同一时刻用 id 兜底，保证顺序稳定（避免 React key 跳动）。
  rows.sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.id.localeCompare(b.id)
  })
  return rows.slice(0, limit)
}

/**
 * 把状态栏行聚合为任务栏状态（红 > 黄 > 绿 > 无）。
 *
 * 绿只来自「待查看」（未读完成），**不含运行中，也不含「未开始」草稿**：运行中与草稿
 * 都不需要你立刻处理，任务栏常亮只会盖掉真正需要你介入的红/黄提示。它们仍然在状态栏
 * chip 里可见。
 * @param {Array<{state: string}>} rows 状态栏行。
 * @returns {'red'|'yellow'|'green'|'none'} 任务栏状态。
 */
export function aggregateTaskbarState(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'none'
  if (rows.some((row) => row?.state === 'error')) return 'red'
  if (rows.some((row) => row?.state === 'answer')) return 'yellow'
  if (rows.some((row) => row?.state === 'unread')) return 'green'
  return 'none'
}

/**
 * 判定某会话「尚未确认的失败」属于哪一类，供行内提示挑选文案。
 *
 * 与 {@link isUnackedFailure} 同判据，只是把布尔换成可读的类别：
 * `error`（模型/工具报错）、`interrupted`（宿主异常退出后的合成收尾）。
 * @param {object|null|undefined} projection 投影值。
 * @param {number} ackedSeq 已确认到的 seq。
 * @returns {'error'|'interrupted'|null} 失败类别；没有未确认失败时为 null。
 */
export function failureKindOf(projection, ackedSeq) {
  if (!isUnackedFailure(projection, ackedSeq)) return null
  return projection.outcome === 'interrupted' ? 'interrupted' : 'error'
}

/**
 * 归一化持久化的报错确认表：只保留整数 seq，丢掉坏值。
 *
 * 实现见 {@link normalizeSeqMap}（与「后台完成」记账共用一份）。
 * @type {(value: unknown) => object}
 */
export const normalizeAckErrors = normalizeSeqMap
