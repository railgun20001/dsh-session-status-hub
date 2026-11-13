/**
 * 会话导航历史（前进 / 后退）单测。
 *
 * 只测纯逻辑（src/hub-history.js），不碰 React、DOM、Cordis：
 *   - 访问记录、去重、前进分支截断、条数上限；
 *   - back / forward 的游标移动与「跳转前旧快照」的忽略（不能自己截断前进分支）；
 *   - peek 不移动游标；
 *   - 快照仓库只在真正变化时通知订阅者。
 *
 * 运行：node --test test/hub-history-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNavHistory, MAX_NAV_ENTRIES } from '../src/hub-history.js'

test('记录访问：游标停在最新一条，可后退不可前进', () => {
  const history = createNavHistory()
  assert.equal(history.observe('a'), true)
  assert.equal(history.observe('b'), true)
  assert.equal(history.observe('c'), true)
  assert.deepEqual(history.getSnapshot(), {
    entries: ['a', 'b', 'c'],
    index: 2,
    canBack: true,
    canForward: false,
  })
})

test('同一个会话重复观察不产生新条目（幂等）', () => {
  const history = createNavHistory()
  history.observe('a')
  assert.equal(history.observe('a'), false)
  assert.equal(history.getSnapshot().entries.length, 1)
  // 空值 / 非字符串一律忽略（还没选中任何会话时的正常观察）。
  assert.equal(history.observe(undefined), false)
  assert.equal(history.observe(''), false)
  assert.equal(history.getSnapshot().entries.length, 1)
})

test('back / forward 移动游标，跳转前的旧快照不会截断前进分支', () => {
  const history = createNavHistory()
  history.observe('a')
  history.observe('b')
  history.observe('c')

  // 后退一步：目标 b，游标移到 b。
  assert.equal(history.peek(-1), 'b')
  assert.equal(history.back(), 'b')
  assert.deepEqual(history.getSnapshot(), {
    entries: ['a', 'b', 'c'],
    index: 1,
    canBack: true,
    canForward: true,
  })

  // 跳转落地之前，观察到的仍是「刚离开的 c」——必须被忽略，否则前进分支会被截掉。
  assert.equal(history.observe('c'), false)
  assert.deepEqual(history.getSnapshot().entries, ['a', 'b', 'c'])
  // 目标 b 落地：游标已经就位，不再记一次访问。
  assert.equal(history.observe('b'), false)
  assert.equal(history.getSnapshot().index, 1)

  // 前进回到 c。
  assert.equal(history.forward(), 'c')
  assert.equal(history.observe('c'), false)
  assert.deepEqual(history.getSnapshot(), {
    entries: ['a', 'b', 'c'],
    index: 2,
    canBack: true,
    canForward: false,
  })
})

test('在历史中段打开新会话：截断前进分支（与浏览器一致）', () => {
  const history = createNavHistory()
  for (const id of ['a', 'b', 'c']) history.observe(id)
  history.back()
  history.observe('b')
  // 用户从 b 直接去了 d：c 之后再也不能「前进」到。
  assert.equal(history.observe('d'), true)
  assert.deepEqual(history.getSnapshot(), {
    entries: ['a', 'b', 'd'],
    index: 2,
    canBack: true,
    canForward: false,
  })
})

test('跳转等待期间用户自己去了别处：按新访问记录', () => {
  const history = createNavHistory()
  for (const id of ['a', 'b']) history.observe(id)
  history.back()            // 期望回到 a
  // 用户在跳转落地前从侧栏点了 z：不能把这个访问当成「旧快照」丢掉。
  assert.equal(history.observe('z'), true)
  assert.deepEqual(history.getSnapshot(), { entries: ['a', 'z'], index: 1, canBack: true, canForward: false })
})

test('peek 不移动游标，越界时返回 null', () => {
  const history = createNavHistory()
  assert.equal(history.peek(-1), null)
  assert.equal(history.peek(1), null)
  history.observe('a')
  history.observe('b')
  assert.equal(history.peek(-1), 'a')
  assert.equal(history.peek(1), null)
  // 连问两次结果一样：peek 没有副作用。
  assert.equal(history.peek(-1), 'a')
  assert.equal(history.getSnapshot().index, 1)
  assert.equal(history.back(), 'a')
  assert.equal(history.back(), null)
})

test('历史长度超过上限时丢弃最旧的一条', () => {
  const history = createNavHistory({ limit: 3 })
  for (const id of ['a', 'b', 'c', 'd']) history.observe(id)
  assert.deepEqual(history.getSnapshot(), {
    entries: ['b', 'c', 'd'],
    index: 2,
    canBack: true,
    canForward: false,
  })
  // 非法的 limit 回落到默认值（不会退化成「只保留 1 条」）。
  const fallback = createNavHistory({ limit: 0 })
  fallback.observe('a')
  fallback.observe('b')
  assert.equal(fallback.getSnapshot().entries.length, 2)
  assert.equal(MAX_NAV_ENTRIES > 1, true)
})

test('快照仓库只在真正变化时通知订阅者', () => {
  const history = createNavHistory()
  let calls = 0
  const unsubscribe = history.subscribe(() => { calls += 1 })
  history.observe('a')
  assert.equal(calls, 1)
  history.observe('a')
  assert.equal(calls, 1, '重复观察同一个会话不应通知')
  assert.equal(history.peek(-1), null, 'peek 不通知')
  history.observe('b')
  assert.equal(calls, 2)
  history.back()
  assert.equal(calls, 3, '游标移动也是变化')
  history.clear()
  assert.equal(calls, 4)
  assert.deepEqual(history.getSnapshot(), { entries: [], index: -1, canBack: false, canForward: false })
  unsubscribe()
  history.observe('c')
  assert.equal(calls, 4, '取消订阅后不再收到通知')
})

test('每份快照都是不可变副本（外部改动不会污染历史）', () => {
  const history = createNavHistory()
  history.observe('a')
  history.observe('b')
  const snapshot = history.getSnapshot()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.entries), true)
  assert.throws(() => { snapshot.entries.push('x') }, TypeError)
  assert.deepEqual(history.getSnapshot().entries, ['a', 'b'])
})
