/**
 * dsh-session-status-hub —— 「会话导航」的前进 / 后退历史（纯逻辑，零依赖，可在 Node 里单测）
 *
 * ## 为什么需要它
 *
 * DSH 的 Web / 桌面外壳**没有 URL 路由**：会话切换只是应用内状态（`uiWorkspace.openSession`），
 * 地址栏永远停在同一个 URL，浏览器自带的「后退 / 前进」完全帮不上忙。于是在侧栏点来点去之后，
 * 「刚才那个对话」只能靠侧栏一行行找回。这里用一份**会话访问历史**补上浏览器语义：
 *
 *   - 每打开一个会话 = 一次「访问」，压入历史并移动游标；
 *   - `back()` / `forward()` 沿游标前后移动，返回该跳去的会话 id；
 *   - 在历史中段打开一个新会话 = 截断前面（前进分支），与浏览器一致。
 *
 * ## 谁往里写：只有一个入口 `observe`
 *
 * 记录点刻意**不是**「点按钮时」，而是「观察到当前主视图会话变了」：
 * 侧栏点击、状态栏 chip、系统通知点击、宿主快捷键……所有跳转最终都会让
 * `sessions.list` 快照里 `retainedBy.mainView` 换一行，客户端半在每次观察里把当前会话
 * 交给 {@link createNavHistory} 的 `observe`。这样无论用户从哪条路切过去都会进历史，
 * 而插件自己不需要在每个跳转分支里各写一次记录。
 *
 * ## 前进 / 后退自身的反馈回路
 *
 * `back()` 已经移动了游标，真正的跳转却是异步的：`openSession` 之后至少还有一帧，
 * 列表快照才变成目标会话——在那之前的下一次观察里，**当前会话仍是「刚离开的那个」**。
 * 若把它当成一次新访问，刚刚保留的前进分支就会被自己截断。所以 `back()` / `forward()`
 * 会留下一条 {@link PendingHop}：
 *
 *   - 观察到 `target`（跳转落地）→ 清掉 pending，历史不变（游标早就位了）；
 *   - 观察到 `stale`（跳转前的旧快照）→ 忽略；
 *   - 观察到别的会话 → 说明用户在这期间自己去了别处，按正常新访问记录。
 *
 * @module dsh-session-status-hub/hub-history
 */

/**
 * 历史最多保留多少个会话。
 *
 * 这是「最近去过的对话」，不是审计日志：50 条足够覆盖一个人一天在侧栏里的来回切换，
 * 又不会让内存与快照无限长大（超出后从最旧的一端丢弃，与浏览器 history 同向）。
 */
export const MAX_NAV_ENTRIES = 50

/**
 * 前进 / 后退之后等待落地的跳转。
 *
 * @typedef {object} PendingHop
 * @property {string} target 期望观察到的会话（跳转目标）。
 * @property {string} stale 跳转前正在看的会话（落地前会再次被观察到的旧值）。
 */

/**
 * 创建一个会话导航历史。
 *
 * 返回的对象同时是一个**快照仓库**（`subscribe` / `getSnapshot`），可以直接喂给
 * React 的 `useSyncExternalStore`：按钮的可用状态随历史变化重渲染。
 *
 * 快照形状：`{ entries: string[], index: number, canBack: boolean, canForward: boolean }`
 * ——`entries` 是只读副本，`index === -1` 表示「还没有访问记录」。
 *
 * @param {{ limit?: number }} [options] 选项。
 * @param {number} [options.limit] 最多保留多少条（默认 {@link MAX_NAV_ENTRIES}）。
 * @returns {{
 *   subscribe: (listener: () => void) => () => void,
 *   getSnapshot: () => { entries: readonly string[], index: number, canBack: boolean, canForward: boolean },
 *   observe: (sessionId: string|undefined) => boolean,
 *   peek: (delta: number) => string|null,
 *   back: () => string|null,
 *   forward: () => string|null,
 *   clear: () => void,
 * }} 历史仓库。
 */
export function createNavHistory({ limit = MAX_NAV_ENTRIES } = {}) {
  const max = Number.isFinite(limit) && limit > 1 ? Math.floor(limit) : MAX_NAV_ENTRIES
  /** 访问过的会话 id，按访问顺序。 */
  let entries = []
  /** 游标：当前停在 `entries[index]`；`-1` 表示还没有任何访问。 */
  let index = -1
  /** @type {PendingHop|null} 等待落地的跳转（见模块注释）。 */
  let pending = null
  const listeners = new Set()
  let snapshot = freezeSnapshot(entries, index)

  /**
   * 生成一份不可变快照（React 靠引用比较判断变化）。
   * @param {string[]} ids 会话 id 列表。
   * @param {number} cursor 游标。
   * @returns {{ entries: readonly string[], index: number, canBack: boolean, canForward: boolean }} 快照。
   */
  function freezeSnapshot(ids, cursor) {
    return Object.freeze({
      entries: Object.freeze(ids.slice()),
      index: cursor,
      canBack: cursor > 0,
      canForward: cursor >= 0 && cursor < ids.length - 1,
    })
  }

  /** 发布新快照并通知订阅者；快照没变化时不打扰任何人。 */
  function publish() {
    const next = freezeSnapshot(entries, index)
    const unchanged = next.index === snapshot.index
      && next.entries.length === snapshot.entries.length
      && next.entries.every((id, position) => id === snapshot.entries[position])
    if (unchanged) return
    snapshot = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.warn('[dsh-session-status-hub] 会话导航订阅者抛错', error)
      }
    }
  }

  /**
   * 记录一次访问（当前主视图会话变了时调用，幂等）。
   *
   * @param {string|undefined} sessionId 当前主视图会话 id；空值直接忽略。
   * @returns {boolean} 历史是否发生了变化。
   */
  function observe(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false

    if (pending !== null) {
      // 跳转落地：游标在 back()/forward() 里已经移动过，这里不再记一次访问。
      if (sessionId === pending.target) {
        pending = null
        return false
      }
      // 跳转前的旧快照：等目标落地，别把它当成新访问（否则前进分支被截断）。
      if (sessionId === pending.stale) return false
      // 用户中途自己去了别处：按一次真实的新访问处理。
      pending = null
    }

    if (index >= 0 && entries[index] === sessionId) return false

    // 新访问：丢弃游标之后的前进分支，再压入；超出上限时从最旧的一端丢弃。
    const next = entries.slice(0, index + 1)
    next.push(sessionId)
    while (next.length > max) next.shift()
    entries = next
    index = entries.length - 1
    publish()
    return true
  }

  /**
   * 看一眼「前进 / 后退一步会去哪」而不移动游标。
   *
   * 调用方用它在真正跳转之前校验目标会话是否还在目录里：目标已被删除时直接放弃这次跳转，
   * 游标不会白白移动。
   *
   * @param {number} delta `-1` 后退、`1` 前进。
   * @returns {string|null} 目标会话 id；没有可去的地方时为 null。
   */
  function peek(delta) {
    if (!Number.isInteger(delta) || delta === 0) return null
    const next = index + delta
    if (next < 0 || next >= entries.length) return null
    return entries[next]
  }

  /**
   * 沿历史走一步：移动游标、留下 pending，返回目标会话。
   * @param {number} delta `-1` 后退、`1` 前进。
   * @returns {string|null} 目标会话 id；没有可去的地方时为 null。
   */
  function step(delta) {
    const target = peek(delta)
    if (target === null) return null
    // 落地前那次观察会看到「跳转前的会话」，记为 stale 忽略掉。
    pending = { target, stale: entries[index] }
    index += delta
    publish()
    return target
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    observe,
    peek,
    back: () => step(-1),
    forward: () => step(1),
    /** 清空历史（插件卸载 / 排障用；游标回到「还没有访问」）。 */
    clear() {
      pending = null
      if (entries.length === 0 && index === -1) return
      entries = []
      index = -1
      publish()
    },
  }
}
