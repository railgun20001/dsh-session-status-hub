/**
 * dsh-session-status-hub —— 界面文案的**单一来源**
 *
 * 状态栏、会话行悬停提示、以及注册到宿主 locale 服务的字典，都必须从这里取。
 * 之前同一个字符串存在三处（locale 注册一份、两个组件的 FALLBACK 各一份），加一条文案
 * 要改三个地方，漏一处就会在界面上直接显示出 key 名（例如 `state.unread`）。
 *
 * 只放「可见文案」：状态的内部取值（`error` / `answer` / `running` / `unread` / `draft`）
 * 与颜色优先级属于模型层（见 hub-model.js 的 STATE_ORDER），不要混进来。
 *
 * 键的命名约定：
 *   - `label` / `idle` / `aria` / `more` / `collapse`：状态栏容器自身（「状态会话」组）
 *   - `recent.*`：「最近会话」组（组标题、无障碍标签）
 *   - `group.expand` / `group.collapse`：组标题开关的悬停提示与无障碍名称（`{label}` 是组名）
 *   - `blank.title`：空白「新会话」占位行在状态栏里的标题
 *   - `state.<state>`：状态短标签，`<state>` 必须与 hub-model 的 STATE_ORDER 键一致
 *   - `row.<kind>`：会话行悬停卡片里的失败提示，`<kind>` 与 failureKindOf 的返回值一致
 *
 * @module dsh-session-status-hub/hub-strings
 */

/**
 * 两种语言的完整文案表。
 *
 * `zh` 同时充当「locale 服务不可用」时的回落（见 hub-ui.js 的 createFallbackT）：
 * 回落不是另一套文案，就是中文这一份，避免两份内容各自漂移。
 *
 * @type {Readonly<Record<'zh'|'en', Readonly<Record<string, string>>>>}
 */
export const HUB_STRINGS = Object.freeze({
  zh: Object.freeze({
    label: '状态会话',
    idle: '全部空闲',
    'recent.label': '最近会话',
    'recent.aria': '最近会话：{count} 个',
    'group.expand': '展开{label}',
    'group.collapse': '收起{label}',
    'blank.title': '新会话',
    aria: '状态会话：{count} 个需要关注',
    more: '还有 {count} 个状态会话',
    collapse: '收起',
    'state.answer': '等待回答',
    'state.draft': '未开始',
    'state.error': '报错',
    'state.running': '运行中',
    'state.unread': '待查看',
    'row.failed': '本轮失败',
    'row.interrupted': '本轮中断',
    'row.hint': '该会话最后一轮没有正常结束',
  }),
  en: Object.freeze({
    label: 'Status Sessions',
    idle: 'All idle',
    'recent.label': 'Recent Sessions',
    'recent.aria': 'Recent Sessions: {count}',
    'group.expand': 'Expand {label}',
    'group.collapse': 'Collapse {label}',
    'blank.title': 'New Session',
    aria: 'Status Sessions: {count} need attention',
    more: '{count} more Status Sessions',
    collapse: 'Collapse',
    'state.answer': 'Waiting',
    'state.draft': 'Not started',
    'state.error': 'Failed',
    'state.running': 'Running',
    'state.unread': 'Unread',
    'row.failed': 'Last turn failed',
    'row.interrupted': 'Last turn interrupted',
    'row.hint': 'The last turn of this Session did not finish normally',
  }),
})
