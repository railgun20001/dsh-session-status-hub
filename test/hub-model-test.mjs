/**
 * 状态栏 / 任务栏纯逻辑单测。
 *
 * 运行：node --test test/hub-model-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateTaskbarState,
  currentSessionIdOf,
  deriveHubRows,
  deriveRecentRows,
  failureKindOf,
  hasDraftContent,
  hasLocalUnread,
  isArchivedSession,
  isUnackedFailure,
  MAX_RECENT_ROWS,
  normalizeAckErrors,
  normalizeLocalUnread,
  projectionOf,
  STATE_ORDER,
} from '../src/hub-model.js'

/**
 * 造一个会话行。
 * @param {string} id 会话 id。
 * @param {object} [patch] 覆盖字段。
 * @returns {object} 会话行。
 */
function row(id, patch = {}) {
  return { id, displayTitle: `会话 ${id}`, running: false, blank: false, updatedAt: 1, ...patch }
}

/**
 * 造一个回合结局投影。
 * @param {number} seq 事件序号。
 * @param {string} outcome 结局。
 * @returns {object} 投影值。
 */
function outcome(seq, outcomeKind) {
  return { outcome: outcomeKind, turn: seq, seq, time: 1_700_000_000_000, code: null, message: null }
}

/**
 * 造一个会话列表快照。
 * @param {object[]} rows 会话行。
 * @param {object} [projections] 每个会话的投影值。
 * @returns {object} 列表快照。
 */
function listOf(rows, projections = {}) {
  return {
    byId: Object.fromEntries(rows.map((item) => [item.id, item])),
    projectionsBySession: Object.fromEntries(Object.entries(projections).map(([id, value]) => [id, { values: { hubTurnOutcome: value } }])),
  }
}

test('四类状态都能推导出来', () => {
  const list = listOf([
    row('answer'),
    row('error'),
    row('running', { running: true }),
    row('unread'),
  ], {
    answer: outcome(3, 'completed'),
    error: outcome(4, 'error'),
    running: outcome(5, 'completed'),
    unread: outcome(6, 'completed'),
  })
  const statuses = new Map([
    ['answer', { pendingInteraction: { kind: 'question' } }],
    ['unread', { completionUnread: true }],
  ])
  const rows = deriveHubRows({ list, statuses })
  // 四类都能推导出来，且按颜色顺序（红 > 黄 > 绿 > 蓝）排列。
  assert.deepEqual(rows.map((item) => [item.id, item.state]), [
    ['error', 'error'],
    ['answer', 'answer'],
    ['unread', 'unread'],
    ['running', 'running'],
  ])
})

test('显示顺序：红（报错）> 黄（等待回答）> 绿（待查看）> 蓝（运行中）> 灰（未开始）', () => {
  const list = listOf([
    row('running', { running: true, updatedAt: 400 }),
    row('unread', { updatedAt: 300 }),
    row('answer', { updatedAt: 200 }),
    row('error', { updatedAt: 100 }),
  ], { error: outcome(2, 'interrupted') })
  const statuses = new Map([
    ['answer', { pendingInteraction: { kind: 'approval' } }],
    ['unread', { completionUnread: true }],
  ])
  // 颜色顺序优先于更新时间：更新的运行中/待查看仍排在旧报错之后。
  assert.deepEqual(deriveHubRows({ list, statuses }).map((item) => item.id), [
    'error', 'answer', 'unread', 'running',
  ])
  assert.deepEqual(STATE_ORDER, { error: 0, answer: 1, unread: 2, running: 3, draft: 4 })
})

test('未发送草稿归为「未开始」，显示在所有状态之后（运行中之后）', () => {
  const list = listOf([
    row('draft', { updatedAt: 100 }),
    row('running', { running: true, updatedAt: 400 }),
    row('unread', { updatedAt: 300 }),
    row('answer', { updatedAt: 200 }),
    row('error', { updatedAt: 100 }),
  ], { error: outcome(2, 'error') })
  const statuses = new Map([
    ['answer', { pendingInteraction: { kind: 'question' } }],
    ['unread', { completionUnread: true }],
  ])
  const drafts = {
    draft: { chars: 4 },
    running: { chars: 1 },
    unread: { chars: 1 },
    answer: { chars: 1 },
    error: { chars: 1 },
  }
  // 草稿不能盖住等待回答 / 报错 / 待查看 / 运行中；只有本身没有更高优先状态的
  // 那个会话落到「未开始」。
  assert.deepEqual(deriveHubRows({ list, statuses, drafts }).map((item) => [item.id, item.state]), [
    ['error', 'error'],
    ['answer', 'answer'],
    ['unread', 'unread'],
    ['running', 'running'],
    ['draft', 'draft'],
  ])
})

test('hasDraftContent 兼容扫描结果、字符串、Set / Map 与坏值', () => {
  assert.equal(hasDraftContent({ s1: { chars: 2 } }, 's1'), true)
  assert.equal(hasDraftContent({ s1: { chars: 0 } }, 's1'), false)
  assert.equal(hasDraftContent({ s1: ' hi ' }, 's1'), true)
  assert.equal(hasDraftContent({ s1: '   ' }, 's1'), false)
  assert.equal(hasDraftContent({ s1: true }, 's1'), true)
  assert.equal(hasDraftContent({ s1: null }, 's1'), false)
  assert.equal(hasDraftContent(new Set(['s1']), 's1'), true)
  assert.equal(hasDraftContent(new Map([['s1', { chars: 1 }]]), 's1'), true)
  assert.equal(hasDraftContent(undefined, 's1'), false)
  assert.equal(hasDraftContent(null, 's1'), false)
})

test('同一状态内按更新时间倒序，时间相同用 id 兜底', () => {
  const list = listOf([
    row('old', { running: true, updatedAt: 10 }),
    row('new', { running: true, updatedAt: 20 }),
    row('same-a', { running: true, updatedAt: 5 }),
    row('same-b', { running: true, updatedAt: 5 }),
  ])
  assert.deepEqual(deriveHubRows({ list, statuses: new Map() }).map((item) => item.id), [
    'new', 'old', 'same-a', 'same-b',
  ])
})

test('空白新会话有草稿时显示为未开始，没有草稿时与子代理会话都不进状态栏', () => {
  const list = listOf([
    row('blank', { blank: true }),
    row('sub', { origin: 'subagent', running: true }),
    row('normal', { running: true }),
  ])
  assert.deepEqual(deriveHubRows({ list, statuses: new Map() }).map((item) => item.id), ['normal'])
  // 空白「新会话」一旦输入框里有非空草稿，就是一个真实的「未开始」会话；
  // 子代理会话即使有草稿也不进状态栏。
  const withDrafts = deriveHubRows({
    list,
    statuses: new Map(),
    drafts: { blank: { chars: 1 }, sub: { chars: 1 } },
    blankTitle: 'New Session',
  })
  assert.deepEqual(withDrafts.map((item) => [item.id, item.state]), [
    ['normal', 'running'],
    ['blank', 'draft'],
  ])
  assert.equal(withDrafts.find((item) => item.id === 'blank').title, 'New Session')
  assert.deepEqual(
    deriveHubRows({ list, statuses: new Map(), includeSubagents: true }).map((item) => item.id).sort(),
    ['normal', 'sub'],
  )
})

test('已确认的报错不再显示，新 seq 会重新出现', () => {
  const list = listOf([row('s1')], { s1: outcome(7, 'error') })
  assert.equal(deriveHubRows({ list, statuses: new Map() }).length, 1)
  assert.equal(deriveHubRows({ list, statuses: new Map(), ackErrors: { s1: 7 } }).length, 0)
  assert.equal(deriveHubRows({ list, statuses: new Map(), ackErrors: { s1: 6 } }).length, 1)
  assert.equal(isUnackedFailure(outcome(7, 'completed'), 0), false)
  assert.equal(isUnackedFailure(outcome(7, 'interrupted'), 6), true)
})

test('任务栏聚合遵守红 > 黄 > 绿 > 无，且运行中不点灯', () => {
  assert.equal(aggregateTaskbarState([]), 'none')
  assert.equal(aggregateTaskbarState([{ state: 'unread' }]), 'green')
  // 运行中是常态：任务栏不点灯，避免常亮绿灯盖掉红/黄提示。
  assert.equal(aggregateTaskbarState([{ state: 'running' }]), 'none')
  // 未发送草稿也不需要点灯：它不要求你立刻处理，任务栏留给红 / 黄 / 绿。
  assert.equal(aggregateTaskbarState([{ state: 'draft' }]), 'none')
  assert.equal(aggregateTaskbarState([{ state: 'draft' }, { state: 'running' }]), 'none')
  assert.equal(aggregateTaskbarState([{ state: 'running' }, { state: 'unread' }]), 'green')
  assert.equal(aggregateTaskbarState([{ state: 'running' }, { state: 'answer' }]), 'yellow')
  assert.equal(aggregateTaskbarState([{ state: 'answer' }, { state: 'error' }]), 'red')
  assert.equal(aggregateTaskbarState([{ state: 'error' }, { state: 'unread' }]), 'red')
  assert.equal(aggregateTaskbarState([{ state: 'running' }, { state: 'answer' }, { state: 'error' }]), 'red')
})

test('失败类别：区分 error 与 interrupted，并按确认位过滤', () => {
  assert.equal(failureKindOf(outcome(3, 'error'), -1), 'error')
  assert.equal(failureKindOf(outcome(3, 'interrupted'), -1), 'interrupted')
  assert.equal(failureKindOf(outcome(3, 'completed'), -1), null)
  assert.equal(failureKindOf(outcome(3, 'error'), 3), null)
  assert.equal(failureKindOf(null, -1), null)
  assert.equal(failureKindOf(undefined, -1), null)
})

test('投影优先从 projectionsBySession 读，兼容单行 projectionValues', () => {
  const list = listOf([row('s1')], { s1: outcome(3, 'error') })
  assert.equal(projectionOf(list, 's1').seq, 3)
  const fallback = { byId: { s2: row('s2', { projectionValues: { hubTurnOutcome: outcome(4, 'interrupted') } }) } }
  assert.equal(projectionOf(fallback, 's2').outcome, 'interrupted')
  assert.equal(projectionOf(list, 'missing'), undefined)
})

test('当前会话由 retainedBy.mainView 判定', () => {
  const list = listOf([
    row('a'),
    row('b', { retainedBy: { mainView: 1 } }),
  ])
  assert.equal(currentSessionIdOf(list), 'b')
  assert.equal(currentSessionIdOf({ byId: {} }), undefined)
})

test('确认表归一化只保留合法整数', () => {
  assert.deepEqual(normalizeAckErrors({ a: 3, b: -1, c: 'x', d: 1.5 }), { a: 3 })
  assert.deepEqual(normalizeAckErrors(null), {})
  assert.deepEqual(normalizeAckErrors([1, 2]), {})
})

test('当前会话在后台完成时，靠 localUnread 补出「待查看」（官方 completionUnread 永不置位）', () => {
  // 主视图会话（retainedBy.mainView = 1）：官方 completionUnread 一定不是 true。
  const list = listOf([row('s1', { retainedBy: { mainView: 1 } })], { s1: outcome(9, 'completed') })
  const statuses = new Map([['s1', { completionUnread: false, running: false }]])

  assert.deepEqual(deriveHubRows({ list, statuses }), [], '没有补记时不会凭空出现绿点')
  const rows = deriveHubRows({ list, statuses, localUnread: { s1: 9 } })
  assert.deepEqual(rows.map((item) => [item.id, item.state]), [['s1', 'unread']])
  // 聚合到任务栏就是绿灯（没有红/黄时）。
  assert.equal(aggregateTaskbarState(rows), 'green')

  // 再次运行（running）时「运行中」优先于补记的待查看：一个会话只归一类。
  assert.deepEqual(
    deriveHubRows({ list, statuses: new Map([['s1', { running: true }]]), localUnread: { s1: 9 } })
      .map((item) => item.state),
    ['running'],
  )
  // 等待回答 / 报错的优先级同样高于待查看。
  assert.deepEqual(
    deriveHubRows({
      list: listOf([row('s1')], { s1: outcome(9, 'error') }),
      statuses: new Map([['s1', { pendingInteraction: { kind: 'question' } }]]),
      localUnread: { s1: 9 },
    }).map((item) => item.state),
    ['answer'],
  )
})

test('localUnread 记账的三种形状都按 id 命中，坏数据被丢弃', () => {
  assert.equal(hasLocalUnread({ s1: 3 }, 's1'), true)
  assert.equal(hasLocalUnread({ s1: 3 }, 's2'), false)
  assert.equal(hasLocalUnread(new Set(['s1']), 's1'), true)
  assert.equal(hasLocalUnread(new Map([['s1', 3]]), 's1'), true)
  assert.equal(hasLocalUnread(undefined, 's1'), false)
  assert.equal(hasLocalUnread(null, 's1'), false)
  assert.equal(hasLocalUnread({ s1: null }, 's1'), false)

  assert.deepEqual(normalizeLocalUnread({ a: 3, b: -1, c: 'x', d: 1.5, '': 2 }), { a: 3 })
  assert.deepEqual(normalizeLocalUnread(null), {})
  assert.deepEqual(normalizeLocalUnread([1, 2]), {})
})

test('最近会话：按更新时间倒序、排除状态组里已有的会话、默认最多 5 个', () => {
  // 8 个会话：s1 在状态组里（运行中），s2..s8 空闲，更新时间递减。
  const list = listOf([
    row('s1', { running: true, updatedAt: 900 }),
    row('s2', { updatedAt: 800 }),
    row('s3', { updatedAt: 700 }),
    row('s4', { updatedAt: 600 }),
    row('s5', { updatedAt: 500 }),
    row('s6', { updatedAt: 400 }),
    row('s7', { updatedAt: 300 }),
    row('s8', { updatedAt: 200 }),
  ])
  const statusRows = deriveHubRows({ list, statuses: new Map() })
  assert.deepEqual(statusRows.map((item) => item.id), ['s1'], '前提：s1 在状态组里')

  const recent = deriveRecentRows({ list, statusRows })
  // 状态组已经显示的 s1 不再重复出现；剩下按更新时间倒序，只取 5 个。
  assert.equal(MAX_RECENT_ROWS, 5)
  assert.deepEqual(recent.map((item) => item.id), ['s2', 's3', 's4', 's5', 's6'])
  assert.equal(recent[0].title, '会话 s2')
  assert.equal(recent[0].updatedAt, 800)
  // limit 可调；<= 0 表示不显示这一组。
  assert.deepEqual(deriveRecentRows({ list, statusRows, limit: 2 }).map((item) => item.id), ['s2', 's3'])
  assert.deepEqual(deriveRecentRows({ list, statusRows, limit: 0 }), [])
})

test('最近会话：跳过空白占位行与子代理会话，坏输入返回空列表', () => {
  const list = listOf([
    row('blank', { blank: true, updatedAt: 900 }),
    row('sub', { origin: 'subagent', updatedAt: 800 }),
    row('normal', { updatedAt: 100 }),
  ])
  assert.deepEqual(deriveRecentRows({ list }).map((item) => item.id), ['normal'])
  // 显式打开 includeSubagents 时才带子代理会话；空白占位行永远不来（没有内容）。
  assert.deepEqual(
    deriveRecentRows({ list, includeSubagents: true }).map((item) => item.id),
    ['sub', 'normal'],
  )
  // 时间是坏值时按 0 处理，仍然排得出来（不会因为脏数据整组消失）。
  assert.deepEqual(
    deriveRecentRows({ list: listOf([row('x', { updatedAt: 'bad' })]) }).map((item) => item.id),
    ['x'],
  )
  assert.deepEqual(deriveRecentRows({ list: null }), [])
  assert.deepEqual(deriveRecentRows({ list: { byId: null } }), [])
  // statusRows 形状不对时退化成「不排除任何会话」，而不是抛错。
  assert.deepEqual(
    deriveRecentRows({ list: listOf([row('a')]), statusRows: undefined }).map((item) => item.id),
    ['a'],
  )
})

test('最近会话：状态组全空（全部空闲）时也照常推导，用来回到刚才那个会话', () => {
  const list = listOf([row('idle-new', { updatedAt: 20 }), row('idle-old', { updatedAt: 10 })])
  const statusRows = deriveHubRows({ list, statuses: new Map() })
  assert.deepEqual(statusRows, [], '全是空闲会话时状态组为空')
  assert.deepEqual(deriveRecentRows({ list, statusRows }).map((item) => item.id), ['idle-new', 'idle-old'])
})

test('已归档的会话两组都不显示（归档集合不在会话列表行里）', () => {
  const list = listOf([
    row('live', { running: true, updatedAt: 300 }),
    row('archived-error', { updatedAt: 200 }),
    row('archived-idle', { updatedAt: 100 }),
  ], { 'archived-error': outcome(4, 'error') })
  const statuses = new Map()
  const archivedIds = ['archived-error', 'archived-idle']

  // 没有归档集合时（旧接线 / 拿不到 useWorkspaces）行为不变。
  assert.deepEqual(deriveHubRows({ list, statuses }).map((item) => item.id).sort(), [
    'archived-error', 'live',
  ])
  assert.deepEqual(deriveRecentRows({ list }).map((item) => item.id), ['live', 'archived-error', 'archived-idle'])

  // 有归档集合时：报错的那条不再亮红，最近会话里也不再出现。
  assert.deepEqual(deriveHubRows({ list, statuses, archivedIds }).map((item) => item.id), ['live'])
  assert.deepEqual(deriveRecentRows({ list, archivedIds }).map((item) => item.id), ['live'])
})

test('isArchivedSession 兼容数组 / Set / Map / 普通对象与坏值', () => {
  assert.equal(isArchivedSession(['s1'], 's1'), true)
  assert.equal(isArchivedSession(['s1'], 's2'), false)
  assert.equal(isArchivedSession(new Set(['s1']), 's1'), true)
  assert.equal(isArchivedSession(new Map([['s1', 1]]), 's1'), true)
  assert.equal(isArchivedSession({ s1: true }, 's1'), true)
  assert.equal(isArchivedSession({ s1: false }, 's1'), false)
  assert.equal(isArchivedSession(null, 's1'), false)
  assert.equal(isArchivedSession(undefined, 's1'), false)
  assert.equal(isArchivedSession('s1', 's1'), false)
})
