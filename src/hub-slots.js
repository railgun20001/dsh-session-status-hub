/**
 * dsh-session-status-hub —— 客户端半的插槽注册（状态栏 / 顶栏变体 / 行悬停提示）
 *
 * 三处注册，位置与取舍见 README 第 2 节：
 *
 * | 插槽 | 变体 | 位置 | 何时可见 |
 * |---|---|---|---|
 * | `conversation.header.leading` | `header` | 会话标题之前、工作区内容之上 | 非 Windows 顶栏环境 |
 * | `shell.overlay` | `chrome` | 软件顶端标题栏、「应用 / 编辑」菜单之后 | 桌面端（`data-windows-titlebar`） |
 * | `sidebar.session.row.hover` | — | 会话行悬停卡片内容位 | 该行最后一轮失败/中断且未确认 |
 * | `plugins.bundle.config` | — | 插件管理 → 本插件详情页的设置区块 | 打开本插件的详情页时 |
 *
 * 两个状态栏变体都注册，由 CSS 按 `html[data-windows-titlebar]` 二选一显示：这样不用去
 * 猜宿主此刻是什么外壳，也不需要监听外壳类型变化。
 *
 * 注册全部是「尽力而为」：拿不到 React、拿不到 slots 或 locale 服务、注册抛错，都只记日志。
 * 通知与任务栏走的是另一条通路，不依赖渲染。
 *
 * @module dsh-session-status-hub/hub-slots
 */

/**
 * 注册全部插槽。
 *
 * @param {object} options 依赖注入。
 * @param {object} options.ctx 客户端 Cordis 上下文（需要 `ctx.inject` / `ctx.logger`）。
 * @param {string} options.pluginId 插件 id（locale 命名空间与日志标签）。
 * @param {{
 *   openSession: (sessionId: string, options?: { raise?: boolean }) => void,
 *   ackError: (sessionId: string, seq: number|null) => void,
 *   acks: object,
 *   localUnread: object,
 *   drafts: object,
 *   jobs?: object,
 *   history?: object,
 *   goBack?: () => boolean,
 *   goForward?: () => boolean,
 *   settings?: object,
 *   setShowRecentSessions?: (visible: boolean) => void,
 * }} options.deps 组件要用的动作与状态仓库。
 * @returns {void}
 */
export function registerHubSlots({ ctx, pluginId, deps }) {
  try {
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['slots', 'locale'], (scoped) => {
      try {
        // 可见文案走 Client locale 服务（字典本身来自 hub-strings 的单一来源）；
        // 没有该服务时组件内部用同一份中文回落。
        try {
          scoped.effect(
            () => scoped.locale.register(pluginId, HUB_STRINGS),
            `${pluginId}: locale`,
          )
        } catch (error) {
          console.warn(`[${pluginId}] 注册状态栏文案失败`, error)
        }

        const React = typeof require === 'function' ? require('react') : null
        if (React === null || typeof React.createElement !== 'function') {
          console.warn(`[${pluginId}] 拿不到 React，状态栏不渲染（通知与任务栏不受影响）`)
          return
        }

        // 状态栏组件的依赖**整份透传**，不再逐项挑字段。
        //
        // 曾经这里是白名单（`{ openSession, ackError, acks, unread, drafts, history, … }`），
        // 好处是契约一眼可见，坏处是**新增一个依赖忘了登记就会静默退化**：0.5.x 给组件加了
        // `deps.jobs`（后台任务青点），白名单没跟上，组件拿到的 `jobs` 恒为 undefined，
        // 于是宿主半聚合、客户端轮询、解析全都正常，界面上却永远不出现青点——而且不报错。
        // 组件的每个依赖本身都有缺省回落（见 hub-ui 的 EMPTY_*_STORE），所以漏传不会崩，
        // 只会安静地少一块功能，正是最难查的那种。
        // 透传之后，新增依赖只需要在 client-main 里接一次，不存在第二处登记点。
        //
        // 唯一的改名仍要留着：组件读的是 `deps.unread`（状态栏内部的短名），而
        // client-main 注入的是 `localUnread`（与 hub-stores 里的仓库同名，语义更准）。
        const railDeps = { ...deps, unread: deps.localUnread }
        const RailHeader = createSessionHubRail(React, railDeps, 'header')
        const RailChrome = createSessionHubRail(React, railDeps, 'chrome')
        scoped.slots.inject('conversation.header.leading', () => scoped.slots.register({
          name: 'conversation.header.leading',
          locale: pluginId,
        }, RailHeader))
        // Windows 顶栏：菜单后、窗口控件前的 frame-wide 浮动层；Web 端由 CSS 隐藏。
        scoped.slots.inject('shell.overlay', () => scoped.slots.register({
          name: 'shell.overlay',
          id: 'session-hub-chrome',
          order: 5,
          locale: pluginId,
        }, RailChrome))
        // 会话行悬停卡片：补一行「本轮失败/中断」，解释官方行首那个绿色「已完成」点
        // 为什么会出现在失败会话上（官方行状态机没有失败态，插件改不了行首点）。
        const RowHint = createSessionHubRowHint(React, { acks: deps.acks })
        scoped.slots.inject('sidebar.session.row.hover', () => scoped.slots.register({
          name: 'sidebar.session.row.hover',
          id: 'session-hub-failure',
          order: 10,
          locale: pluginId,
        }, RowHint))
        ctx.logger?.info?.(
          `[${pluginId}] 状态栏已注册到 conversation.header.leading + shell.overlay + sidebar.session.row.hover`,
        )

        // 插件详情页里的设置区块：keyed 插槽，key = 包名（与插件 id 同一个字符串）。
        // 拿不到它时只记日志——设置入口消失是小事，绝不能让状态栏跟着挂掉。
        const SettingsPanel = createHubSettingsPanel(React, {
          settings: deps.settings,
          setShowRecentSessions: deps.setShowRecentSessions,
        })
        scoped.slots.inject('plugins.bundle.config', () => {
          try {
            return scoped.slots.register({
              name: 'plugins.bundle.config',
              key: pluginId,
              locale: pluginId,
            }, SettingsPanel)
          } catch (error) {
            console.warn(`[${pluginId}] 插件详情页设置区块注册失败（已忽略）`, error)
            return () => {}
          }
        })
        ctx.logger?.info?.(`[${pluginId}] 插件详情页设置区块已注册到 plugins.bundle.config`)
      } catch (error) {
        console.warn(`[${pluginId}] 注册状态栏失败`, error)
      }
    })
  } catch (error) {
    console.warn(`[${pluginId}] 注入 slots 服务失败`, error)
  }
}
