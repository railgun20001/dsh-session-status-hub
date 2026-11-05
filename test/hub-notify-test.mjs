/**
 * dsh-session-status-hub —— 通知落地层单测（src/hub-notify.js）
 *
 * 这一层以前只能通过「加载整个 bundle + 桩浏览器环境」间接测（见 client-half-test.mjs）。
 * 拆出来之后可以直接注入假存储、假时钟与假 Notification，把最容易出错的三件事单独立住：
 *
 *   - `tag` 必须是 15 个字符的哈希（超长会被 Windows 静默丢整条通知）；
 *   - 同一事件在 4 秒窗口内只由第一个页面弹（跨标签页去重）；
 *   - 每种结局（shown / failed / no-event / permission / deduped）都要在落地日志里留痕。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createNotifySink,
  shortToastTag,
  CROSS_TAB_WINDOW_MS,
  MAX_LIVE_TOASTS,
  NOTIFY_LOG_LIMIT,
  NOTIFY_SHOW_TIMEOUT_MS,
} from '../src/hub-notify.js'

/**
 * 内存版 JSON 存储（与 hub-json-store 的 read/write 同签名）。
 * @returns {{ read: Function, write: Function, data: Map<string, unknown> }} 存储。
 */
function memoryStore() {
  const data = new Map()
  return {
    data,
    read: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    write: (key, value) => { data.set(key, value) },
  }
}

/**
 * 假 Notification：记下构造参数与关闭状态。
 * @param {object} state 收集器。
 * @param {string} [permission] 权限。
 * @returns {Function} 构造函数。
 */
function fakeNotification(state, permission = 'granted') {
  const Ctor = function FakeNotification(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    this.close = () => { this.closed = true }
    state.created.push(this)
  }
  Ctor.permission = permission
  Ctor.requestPermission = () => Promise.resolve(permission === 'default' ? 'granted' : permission)
  return Ctor
}

/**
 * 造一个通知落地器。
 * @param {object} [overrides] 覆盖项。
 * @returns {object} `{ sink, state, store, setConfig }` 测试夹具。
 */
function harness(overrides = {}) {
  const store = memoryStore()
  const state = { created: [], opened: [], warmed: 0, now: 1_000 }
  let config = { colorMarkers: true, sound: true }
  const sink = createNotifySink({
    pluginId: 'dsh-session-status-hub',
    keys: { recent: 'recent', notifyLog: 'log' },
    store,
    getConfig: () => config,
    isFocused: overrides.isFocused ?? (() => false),
    openSession: (sessionId, options) => { state.opened.push({ sessionId, options }) },
    onFirstShow: () => { state.warmed += 1 },
    now: () => state.now,
  })
  return {
    sink,
    state,
    store,
    setConfig: (next) => { config = next },
  }
}

/** 一条普通通知（完成）。 */
function notification(overrides = {}) {
  return {
    sessionId: 'session-1',
    dedupeKey: 'completed:12',
    category: 'completed',
    marker: '🟢',
    title: 'DSH · 任务完成',
    body: '会话 1',
    // 「需要你回应」才带对应待交互 key；其他类别固定为 null。
    pendingKey: null,
    ...overrides,
  }
}

test('shortToastTag：15 个字符、只含小写字母数字、同身份稳定、异身份不同', () => {
  const tag = shortToastTag('dsh-session-status-hub:session-82ed72ce-1#completed:1345')
  assert.match(tag, /^dsh[0-9a-f]{12}$/)
  assert.equal(tag.length, 15)
  assert.ok(tag.length <= 16, '必须低于实测安全上限 16 字符')
  assert.equal(shortToastTag('dsh-session-status-hub:session-82ed72ce-1#completed:1345'), tag)
  assert.notEqual(shortToastTag('dsh-session-status-hub:session-82ed72ce-1#completed:1346'), tag)
})

test('标题带彩色圆点；colorMarkers 关掉后只剩文案', () => {
  const a = harness()
  globalThis.Notification = fakeNotification(a.state)
  a.sink.show(notification())
  assert.equal(a.state.created[0].title, '🟢 DSH · 任务完成')

  const b = harness()
  b.setConfig({ colorMarkers: false, sound: true })
  globalThis.Notification = fakeNotification(b.state)
  b.sink.show(notification())
  assert.equal(b.state.created[0].title, 'DSH · 任务完成')
})

test('tag 交给系统的是短哈希，可读身份只进诊断日志', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification())
  const toast = h.state.created[0]
  assert.match(toast.options.tag, /^dsh[0-9a-f]{12}$/)
  // 构造成功本身不写日志（没有任何回执可报）；拿到 show 回执后才有记录。
  toast.onshow()
  const [entry] = h.sink.getLog()
  assert.equal(entry.key, 'dsh-session-status-hub:session-1#completed:12')
  assert.equal(entry.tag, toast.options.tag)
})

test('silent 跟随 sound，requireInteraction 只给「需要你回应」', (t) => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ dedupeKey: 'a' }))
  assert.equal(h.state.created[0].options.silent, false)
  assert.equal(h.state.created[0].options.requireInteraction, false)

  h.sink.show(notification({ dedupeKey: 'b', category: 'answer', marker: '🟡' }))
  assert.equal(h.state.created[1].options.requireInteraction, true)

  const quiet = harness()
  quiet.setConfig({ colorMarkers: true, sound: false })
  globalThis.Notification = fakeNotification(quiet.state)
  quiet.sink.show(notification({ dedupeKey: 'c' }))
  assert.equal(quiet.state.created[0].options.silent, true)
})

test('同一事件在去重窗口内只弹一次，窗口过后可以再弹', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)

  h.sink.show(notification())
  h.sink.show(notification())
  assert.equal(h.state.created.length, 1, '同一 dedupeKey 只应构造一次')
  assert.equal(h.sink.getLog().at(-1).stage, 'deduped')

  h.state.now += CROSS_TAB_WINDOW_MS
  h.sink.show(notification())
  assert.equal(h.state.created.length, 2, '窗口过期后允许再次弹出')
})

test('落地日志按阶段留痕：shown / failed，且环形只保留最近 20 条', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ dedupeKey: 'shown-1' }))
  h.state.created.at(-1).onshow()
  assert.equal(h.sink.getLog().at(-1).stage, 'shown')

  h.sink.show(notification({ dedupeKey: 'failed-1' }))
  h.state.created.at(-1).onerror({ message: 'denied by system' })
  assert.equal(h.sink.getLog().at(-1).stage, 'failed')
  assert.equal(h.sink.getLog().at(-1).detail, 'denied by system')

  for (let index = 0; index < NOTIFY_LOG_LIMIT + 5; index += 1) {
    h.sink.show(notification({ dedupeKey: `bulk-${index}` }))
    h.state.created.at(-1).onshow()
  }
  assert.equal(h.sink.getLog().length, NOTIFY_LOG_LIMIT)
})

test('没有回执时记 no-event（只表示未确认，不是失败）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification())
  // 刚构造完还没有任何回执：此时**不该**有任何落地记录。
  assert.equal(h.sink.getLog().length, 0)
  t.mock.timers.tick(NOTIFY_SHOW_TIMEOUT_MS)
  assert.equal(h.sink.getLog().at(-1).stage, 'no-event')
})

test('权限不是 granted 时不构造通知，只记 permission', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state, 'denied')
  h.sink.show(notification())
  assert.equal(h.state.created.length, 0)
  assert.equal(h.sink.getLog().at(-1).stage, 'permission')
})

test('点击通知只认第一次，并按窗口是否聚焦决定要不要请求前置', () => {
  const unfocused = harness({ isFocused: () => false })
  globalThis.Notification = fakeNotification(unfocused.state)
  unfocused.sink.show(notification())
  const toast = unfocused.state.created[0]
  toast.onclick()
  toast.onclick()
  assert.deepEqual(unfocused.state.opened, [{ sessionId: 'session-1', options: { raise: true } }])
  assert.equal(toast.closed, true)

  const focused = harness({ isFocused: () => true })
  globalThis.Notification = fakeNotification(focused.state)
  focused.sink.show(notification())
  focused.state.created[0].onclick()
  assert.deepEqual(focused.state.opened, [{ sessionId: 'session-1', options: { raise: false } }])
})

test('打开会话后只撤回该会话仍然挂着的通知（含多个类别），其他会话不受影响', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ sessionId: 'session-1', dedupeKey: 'completed:1' }))
  h.sink.show(notification({
    sessionId: 'session-1', category: 'answer', marker: '🟡', dedupeKey: 'answer:q1', pendingKey: 'q1',
  }))
  h.sink.show(notification({ sessionId: 'session-2', dedupeKey: 'completed:2' }))
  const [first, second, third] = h.state.created

  assert.equal(h.sink.dismissSession('session-1'), 2)
  assert.equal(first.closed, true)
  assert.equal(second.closed, true)
  assert.equal(third.closed, false)
  assert.deepEqual(h.sink.getLive().map((item) => item.sessionId), ['session-2'])

  // 重复撤回是幂等的：已经不登记的通知不会再被关一次。
  assert.equal(h.sink.dismissSession('session-1'), 0)
  assert.equal(first.closed, true)
  // 非法入参不产生任何动作。
  assert.equal(h.sink.dismissSession(''), 0)
  assert.equal(h.sink.dismissSession(undefined), 0)
})

test('待交互消失或换成新 key 后，旧的「需要你回应」通知自动撤回', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({
    sessionId: 'session-1', category: 'answer', marker: '🟡', dedupeKey: 'answer:q1', pendingKey: 'q1',
  }))
  h.sink.show(notification({
    sessionId: 'session-2', category: 'answer', marker: '🟡', dedupeKey: 'answer:q2', pendingKey: 'q2',
  }))
  const [q1, q2] = h.state.created
  let current = { 'session-1': 'q1', 'session-2': 'q2' }
  const readPending = (id) => current[id] ?? null

  // 待交互还在，谁都不该被撤。
  assert.equal(h.sink.dismissStaleAnswers(readPending), 0)
  assert.equal(q1.closed, false)
  assert.equal(q2.closed, false)

  // session-1 已经回答：key 消失。
  current = { 'session-2': 'q2' }
  assert.equal(h.sink.dismissStaleAnswers(readPending), 1)
  assert.equal(q1.closed, true)
  assert.equal(q2.closed, false)

  // session-2 换成了新问题：旧催办过期。
  current = { 'session-2': 'q9' }
  assert.equal(h.sink.dismissStaleAnswers(readPending), 1)
  assert.equal(q2.closed, true)
  assert.deepEqual(h.sink.getLive(), [])
})

test('撤回只处理「需要你回应」：完成通知与判断不了的情况都保留', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ category: 'completed', dedupeKey: 'completed:12' }))
  h.sink.show(notification({
    sessionId: 'session-2', category: 'answer', dedupeKey: 'answer:q1', pendingKey: 'q1',
  }))
  const [completed, answer] = h.state.created

  // 非 answer 没有 pendingKey，不会被这条路径撤掉；undefined 表示「此刻判断不了」，也保留。
  assert.equal(h.sink.dismissStaleAnswers(() => undefined), 0)
  assert.equal(completed.closed, false)
  assert.equal(answer.closed, false)
})

test('测试通知不登记；用户关闭后登记项自动移除', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ dedupeKey: 'test:1', category: 'answer', dismissible: false }))
  assert.deepEqual(h.sink.getLive(), [])
  assert.equal(h.sink.dismissSession('session-1'), 0)

  h.sink.show(notification({ dedupeKey: 'completed:2' }))
  h.state.created.at(-1).onclose()
  assert.deepEqual(h.sink.getLive(), [], '用户自己关掉后不再需要登记')
})

test('登记表有上限，超出后丢弃最旧引用但不去关它', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  for (let index = 0; index < MAX_LIVE_TOASTS + 5; index += 1) {
    h.sink.show(notification({ dedupeKey: `bulk-${index}` }))
  }
  assert.equal(h.sink.getLive().length, MAX_LIVE_TOASTS)
  assert.equal(h.state.created[0].closed, false, '淘汰只丢引用，不主动关闭旧通知')
})

test('首次成功弹出会预热一次宿主半，之后不重复', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification({ dedupeKey: 'w1' }))
  h.sink.show(notification({ dedupeKey: 'w2' }))
  assert.equal(h.state.warmed, 1)
})

test('清空落地日志', () => {
  const h = harness()
  globalThis.Notification = fakeNotification(h.state)
  h.sink.show(notification())
  h.state.created.at(-1).onshow()
  assert.equal(h.sink.getLog().length, 1)
  assert.deepEqual(h.sink.clearLog(), [])
  assert.equal(h.sink.getLog().length, 0)
})
