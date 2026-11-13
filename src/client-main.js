/**
 * dsh-session-status-hub —— 客户端半的接线层（浏览器 bundle 的 factory 体）
 *
 * 这一层只做「编排」，不实现细节：
 *
 *   DSH 服务（sessions / uiSession）
 *        │  订阅 + 30ms 合并窗口
 *        ▼
 *   tick()  ──▶ planNotifications（notify-core）──▶ 通知 + 回合完成边沿
 *        │                                        └─▶ hub-stores 记「后台完成」
 *        ├──▶ deriveHubRows（hub-model）──────▶ 状态栏行 ──▶ hub-host 上报任务栏
 *        ├──▶ 草稿扫描（hub-drafts）──────────▶ 「未开始」灰点
 *        └──▶ 诊断快照（__DSH_SESSION_HUB__）
 *
 * 具体实现分别住在：
 *
 * | 关注点 | 文件 |
 * |---|---|
 * | 插件 id / 存储键 | hub-identity.js |
 * | 界面文案 | hub-strings.js |
 * | localStorage 读写 | hub-json-store.js |
 * | 配置 / 水位 / 确认表 / 待查看记账 | hub-stores.js |
 * | 通知落地（tag、去重、落地日志） | hub-notify.js |
 * | 宿主半路由（前置窗口 / 任务栏 / 探活） | hub-host.js |
 * | 状态栏与行悬停组件 | hub-ui.js |
 * | 插槽注册 | hub-slots.js |
 * | 状态与优先级模型 | hub-model.js |
 * | 会话导航（前进 / 后退）历史 | hub-history.js |
 * | 未发送草稿的读取 | hub-drafts.js |
 * | 通知边沿引擎 | notify-core.js |
 * | 侧栏滚动 | hub-scroll.js |
 *
 * 它不 retain 任何会话——因此不会激活别人的历史，也不会在侧栏里留下痕迹。
 * 任何异常都只记日志：状态栏与通知绝不能影响 DSH 本身。
 *
 * @module dsh-session-status-hub/client
 */

/** 硬依赖：会话列表与统一会话状态。两者都是 web 组合的常驻服务。 */
const inject = ['sessions', 'uiSession']

/** 状态变化的合并窗口（毫秒）：把一串推送折叠成一次观察。 */
const TICK_COALESCE_MS = 30

/** 水位 / 确认表落盘的合并窗口（毫秒）。 */
const PERSIST_COALESCE_MS = 400

/**
 * 草稿扫描的兜底轮询间隔（毫秒）。
 *
 * 草稿写进 `localStorage` 不会触发同页面的 `storage` 事件；输入框打字时另有
 * `input` / `compositionend` 监听做即时扫描，这个轮询只负责兜住「程序化写入、
 * 会话切换、其他标签页写入」等没有输入事件的路径，所以 2 秒足够。
 */
const DRAFT_POLL_MS = 2000

/** 输入事件触发的草稿扫描合并窗口（毫秒）：连续敲字只读一次存储。 */
const DRAFT_INPUT_SCAN_MS = 200

/**
 * 窗口是否处于「用户就在看」的状态。
 * @param {object} config 归一化配置。
 * @returns {boolean} 是否聚焦。
 */
function isFocused(config) {
  try {
    if (typeof document === 'undefined') return false
    if (config.requireVisibleForFocus && document.visibilityState !== 'visible') return false
    return typeof document.hasFocus === 'function' ? document.hasFocus() : true
  } catch {
    return false
  }
}

/**
 * 把会话列表快照投影成引擎需要的最小事实。
 *
 * 投影值刻意保留三态：键在但值为 null（宿主半已注册、该会话还没有回合结局）
 * 与键缺失（宿主半没加载）在引擎里含义不同，不能都压成 null。
 * @param {object} listState 会话列表快照。
 * @returns {{sessions: object, projections: object, hostHalfPresent: boolean}} 会话行、投影值、宿主半是否在。
 */
function projectListState(listState) {
  const sessions = {}
  const projections = {}
  let hostHalfPresent = false
  const byId = listState?.byId
  if (byId === null || typeof byId !== 'object') return { sessions, projections, hostHalfPresent }

  for (const [id, row] of Object.entries(byId)) {
    if (row === null || typeof row !== 'object') continue
    sessions[id] = {
      id,
      displayTitle: row.displayTitle,
      title: row.title,
      origin: row.origin,
      blank: row.blank,
      running: row.running,
      updatedAt: row.updatedAt,
    }
    const values = listState.projectionsBySession?.[id]?.values
    if (values !== undefined && values !== null && Object.hasOwn(values, PROJECTION_KEY)) {
      projections[id] = values[PROJECTION_KEY]
      hostHalfPresent = true
    }
  }
  return { sessions, projections, hostHalfPresent }
}

/**
 * 把统一会话状态快照（ReadonlyMap 或普通对象）投影成引擎需要的形状。
 * @param {unknown} statusSnapshot 状态快照。
 * @returns {object} 按 id 索引的状态。
 */
function projectStatuses(statusSnapshot) {
  const statuses = {}
  if (statusSnapshot instanceof Map) {
    for (const [id, status] of statusSnapshot) statuses[id] = status
    return statuses
  }
  if (statusSnapshot !== null && typeof statusSnapshot === 'object') {
    for (const [id, status] of Object.entries(statusSnapshot)) statuses[id] = status
  }
  return statuses
}

/**
 * 读取某个会话当前的待交互 key。
 *
 * 与通知引擎同口径：非对象 / 空 key 都算「没有待交互」。用来判断一条「需要你回应」
 * 通知是不是已经过期（用户已经回答 / 批准，或者话题换成了新的问题）。
 * @param {object} statuses 按 id 索引的统一状态。
 * @param {string} sessionId 会话 id。
 * @returns {string|null} 待交互 key；没有时为 null。
 */
function pendingInteractionKeyOf(statuses, sessionId) {
  const pending = statuses?.[sessionId]?.pendingInteraction
  if (pending === null || typeof pending !== 'object') return null
  return typeof pending.key === 'string' && pending.key !== '' ? pending.key : null
}

/**
 * 判断当前页面是否是 DSH 桌面端外壳（只有那里才有任务栏图标可标记）。
 * @returns {boolean} 是否桌面端。
 */
function isDesktopShell() {
  try {
    return typeof location !== 'undefined' && location.protocol === 'dsh-app:'
  } catch {
    return false
  }
}

/**
 * 应用 Cordis 客户端插件。
 * @param {object} ctx 客户端 Cordis 上下文。
 */
function apply(ctx) {
  const keys = hubStorageKeys(PLUGIN_ID)
  const store = createJsonStore({ pluginId: PLUGIN_ID })
  // 0.1.x 的键前缀是旧插件 id：搬一次，别让升级把配置、报错确认与「后台完成」记账弄丢。
  const migrated = migrateLegacyKeys({ store, keys, legacyKeys: hubStorageKeys(LEGACY_PLUGIN_ID) })
  if (migrated.length > 0) {
    ctx.logger?.info?.(`[${PLUGIN_ID}] 已把旧前缀（${LEGACY_PLUGIN_ID}）的状态迁移到新键：${migrated.join(', ')}`)
  }
  const stores = createHubStores({
    store,
    keys,
    normalize: { config: normalizeConfig, seqMap: normalizeSeqMap },
  })
  /** 生效中的配置（对象被就地更新，读取请走这里）。 */
  const config = stores.config
  const { acks, localUnread } = stores
  /**
   * 「未开始」草稿表：`{ [sessionId]: { chars } }`。
   *
   * 只放「这个会话有没有非空草稿」的元数据，不含正文（见 hub-drafts 的隐私边界）。
   * 由 `syncDraftsFromList` 从 `dsh.conversation.<id>` 扫描得到，React 侧订阅这个快照。
   */
  const drafts = createSnapshotStore({})

  /**
   * 会话导航历史（状态栏左端 ‹ › 两个按钮背后的那本账）。
   *
   * 记录点只有一个：每次观察时把「当前主视图会话」交给它（见 `tick`）。侧栏点击、
   * 状态栏 chip、通知点击、宿主快捷键最终都会改变 `retainedBy.mainView`，所以不需要在
   * 每个跳转分支里各记一次。详见 hub-history 的模块注释。
   */
  const navHistory = createNavHistory({ limit: MAX_NAV_ENTRIES })

  let tickTimer = null
  let persistTimer = null
  let draftInputTimer = null
  let disposed = false
  /** 最近一次推导出的状态栏行（诊断与任务栏聚合用）。 */
  let lastRows = []

  /** 安全读取一个（可能尚未注册的）服务。 */
  const safeGet = (serviceName) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 取工作区注册表的快照仓库（根级 hook `useWorkspaces` 背后的同一个 store）。
   *
   * 归档集合只存在于这里（会话列表行没有「已归档」字段）。两个受支持入口都试一遍：
   * `uiWorkspace.workspaces.list`（ui-workspace 的对外服务面，hub-scroll 也用它）与
   * `workspaces.list`（控制器服务本体）。都拿不到时返回 undefined，调用方按「没有归档」处理。
   * @returns {{ getSnapshot?: () => object, subscribe?: Function }|undefined} 快照仓库。
   */
  const workspacesSnapshotStore = () => safeGet('uiWorkspace')?.workspaces?.list ?? safeGet('workspaces')?.list

  /**
   * 读取已归档会话 id 集合（拿不到时返回 null，表示「不做归档过滤」）。
   * @returns {readonly string[]|null} 归档集合。
   */
  const readArchivedSessionIds = () => {
    try {
      const snapshot = workspacesSnapshotStore()?.getSnapshot?.()
      return Array.isArray(snapshot?.archivedSessionIds) ? snapshot.archivedSessionIds : null
    } catch {
      return null
    }
  }

  /** 让窗口到前台：渲染进程自己只能尽力而为（真正的保证在宿主半）。 */
  const focusWindowBestEffort = () => {
    try {
      if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus()
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] 聚焦窗口失败`, error)
    }
  }

  // ---- 宿主半：前置窗口 / 任务栏状态 / 在线探活 ----
  const host = createHostBridge({
    pluginId: PLUGIN_ID,
    version: BUNDLE_VERSION,
    getConfig: () => config,
    isDesktopShell,
    isDisposed: () => disposed,
  })

  // ---- 跳转后把左侧会话列表也滚到目标行 ----
  const revealSessionInList = createRowRevealer({
    pluginId: PLUGIN_ID,
    getDocument: () => (typeof document === 'undefined' ? null : document),
    getWorkspaces: () => safeGet('uiWorkspace')?.workspaces?.list?.getSnapshot?.(),
    isCancelled: () => disposed,
  })

  /**
   * 打开一个会话（状态栏条目 / 通知点击的落点）。
   *
   * 五件事，按重要性排序：
   *   1. 在应用内跳转到该会话（受支持通道，必然生效）；
   *   2. 把左侧会话列表也滚动到该会话行（官方 openSession 不会滚）；
   *   3. 撤掉这个会话仍然挂在系统里的通知（打开即视为已读，不能让它继续留在屏幕上）；
   *   4. 请求宿主半把桌面窗口提到前台（渲染进程自己做不到）；
   *   5. `window.focus()` 兜底（受 Blink 手势门控，可能无效，但零成本）。
   *
   * `options.raise === false` 时跳过第 4 步：**点击状态栏 chip 时窗口本来就在前台**，
   * 再走一次窗口前置毫无收益，反而会经过 Win32 的窗口状态处理（历史实现里的
   * SW_RESTORE 会把最大化窗口打回普通尺寸）。chip 点击只做应用内跳转。
   * @param {string} sessionId 目标会话。
   * @param {{ raise?: boolean }} [options] `raise:false` 表示不请求宿主半前置窗口。
   */
  const openSession = (sessionId, options = {}) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const workspace = safeGet('uiWorkspace')
    if (workspace !== undefined && typeof workspace.openSession === 'function') {
      try {
        workspace.openSession(sessionId)
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 打开会话失败：${sessionId}`, error)
      }
    } else {
      // 退路：uiWorkspace 不可用时广播一个 DOM 事件，方便别的插件/用户脚本接管。
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(`${PLUGIN_ID}:open-session`, { detail: { sessionId } }))
        }
      } catch {
        /* 事件广播失败不影响通知本身 */
      }
    }
    // 让左侧会话列表也滚到该会话行：官方 openSession 只切换主视图，不滚动列表。
    // 这一步只读 DOM、异步等待渲染，失败静默，绝不影响上面真正的跳转。
    revealSessionInList(sessionId)
    // 用户主动跳转（点通知 / 点 chip）= 已经去看这个会话了：清掉「后台完成」记账，
    // 绿点与任务栏绿灯随之熄灭。这条路径不依赖窗口此刻是否已经获得焦点。
    if (stores.clearLocalUnread(sessionId)) scheduleTick()
    // 同理，这个会话的系统通知也已经「看过了」：立即从屏幕 / 操作中心撤掉。
    // 通知点击自身已在 onclick 里 close 过，这里对同一会话的其他残留通知一并收尾。
    notifySink.dismissSession(sessionId)
    if (options.raise !== false) host.callHostRoute('raise')
    focusWindowBestEffort()
  }

  /**
   * 确认某个会话的报错（点击状态栏条目 / 正在看该会话时自动确认）。
   * @param {string} sessionId 会话 id。
   * @param {number|null} seq 报错回合的 seq；null 不是合法确认值。
   */
  const ackError = (sessionId, seq) => {
    if (!stores.ackError(sessionId, seq)) return
    // 让任务栏聚合状态立即跟上（红灯在当前条目被确认后应当熄灭）。
    scheduleTick()
  }

  /**
   * 沿「会话导航历史」走一步（状态栏左端 ‹ › 两个按钮的落点）。
   *
   * 先 `peek` 再看目标会话是否还在目录里：历史里可能有已经被删除的会话，此时直接放弃
   * 这次跳转（游标不前移，按钮保持原样），比跳到一个空会话更合理。跳转本身走
   * {@link openSession}，因此滚动侧栏、清掉待查看记账、撤回通知等行为与点 chip 完全一致；
   * `raise: false` 同样适用——用户点按钮时窗口就在前台。
   *
   * @param {-1|1} delta 负数后退，正数前进。
   * @returns {boolean} 是否真的发起了跳转。
   */
  const navigateHistory = (delta) => {
    const target = navHistory.peek(delta)
    if (target === null) return false
    const byId = safeGet('sessions')?.list?.getSnapshot?.()?.byId
    if (byId === null || byId === undefined || !Object.hasOwn(byId, target)) return false
    const moved = delta < 0 ? navHistory.back() : navHistory.forward()
    if (moved === null) return false
    openSession(moved, { raise: false })
    return true
  }

  // ---- 通知落地：tag 哈希 / 跨标签页去重 / 落地诊断日志 ----
  const notifySink = createNotifySink({
    pluginId: PLUGIN_ID,
    keys,
    store,
    getConfig: () => config,
    isFocused: () => isFocused(config),
    openSession,
    // 通知一弹出，用户很可能一两秒内就点它：提前把宿主半的 worker 烧热。
    onFirstShow: () => host.callHostRoute('warmup'),
  })

  /**
   * 取当前环境的 localStorage；隐私模式 / 非浏览器环境下访问本身就可能抛错。
   * @returns {Storage|null} 存储对象或 null。
   */
  const draftStorage = () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      return null
    }
  }

  /**
   * 读取**当前主视图会话**的实时输入草稿。
   *
   * 为什么还需要这一路：`ui-conversation` 对普通会话会把草稿持久化到
   * `dsh.conversation.<id>`，但空白「新会话」在发出第一条消息前不一定落这个键
   * （实测旧数据里 40 个 blank 会话没有对应的 conversation 键）。空白会话的输入框
   * 仍然挂在 `uiSession.current` 的 `input` hook 上，所以这里直接读实时快照：
   *
   *   uiSession.current.getSnapshot()
   *     .hooks.input.getSnapshot().draft
   *
   * 这是受支持的客户端服务面，不会创建会话、不会 retain 历史；只在当前会话有输入时
   * 提供补充。返回值只保留字符数，正文不进入插件状态。
   *
   * @returns {{ id: string, chars: number }|null} 当前会话及其草稿字符数；不可用时 null。
   */
  const liveDraftOf = () => {
    try {
      const current = safeGet('uiSession')?.current
      const binding = typeof current?.getSnapshot === 'function' ? current.getSnapshot() : current?.value
      const sessionId = typeof binding?.key === 'string' ? binding.key : ''
      const hook = binding?.hooks?.input
      const input = typeof hook?.getSnapshot === 'function' ? hook.getSnapshot() : hook
      if (sessionId === '' || typeof input?.draft !== 'string') return null
      return { id: sessionId, chars: input.draft.trim().length }
    } catch {
      // 旧版本 / 测试桩没有 current 或 input hook：退回 localStorage 扫描。
      return null
    }
  }

  /**
   * 从会话列表快照同步草稿表。
   *
   * 只扫描列表里真实存在的会话；空白占位行是否进入状态栏由模型层决定（有草稿才进）。
   * 当前主视图会话再用 `uiSession.current` 的实时 input hook 补一刀：空白新会话
   * 可能还没有 localStorage 键，但实时 hook 已经有了。
   * 内容没变时不发布新快照，避免无谓的 React 重渲染。
   * @param {object} listState 会话列表快照。
   * @returns {boolean} 草稿表是否发生了变化。
   */
  const syncDraftsFromList = (listState) => {
    const byId = listState?.byId
    const sessionIds = byId !== null && typeof byId === 'object' ? Object.keys(byId) : []
    const previous = drafts.getSnapshot()
    const next = scanSessionDrafts(draftStorage(), sessionIds, previous)
    // 实时 hook 优先于持久化值：用户刚清空输入框时 localStorage 可能还没写完，
    // 也要立刻撤掉「未开始」；只有当前主视图会话有这条路。
    const live = liveDraftOf()
    if (live !== null && byId !== null && typeof byId === 'object' && Object.hasOwn(byId, live.id)) {
      if (live.chars > 0) next[live.id] = { chars: live.chars }
      else delete next[live.id]
    }
    if (sameDraftMap(previous, next)) return false
    drafts.set(next)
    return true
  }

  /** 重新读一遍草稿（输入事件 / 轮询 / 焦点变化时调用）。 */
  const refreshDrafts = () => {
    try {
      const listState = safeGet('sessions')?.list?.getSnapshot?.()
      if (listState === undefined || listState === null) return
      // 状态栏直接订阅 drafts 快照会立即重渲染；这里再排一次观察是为了让诊断行
      // （getRows）与任务栏聚合在同一帧跟上，且不会形成环（内容不变时返回 false）。
      if (syncDraftsFromList(listState)) scheduleTick()
    } catch (error) {
      // 草稿是锦上添花：读失败只记日志，绝不影响既有四类状态。
      console.warn(`[${PLUGIN_ID}] 读取会话草稿失败`, error)
    }
  }

  /** 立即观察一次（合并窗口到期时执行）。 */
  const tick = () => {
    tickTimer = null
    if (disposed) return
    try {
      const sessionsService = safeGet('sessions')
      const uiSession = safeGet('uiSession')
      if (sessionsService === undefined || uiSession === undefined) return

      const listState = sessionsService.list?.getSnapshot?.()
      if (listState === undefined || listState === null) return
      // 会话列表变化（新会话 / 归档 / 标题）可能同时改变要扫描的草稿键集合；
      // 在推导行之前同步，保证这一帧的「未开始」与列表一致。
      syncDraftsFromList(listState)
      const statusSnapshot = uiSession.sessionStatus?.getSnapshot?.()
      const statuses = projectStatuses(statusSnapshot)
      // 状态快照没拿到时不能据此判断「待交互已经消失」，否则会把还在等你的通知误撤掉。
      const statusKnown = statusSnapshot instanceof Map
        || (statusSnapshot !== null && typeof statusSnapshot === 'object')

      // 一次观察里只判定一次「窗口在不在前台」：状态栏、通知、待查看记账必须同源，
      // 否则会在同一帧里得出互相矛盾的结论。
      const focused = isFocused(config)
      const currentSessionId = currentSessionIdOf(listState)
      // 会话导航历史：把「当前主视图会话」记进历史（幂等，同一会话重复观察不产生新条目）。
      // 放在这里而不是跳转分支里，侧栏点击 / chip / 通知点击都会被记上。
      navHistory.observe(currentSessionId)

      // 1) 通知边沿。它同时给出「这一轮结束了」的事实（result.completions），
      //    所以必须排在状态栏推导之前——补记的「待查看」要在同一帧里点亮绿点 / 绿灯。
      const { sessions, projections, hostHalfPresent } = projectListState(listState)
      if (!hostHalfPresent) host.checkHostHalf()
      const result = planNotifications({
        sessions,
        projections,
        statuses,
        state: stores.watermarks.get(),
        config,
        now: Date.now(),
        focused,
        currentSessionId,
        // 兜底路径只认探活结论：确证宿主半缺失才允许用 running 下降沿当「完成」。
        allowRunningFallback: host.hostHalfState() === 'absent',
      })

      stores.watermarks.set(result.state)
      schedulePersist()

      // 2) 「后台完成」记账：官方 completionUnread 对主视图会话永不置位，这里补上。
      //    - 窗口不在前台时完成的回合 → 记为待查看（绿点 / 任务栏绿灯 / 完成通知）；
      //    - 窗口在前台且正在看这个会话 → 视为已查看，清掉记账。
      if (focused) {
        if (currentSessionId !== undefined) stores.clearLocalUnread(currentSessionId)
      } else {
        for (const completion of result.completions) {
          stores.markLocalUnread(completion.sessionId, completion.seq)
        }
      }

      // 3) 状态栏行。正在看当前会话且窗口聚焦时，当前会话的报错视为已读（不再亮红）。
      //    已归档会话这里也一并过滤：任务栏与状态栏必须同一口径。
      const derive = () => deriveHubRows({
        list: listState,
        statuses,
        ackErrors: acks.getSnapshot(),
        localUnread: localUnread.getSnapshot(),
        drafts: drafts.getSnapshot(),
        archivedIds: readArchivedSessionIds(),
      })
      let rows = derive()
      if (currentSessionId !== undefined && focused) {
        const currentError = rows.find((row) => row.id === currentSessionId && row.state === 'error')
        if (currentError !== undefined) {
          if (stores.ackError(currentSessionId, currentError.errorSeq)) rows = derive()
        }
      }
      lastRows = rows

      // 4) 任务栏：红 > 黄 > 绿 > 无。
      host.pushTaskbar(aggregateTaskbarState(rows))

      // 5) 撤掉已经不需要再提醒的系统通知：
      //    - 窗口在前台且正在看这个会话 → 这条会话的通知都算已经看过；
      //    - 「需要你回应」的待交互已经消失 / 换成新 key → 旧催办过期。
      //    必须先撤旧再弹新：同一帧里 q1 → q2 时，不能让旧催办和新问题一起留在屏幕上。
      const dismissed = (focused && currentSessionId !== undefined ? notifySink.dismissSession(currentSessionId) : 0)
        + (statusKnown
          ? notifySink.dismissStaleAnswers((sessionId) => pendingInteractionKeyOf(statuses, sessionId))
          : 0)
      if (dismissed > 0) console.debug(`[${PLUGIN_ID}] 已撤回 ${dismissed} 条过期通知`)

      // 6) 弹通知。
      if (result.notes.length > 0) {
        console.debug(`[${PLUGIN_ID}]`, result.notes)
      }
      for (const notification of result.notifications) notifySink.show(notification)
    } catch (error) {
      // 状态栏/通知功能绝不应当影响 DSH 本身：任何异常都只记日志。
      console.error(`[${PLUGIN_ID}] 观察会话状态失败`, error)
    }
  }

  /** 合并一串推送，只做一次观察。 */
  const scheduleTick = () => {
    if (disposed || tickTimer !== null) return
    tickTimer = setTimeout(tick, TICK_COALESCE_MS)
  }

  /** 合并水位落盘。 */
  const schedulePersist = () => {
    if (disposed || persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      stores.watermarks.flush()
    }, PERSIST_COALESCE_MS)
  }

  /**
   * 权限为 default 时，等一次用户手势再请求（浏览器要求手势）。
   * 桌面版已经把通知权限放行，这里只是兜底。
   * @returns {() => void} 取消订阅。
   */
  const requestPermissionOnGesture = () => {
    if (typeof Notification === 'undefined' || typeof window === 'undefined') return () => {}
    if (Notification.permission !== 'default') return () => {}
    const ask = () => {
      quiesce()
      try {
        Promise.resolve(Notification.requestPermission()).catch(() => {})
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] 请求通知权限失败`, error)
      }
    }
    /** 撤掉等待手势的监听（拿到手势或插件卸载时都要撤）。 */
    const quiesce = () => {
      try {
        window.removeEventListener('pointerdown', ask, true)
        window.removeEventListener('keydown', ask, true)
      } catch {
        /* 忽略 */
      }
    }
    try {
      window.addEventListener('pointerdown', ask, true)
      window.addEventListener('keydown', ask, true)
    } catch {
      return () => {}
    }
    return quiesce
  }

  // ---- 接线：两个受支持的状态源，任何变化都合并成一次观察 ----
  const disposers = []
  try {
    const sessionsService = safeGet('sessions')
    if (sessionsService?.list?.subscribe !== undefined) {
      disposers.push(sessionsService.list.subscribe(scheduleTick))
    }
    const uiSession = safeGet('uiSession')
    if (uiSession?.sessionStatus?.subscribe !== undefined) {
      disposers.push(uiSession.sessionStatus.subscribe(scheduleTick))
    }
    // 归档集合变化也要重算：归档一个正在报错的会话之后，任务栏红灯必须随之熄灭
    // （状态栏那边由 React 的 useWorkspaces 自己重渲染，不依赖这次观察）。
    const archivedStore = workspacesSnapshotStore()
    if (archivedStore?.subscribe !== undefined) {
      disposers.push(archivedStore.subscribe(scheduleTick))
    }
  } catch (error) {
    console.error(`[${PLUGIN_ID}] 订阅会话状态失败`, error)
  }

  // ---- 窗口焦点：焦点/可见性变化也要触发一次观察 ----
  //
  // 「后台完成」的记账靠焦点状态判定，而焦点变化**不会**带来会话状态推送：用户切回窗口
  // 那一刻必须自己重新观察一次，否则绿点 / 绿灯会一直亮到下一次会话状态变化为止。
  const focusListeners = []
  const onWindowFocusChange = () => {
    scheduleTick()
    // 回到窗口 / 页面重新可见时补一次草稿扫描：隐藏期间轮询是停的。
    refreshDrafts()
  }
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('focus', onWindowFocusChange)
      window.addEventListener('blur', onWindowFocusChange)
      focusListeners.push({ target: window, type: 'focus' }, { target: window, type: 'blur' })
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onWindowFocusChange)
      focusListeners.push({ target: document, type: 'visibilitychange' })
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] 订阅窗口焦点失败`, error)
  }

  // ---- 草稿：输入事件即时扫、storage 事件跨标签页扫、2 秒轮询兜底 ----
  //
  // `ui-conversation` 把草稿写进 localStorage，但同页面写入不会触发 `storage` 事件；
  // 所以打字走 `input` / `compositionend`，另外两条路径负责「程序化写入」与其他窗口。
  // 轮询命中隐藏页面时直接跳过，避免后台空转。
  const draftListeners = []
  const onDraftInput = () => {
    if (disposed || draftInputTimer !== null) return
    draftInputTimer = setTimeout(() => {
      draftInputTimer = null
      refreshDrafts()
    }, DRAFT_INPUT_SCAN_MS)
  }
  const onDraftStorage = (event) => {
    const key = event?.key
    if (typeof key === 'string' && !key.startsWith(`${CONVERSATION_STORE_KEY}.`)) return
    refreshDrafts()
  }
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('input', onDraftInput, true)
      document.addEventListener('compositionend', onDraftInput, true)
      draftListeners.push(
        { target: document, type: 'input', handler: onDraftInput, capture: true },
        { target: document, type: 'compositionend', handler: onDraftInput, capture: true },
      )
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', onDraftStorage)
      draftListeners.push({ target: window, type: 'storage', handler: onDraftStorage })
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] 订阅草稿变化失败`, error)
  }

  let draftPollTimer = null
  try {
    if (typeof setInterval === 'function') {
      draftPollTimer = setInterval(() => {
        if (disposed) return
        try {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        } catch {
          /* 忽略：读不到可见性就照常扫描 */
        }
        refreshDrafts()
      }, DRAFT_POLL_MS)
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] 启动草稿轮询失败`, error)
  }

  // ---- 工作区顶部状态栏 / 顶栏变体 / 行悬停提示 ----
  registerHubSlots({
    ctx,
    pluginId: PLUGIN_ID,
    deps: {
      openSession,
      ackError,
      acks,
      localUnread,
      drafts,
      // 「状态会话」前面的前进 / 后退按钮：快照仓库 + 两个动作。
      history: navHistory,
      goBack: () => navigateHistory(-1),
      goForward: () => navigateHistory(1),
    },
  })

  /** 页面卸载时清掉任务栏状态点，避免红灯留在任务栏上。 */
  const onPageHide = () => {
    host.pushTaskbar('none', true)
  }
  try {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
  } catch {
    /* 页面环境异常时忽略 */
  }

  const cancelPermissionWait = requestPermissionOnGesture()

  ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 清理失败不应阻塞其他清理 */
      }
    }
    if (tickTimer !== null) clearTimeout(tickTimer)
    if (persistTimer !== null) clearTimeout(persistTimer)
    if (draftInputTimer !== null) clearTimeout(draftInputTimer)
    if (draftPollTimer !== null) clearInterval(draftPollTimer)
    tickTimer = null
    persistTimer = null
    draftInputTimer = null
    draftPollTimer = null
    stores.watermarks.flush()
    try {
      cancelPermissionWait()
    } catch {
      /* 忽略 */
    }
    for (const { target, type } of focusListeners.splice(0)) {
      try {
        target.removeEventListener?.(type, onWindowFocusChange)
      } catch {
        /* 忽略 */
      }
    }
    for (const { target, type, handler, capture } of draftListeners.splice(0)) {
      try {
        target.removeEventListener?.(type, handler, capture)
      } catch {
        /* 忽略 */
      }
    }
    try {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    } catch {
      /* 忽略 */
    }
    // 卸载时清掉任务栏状态点（此时 disposed 已置位，必须 force）。
    host.pushTaskbar('none', true)
    if (typeof globalThis !== 'undefined' && globalThis.__DSH_SESSION_HUB__ === diagnostics) {
      delete globalThis.__DSH_SESSION_HUB__
    }
  }, `${PLUGIN_ID}: observers`)

  // 首帧先做一次基线观察：已有的历史结局不会变成一串迟到的通知；
  // 同时把页面重开后仍然存在的草稿读进来，让「未开始」立即出现。
  refreshDrafts()
  scheduleTick()

  // ---- 诊断/测试入口 ----
  const diagnostics = {
    /** @returns {object} 当前生效配置。 */
    getConfig: () => ({ ...config }),
    /**
     * 合并写入配置（立即生效并落盘）。
     * @param {object} patch 部分配置。
     * @returns {object} 生效后的完整配置。
     */
    setConfig: (patch) => {
      stores.patchConfig(patch ?? {})
      scheduleTick()
      return { ...config }
    },
    /** @returns {object} 当前水位表（只读快照）。 */
    getWatermarks: () => JSON.parse(JSON.stringify(stores.watermarks.get())),
    /**
     * 有未发送草稿的会话（排障用）。
     *
     * 形状 `{ [sessionId]: { chars } }`：只有字符数，没有正文。想手动刷新可先改
     * `localStorage["dsh.conversation.<id>"]`，再调用 `__DSH_SESSION_HUB__.tick()`。
     * @returns {object} 草稿表快照。
     */
    getDrafts: () => ({ ...drafts.getSnapshot() }),
    /** @returns {Array<object>} 当前状态栏行。 */
    getRows: () => JSON.parse(JSON.stringify(lastRows)),
    /**
     * 会话导航历史快照（「状态会话」前面 ‹ › 两个按钮背后的账本）。
     *
     * 形状 `{ entries, index, canBack, canForward }`：`entries` 是访问过的会话 id，
     * `index` 是游标位置。用它可以直接验证「切了几个会话之后，后退能不能回到上一个」。
     * @returns {object} 历史快照。
     */
    getNavHistory: () => JSON.parse(JSON.stringify(navHistory.getSnapshot())),
    /**
     * 后退一个会话（与状态栏左端 ‹ 按钮同一条路径）。
     * @returns {boolean} 是否真的发起了跳转。
     */
    goBack: () => navigateHistory(-1),
    /**
     * 前进一个会话（与状态栏左端 › 按钮同一条路径）。
     * @returns {boolean} 是否真的发起了跳转。
     */
    goForward: () => navigateHistory(1),
    /** @returns {string} 当前聚合任务栏状态。 */
    getTaskbarState: () => aggregateTaskbarState(lastRows),
    /**
     * 「后台完成、尚未查看」的记账（排障用）。
     *
     * 形如 `{ [sessionId]: seq }`。窗口不在前台时完成的回合会记在这里，用来补官方
     * `completionUnread` 对主视图会话的空白；窗口回到前台并正在看该会话时自动清掉。
     * @returns {object} 记账快照。
     */
    getLocalUnread: () => ({ ...localUnread.getSnapshot() }),
    /**
     * 手动清掉「后台完成」记账（排障用）。
     * @param {string} [sessionId] 会话 id；不传表示全部清掉。
     * @returns {boolean} 是否真的发生了变化。
     */
    clearLocalUnread: (sessionId) => {
      const changed = stores.clearLocalUnread(sessionId)
      if (changed) scheduleTick()
      return changed
    },
    /** 立刻观察一次（不等合并窗口）。 */
    tick,
    /**
     * 手动设置任务栏状态（排障用；绕过去重）。
     * @param {string} state red | yellow | green | none。
     * @returns {string} 传入的状态。
     */
    setTaskbarState: (state) => {
      host.pushTaskbar(state, true)
      return state
    },
    /**
     * 弹一条测试通知，用来确认系统通知通路与点击跳转。
     * @param {string|undefined} sessionId 目标会话；缺省用当前打开的会话。
     * @returns {boolean} 是否真的弹了。
     */
    testNotification: (sessionId) => {
      const target = sessionId ?? currentSessionIdOf(safeGet('sessions')?.list?.getSnapshot?.() ?? {})
      if (target === undefined) {
        console.warn(`[${PLUGIN_ID}] 没有可用于测试的会话`)
        return false
      }
      notifySink.show({
        sessionId: target,
        dedupeKey: `test:${Date.now()}`,
        // 借用 `answer` 只是为了常驻（`requireInteraction`）；标识用铃铛而不是黄点，
        // 免得一条测试通知被看成「真的在等你回应」。
        category: 'answer',
        // 测试通知不登记为「可自动撤回」：它没有对应的待交互，也不该在窗口正看着
        // 当前会话时被下一次观察当成已读立刻撤掉。
        dismissible: false,
        marker: NOTIFY_MARKERS.test,
        title: 'DSH · 通知测试',
        body: '点击这条通知应当跳回对应会话',
      })
      return true
    },
    /** 受支持服务的存在性（排障用）。 */
    inspect: () => ({
      version: BUNDLE_VERSION,
      sessions: safeGet('sessions') !== undefined,
      uiSession: safeGet('uiSession') !== undefined,
      uiWorkspace: safeGet('uiWorkspace') !== undefined,
      permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      sessionsTracked: Object.keys(stores.watermarks.get()).length,
      statusRows: lastRows.length,
      taskbarState: aggregateTaskbarState(lastRows),
      /** 「后台完成、尚未查看」的会话数（补官方 completionUnread 的那部分）。 */
      localUnread: Object.keys(localUnread.getSnapshot()).length,
      /** 状态栏里正在以「未开始」显示的会话数（空白 / 子代理已由模型层过滤）。 */
      draftSessions: lastRows.filter((row) => row.state === 'draft').length,
      /** 已归档会话数（读不到归档集合时为 null：此时状态栏不做归档过滤）。 */
      archivedSessions: readArchivedSessionIds()?.length ?? null,
      /** 窗口此刻是否在前台（与通知静默、待查看记账同源）。 */
      focused: isFocused(config),
      desktopShell: isDesktopShell(),
      /** 宿主半在线状态（由 /ping 判定，与「有没有投影值」无关）。 */
      hostHalf: host.hostHalfState(),
    }),
    /**
     * 仍然挂在系统里、之后可以被自动撤回的通知（排障用）。
     * @returns {Array<object>} 见 hub-notify 的 `getLive`。
     */
    getLiveNotifications: () => notifySink.getLive(),
    /** @returns {Array<object>} 最近的通知落地结果（见 hub-notify 的 getLog）。 */
    getNotifyLog: () => notifySink.getLog(),
    /** 清空通知诊断日志（排障用）。 */
    clearNotifyLog: () => notifySink.clearLog(),
    /** 主动问一次宿主半在不在（返回 Promise，解析为最终状态）。 */
    pingHost: async () => {
      host.resetHostHalfCheck()
      host.checkHostHalf(true)
      const deadline = Date.now() + 3000
      while (host.hostHalfState() === 'checking') {
        if (Date.now() > deadline) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return host.hostHalfState()
    },
    /**
     * 手动请求宿主半前置窗口（排障用；与点击通知走完全相同的通路）。
     * @returns {boolean} 是否发起了请求。
     */
    raiseWindow: () => {
      host.callHostRoute('raise')
      return config.raiseWindow === true
    },
    /**
     * 手动跳转到某个会话（排障用）。
     * @param {string} sessionId 目标会话。
     * @returns {boolean} 会话是否在目录里。
     */
    openSession: (sessionId) => {
      const byId = safeGet('sessions')?.list?.getSnapshot?.()?.byId
      if (byId === undefined || !Object.hasOwn(byId, sessionId)) return false
      openSession(sessionId)
      return true
    },
    /**
     * 手动把左侧会话列表滚动到某个会话行（排障用，不跳转）。
     *
     * 返回值同时是一次「DOM 约定体检」：`session` 表示会话行命中；
     * `workspace` 表示会话行没渲染（分组折叠 / 被过滤），退化到了它所属的分组行；
     * `null` 表示两者都没找到。
     * @param {string} sessionId 目标会话。
     * @returns {'session'|'workspace'|null} 实际滚动到的行类型；没找到时为 null。
     */
    revealSessionRow: (sessionId) => {
      const workspaceService = safeGet('uiWorkspace')
      const workspaces = workspaceService?.workspaces?.list?.getSnapshot?.()
      const doc = typeof document === 'undefined' ? null : document
      return scrollSessionRowIntoView(doc, sessionId, { workspaces })
    },
    /**
     * 手动确认某个会话的全部报错（排障用）。
     * @param {string} sessionId 目标会话。
     * @returns {boolean} 是否确认了。
     */
    ackError: (sessionId) => {
      const row = lastRows.find((item) => item.id === sessionId && item.state === 'error')
      if (row === undefined) return false
      ackError(sessionId, row.errorSeq)
      return true
    },
  }
  try {
    globalThis.__DSH_SESSION_HUB__ = diagnostics
  } catch {
    /* 只读全局对象等极端环境下放弃暴露诊断入口 */
  }

  ctx.logger?.info?.(
    `[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION} 已启动：`
    + `完成=${config.onComplete} 失败=${config.onFailure} 需回应=${config.onAnswer}`,
  )
}
