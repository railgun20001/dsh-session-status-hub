/**
 * dsh-session-status-hub —— 工作区顶部会话状态栏（React 组件工厂，纯浏览器代码）
 *
 * 这个文件是 bundle 里的裸脚本片段：`createSessionHubRail(React, deps)` 返回一个
 * 函数组件，由 client-main 注册进 `conversation.header.leading` 官方插槽。
 *
 * ## 为什么放在 header.leading
 *
 * `conversation.header.leading` 是官方声明的单占位插槽（`replaceRisk: none`），
 * 位于会话标题之前、工作区内容之上，并且在「没有选中会话」时也会渲染。它天然就是
 * 「工作区上方」的位置，又不需要替换任何 shipped UI。
 *
 * ## 数据来源
 *
 * 组件只读插槽的标准 props：`useSessions`、`useSessionStatus`、`useWorkspaces` 与绑定后的 `t`。
 * 三者都是订阅式快照钩子，会话状态 / 归档集合一变就重渲染；组件自己不订阅事件、不扫描 DOM。
 * `useWorkspaces` 只用来取 `archivedSessionIds`——会话列表行里没有「已归档」字段，
 * 归档集合只存在于工作区注册表的全局集合里，而归档的会话不该继续显示在状态栏。
 *
 * 视觉全部使用 `--dsw-alias-*` 主题令牌；颜色只用于状态点，语义与原生侧栏一致。
 * 可见文案一律来自 {@link HUB_STRINGS}（hub-strings.js）——组件里不再存第二份副本，
 * locale 服务不可用时直接用其中的 `zh` 回落。
 *
 * ## 两组条目
 *
 * 状态栏一行里并排两组（中间用一条竖直分隔线断开）：
 *
 *   - **状态会话**（`t('label')`）：当下需要你处理 / 正在跑的会话，默认显示 3 条 + `+N`；
 *   - **最近会话**（`t('recent.label')`）：状态组里没有的会话按更新时间取最近 5 个，
 *     作为「刚才那个会话」的回头入口；同一次渲染里两组不会出现同一个会话。
 *
 * 第二组条目不参与第一组的折叠：它的上限（`MAX_RECENT_ROWS`）在模型层就兜住了。
 *
 * @module dsh-session-status-hub/hub-ui
 */

/**
 * 极简文案函数工厂：只在 locale 服务缺失时使用。
 *
 * @param {object} dict 键 → 文案。
 * @returns {(key: string, params?: object) => string} 文案函数。
 */
function createFallbackT(dict) {
  return (key, params) => {
    const text = dict[key] ?? key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match))
  }
}

/**
 * 创建状态栏组件。
 * @param {object} React React 运行时（由客户端模块表提供）。
 * @param {{
 *   openSession: (sessionId: string, options?: { raise?: boolean }) => void,
 *   ackError: (sessionId: string, seq: number|null) => void,
 *   acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
 *   unread?: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
 *   drafts?: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object },
 * }} deps 由 client-main 注入的动作、确认表、「后台完成」记账与草稿表（后两者可选）。
 * @param {'header'|'chrome'} [variant] 渲染位置：会话标题前，或 Windows 顶栏菜单之后。
 * @returns {Function} React 函数组件。
 */
function createSessionHubRail(React, deps, variant = 'header') {
  const h = React.createElement
  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
  const EMPTY_STATUSES = new Map()
  const EMPTY_UNREAD = {}
  const EMPTY_DRAFTS = {}
  /** 归档集合的缺省值：没有 `useWorkspaces` 时不做归档过滤（组件照常渲染）。 */
  const EMPTY_ARCHIVED = Object.freeze([])
  /** 「后台完成」记账的缺省仓库：没有注入时组件照常渲染，只是没有补记的绿点。 */
  const EMPTY_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_UNREAD }
  /** 草稿表的缺省仓库：没有注入时组件照常渲染，只是没有「未开始」灰点。 */
  const EMPTY_DRAFT_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_DRAFTS }

  /** 文案回落：插槽没有绑定 locale 时也能显示中文。 */
  const fallbackT = createFallbackT(HUB_STRINGS.zh)

  /** 没有插槽钩子时的安全回落（只会在测试或异常组合里用到）。 */
  const useEmptySessions = () => EMPTY_LIST
  const useEmptyStatuses = () => EMPTY_STATUSES
  const useEmptyWorkspaces = () => EMPTY_ARCHIVED

  /**
   * 订阅一个快照仓库；React 18+ 用 useSyncExternalStore，旧版本退化为强制刷新。
   * @param {object} store 快照仓库。
   * @returns {object} 当前快照。
   */
  function useSnapshot(store) {
    if (typeof React.useSyncExternalStore === 'function') {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }
    const [, force] = React.useState(0)
    React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
    return store.getSnapshot()
  }

  const CSS = [
    '.dsh-hub{display:flex;align-items:center;gap:6px;min-width:0;max-width:min(46vw,700px);overflow-x:auto;overflow-y:hidden;padding:2px 4px 2px 0;scrollbar-width:none;font:inherit}',
    '.dsh-hub::-webkit-scrollbar{display:none}',
    '.dsh-hub__label{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin-right:2px;user-select:none;white-space:nowrap}',
    '.dsh-hub__idle{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;white-space:nowrap}',
    '.dsh-hub__chip{flex:none;display:inline-flex;align-items:center;gap:6px;max-width:190px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
    '.dsh-hub__chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
    '.dsh-hub__chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.dsh-hub__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
    '.dsh-hub__chip--answer .dsh-hub__dot{background:var(--dsw-alias-state-warn-primary)}',
    '.dsh-hub__chip--error .dsh-hub__dot{background:var(--dsw-alias-state-error-primary)}',
    '.dsh-hub__chip--running .dsh-hub__dot{background:var(--dsw-static-blue-400,#60a5fa);animation:dsh-hub-pulse 1.4s ease-in-out infinite}',
    '.dsh-hub__chip--unread .dsh-hub__dot{background:var(--dsw-alias-state-success-primary)}',
    // 「未开始」用主题里的三级文字灰：比空闲点更清楚，又比红 / 黄 / 绿低调。
    '.dsh-hub__chip--draft .dsh-hub__dot{background:var(--dsw-alias-label-tertiary)}',
    '.dsh-hub__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-hub__state{flex:none;font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary)}',
    '.dsh-hub__more{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}',
    '.dsh-hub__more:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
    '.dsh-hub__more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    // 两组条目（状态会话 / 最近会话）：组内间距继承外层 gap（header 6px、chrome 4px），
    // 组本身不允许被压缩，否则窄窗口下两组会互相挤成省略号。
    '.dsh-hub__group{display:inline-flex;align-items:center;gap:inherit;flex:none;min-width:0}',
    // 两组之间一条竖直分隔线：两串 chip 直接相连时，读不出哪几条是需要处理的、哪几条是最近去过。
    '.dsh-hub__group--recent{border-left:1px solid var(--dsw-alias-border-l1);padding-left:8px}',
    // Windows 顶栏变体：fixed 在「应用 / 编辑」菜单之后，高度跟随原生顶栏（40px）。
    // --dsh-windows-menu-start 由侧栏发布（展开 48px / 收起 84px）；菜单本体约 100px。
    '.dsh-hub--chrome{position:fixed;top:0;left:calc(var(--dsh-windows-menu-start,48px) + 108px);height:var(--dsh-windows-titlebar-height,40px);max-width:calc(100vw - 460px);padding:0 8px 0 0;gap:4px;z-index:1090;pointer-events:auto;-webkit-app-region:no-drag}',
    '.dsh-hub--chrome .dsh-hub__chip,.dsh-hub--chrome .dsh-hub__idle,.dsh-hub--chrome .dsh-hub__more{height:24px;padding:0 8px;font-size:11px;background:var(--dsw-specific-sidebar-fill)}',
    '.dsh-hub--chrome .dsh-hub__chip{max-width:180px}',
    '.dsh-hub--chrome .dsh-hub__label{font-size:11px}',
    '.dsh-hub--chrome .dsh-hub__state{font-size:9px}',
    // 「最近会话」chip：没有状态点，只用次级文字色，视觉上明显弱于状态会话组——
    // 它是回头入口，不是「需要你处理」的提示。
    '.dsh-hub .dsh-hub__chip--recent{max-width:150px;color:var(--dsw-alias-label-secondary)}',
    '.dsh-hub .dsh-hub__chip--recent:hover{color:var(--dsw-alias-label-primary)}',
    'html:not([data-windows-titlebar]) .dsh-hub--chrome{display:none}',
    'html[data-windows-titlebar] .dsh-hub--header{display:none}',
    '@keyframes dsh-hub-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.dsh-hub__chip--running .dsh-hub__dot{animation:none}}',
  ].join('')

  return function SessionHubRail(props) {
    const t = typeof props?.t === 'function' ? props.t : fallbackT
    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
    const useSessionStatus = typeof props?.useSessionStatus === 'function' ? props.useSessionStatus : useEmptyStatuses
    const list = useSessions((value) => value)
    const statuses = useSessionStatus((value) => value)
    // 归档集合来自工作区注册表的根级 hook（`useWorkspaces` 的 `archivedSessionIds`）：
    // 会话列表行里没有「已归档」字段，归档只存在于这份全局集合里。选择器只挑出这个数组，
    // 快照的其他字段变化（工作区标题、顺序等）不会引来重渲染。
    const useWorkspaces = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : useEmptyWorkspaces
    const archivedIds = useWorkspaces((value) => (
      Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : EMPTY_ARCHIVED
    ))
    const ackErrors = useSnapshot(deps.acks)
    // 官方的 completionUnread 对主视图会话永不置位；「窗口在后台时跑完」的绿点来自
    // 本插件的补记（client-main 的 localUnread），这里必须一起喂给模型。
    const localUnread = useSnapshot(deps.unread ?? EMPTY_STORE)
    // 草稿表只带 `{ chars }`（不含正文）；没有注入时退化为空表。
    const drafts = useSnapshot(deps.drafts ?? EMPTY_DRAFT_STORE)
    const rows = deriveHubRows({
      list,
      statuses,
      ackErrors,
      localUnread,
      drafts,
      blankTitle: t('blank.title'),
      archivedIds,
      now: Date.now(),
    })
    // 「最近会话」：状态组里没有的会话按更新时间取最近几个（默认 5），作为回头入口。
    // 判据与排序都在模型层（deriveRecentRows），这里只负责渲染。
    const recentRows = deriveRecentRows({
      list,
      statusRows: rows,
      blankTitle: t('blank.title'),
      archivedIds,
    })
    const [expanded, setExpanded] = React.useState(false)
    const visibleRows = expanded ? rows : rows.slice(0, 3)
    const hiddenCount = rows.length - visibleRows.length

    const children = [h('style', { key: 'style' }, CSS)]

    // ---- 第一组：状态会话（需要你处理 / 正在跑的会话 + 未发送草稿）----
    const statusChildren = [h('span', { key: 'label', className: 'dsh-hub__label' }, t('label'))]
    if (rows.length === 0) {
      statusChildren.push(h('span', { key: 'idle', className: 'dsh-hub__idle' }, t('idle')))
    } else {
      for (const row of visibleRows) {
        const stateLabel = t(`state.${row.state}`)
        statusChildren.push(h('button', {
          key: row.id,
          type: 'button',
          className: `dsh-hub__chip dsh-hub__chip--${row.state}`,
          title: `${stateLabel}：${row.title}`,
          'aria-label': `${stateLabel}：${row.title}`,
          onClick: () => {
            try {
              deps.ackError(row.id, row.errorSeq)
            } catch (error) {
              console.warn('[dsh-session-status-hub] 确认报错失败', error)
            }
            // 点击 chip 时窗口本来就在前台：只做应用内跳转，不请求窗口前置，
            // 避免触发 Win32 的窗口状态处理（最大化被 SW_RESTORE 打回普通尺寸）。
            deps.openSession(row.id, { raise: false })
          },
        },
        h('span', { className: 'dsh-hub__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-hub__title' }, row.title),
        h('span', { className: 'dsh-hub__state' }, stateLabel)))
      }
      if (hiddenCount > 0) {
        statusChildren.push(h('button', {
          key: 'more',
          type: 'button',
          className: 'dsh-hub__more',
          title: t('more', { count: hiddenCount }),
          'aria-label': t('more', { count: hiddenCount }),
          onClick: () => setExpanded(true),
        }, `+${hiddenCount}`))
      } else if (expanded && rows.length > 3) {
        statusChildren.push(h('button', {
          key: 'collapse',
          type: 'button',
          className: 'dsh-hub__more',
          onClick: () => setExpanded(false),
        }, t('collapse')))
      }
    }
    children.push(h('span', { key: 'status', className: 'dsh-hub__group dsh-hub__group--status' }, statusChildren))

    // ---- 第二组：最近会话（刚读完 / 刚确认 / 刚跑完的会话回头入口，最多 5 个）----
    // 这一组不参与第一组的「3 条折叠」：上限本身就由模型层的 MAX_RECENT_ROWS 兜住，
    // 再折一次只会让「最近」变成「还得点一下才能看到」。
    if (recentRows.length > 0) {
      const recentChildren = [
        h('span', { key: 'label', className: 'dsh-hub__label' }, t('recent.label')),
      ]
      for (const row of recentRows) {
        recentChildren.push(h('button', {
          key: row.id,
          type: 'button',
          className: 'dsh-hub__chip dsh-hub__chip--recent',
          title: `${t('recent.label')}：${row.title}`,
          'aria-label': `${t('recent.label')}：${row.title}`,
          // 最近会话没有状态可确认，只需跳转。
          onClick: () => deps.openSession(row.id, { raise: false }),
        },
        h('span', { className: 'dsh-hub__title' }, row.title)))
      }
      children.push(h('span', {
        key: 'recent',
        className: 'dsh-hub__group dsh-hub__group--recent',
        role: 'group',
        'aria-label': t('recent.aria', { count: recentRows.length }),
      }, recentChildren))
    }

    return h('div', {
      className: `dsh-hub dsh-hub--${variant}`,
      'data-dsh-session-status-hub': variant,
      role: 'group',
      'aria-label': rows.length === 0 ? t('idle') : t('aria', { count: rows.length }),
    }, children)
  }
}

/**
 * 创建「会话行悬停卡片里的失败提示」组件。
 *
 * ## 为什么需要它
 *
 * 侧栏会话行首那个圆点由官方 ui-workspace / ui-session 决定，只有四种：
 * 等待交互（黄）、运行中（蓝）、未读完成（绿）、空闲（不画）。它**没有「失败」态**，
 * 而 ui-session 在「running → 停止」时一律把会话记成 `completionUnread`，于是
 * **一轮因报错/中断结束的会话，行首也会显示成绿色的「已完成」**。
 *
 * 插件不能改写官方行状态机（`sidebar.session.row.leading` 只在空闲时才轮到插件渲染），
 * 所以这里用我们能控制的最近一个位置把真相补上：`sidebar.session.row.hover` 是行悬停
 * 卡片的内容位（list 插槽），在这里加一行红色提示，鼠标停在行上就能看到
 * 「本轮失败 / 本轮中断」，不会与官方绿点打架，也不去碰别人的 DOM。
 *
 * ## 数据来源
 *
 * 只读插槽标准 props：`useSessions`（会话列表快照）与 `t`；再加本插件自己的
 * 「已确认报错」表（`deps.acks`）。判据与状态栏完全一致（`failureKindOf`）。
 *
 * @param {object} React React 运行时。
 * @param {{ acks: { subscribe: (listener: () => void) => () => void, getSnapshot: () => object } }} deps
 *   本插件的确认表。
 * @returns {Function} React 函数组件。
 */
function createSessionHubRowHint(React, deps) {
  const h = React.createElement
  const EMPTY_LIST = { byId: {}, projectionsBySession: {} }
  const useEmptySessions = () => EMPTY_LIST
  const fallbackT = createFallbackT(HUB_STRINGS.zh)

  /**
   * 订阅「已确认报错」表。
   * @param {object} store 快照仓库。
   * @returns {object} 当前确认表。
   */
  function useAcks(store) {
    if (typeof React.useSyncExternalStore === 'function') {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }
    const [, force] = React.useState(0)
    React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
    return store.getSnapshot()
  }

  const CSS = [
    '.dsh-hub-hint{display:flex;align-items:center;gap:6px;min-width:0;font:inherit;font-size:12px;line-height:1.3;color:var(--dsw-alias-label-primary)}',
    '.dsh-hub-hint__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
    '.dsh-hub-hint__text{flex:none}',
    '.dsh-hub-hint__detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  ].join('')

  return function SessionHubRowHint(props) {
    const t = typeof props?.t === 'function' ? props.t : fallbackT
    const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useEmptySessions
    const list = useSessions((value) => value)
    const ackErrors = useAcks(deps.acks)
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
    if (sessionId === undefined) return null

    const projection = projectionOf(list, sessionId)
    const acked = Number.isInteger(ackErrors[sessionId]) ? ackErrors[sessionId] : -1
    const kind = failureKindOf(projection, acked)
    if (kind === null) return null

    const label = t(kind === 'interrupted' ? 'row.interrupted' : 'row.failed')
    const detail = typeof projection?.code === 'string' && projection.code !== '' ? projection.code : ''

    return h('div', {
      className: 'dsh-hub-hint',
      'data-dsh-session-status-hub-hint': kind,
      title: t('row.hint'),
      role: 'status',
    }, [
      h('style', { key: 'style' }, CSS),
      h('span', { key: 'dot', className: 'dsh-hub-hint__dot', 'aria-hidden': 'true' }),
      h('span', { key: 'text', className: 'dsh-hub-hint__text' }, label),
      detail === '' ? null : h('span', { key: 'detail', className: 'dsh-hub-hint__detail' }, detail),
    ])
  }
}
