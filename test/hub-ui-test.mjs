/**
 * 状态栏 React 组件单测（不依赖真实 React）。
 *
 * 用最小 React 桩执行 src/hub-ui.js 里的组件工厂，断言：
 *   - 四类既有状态与「未开始」草稿都渲染成对应的 chip 与中文短标签；
 *   - 空状态渲染「全部空闲」；
 *   - 点击 chip 会先确认报错、再打开对应会话；
 *   - 组件只使用官方标准 props（useSessions / useSessionStatus），不读 DOM。
 *
 * 运行：node --test test/hub-ui-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveHubRows, deriveRecentRows, failureKindOf, projectionOf, STATE_LABELS } from '../src/hub-model.js'
import { wheelScrollDelta } from '../src/hub-scroll.js'
import { HUB_STRINGS } from '../src/hub-strings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'src', 'hub-ui.js'), 'utf8')

/**
 * 最小 React 桩：createElement 产出普通对象，hooks 直接求值。
 * @returns {object} React 桩。
 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial ?? null }),
    useEffect: () => {},
  }
}

/**
 * 会真的保存状态的 React 桩：`useState` 的 setter 触发一次重渲染。
 *
 * 只有「点组标题收起 / 展开」这类交互需要用这个桩；渲染断言的用例继续用 {@link reactStub}
 * 就够了。hook 顺序在两次渲染之间保持稳定（组件里 hooks 的调用顺序是固定的）。
 * @returns {{ React: object, mount: (Component: Function, props: object) => object, current: () => object }}
 *   React 桩、挂载函数与「取当前渲染结果」的函数。
 */
function statefulReact() {
  const states = new Map()
  let cursor = 0
  let component = null
  let currentProps = null
  let tree = null
  const renderNow = () => {
    cursor = 0
    tree = component(currentProps)
    return tree
  }
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => {
      const slot = cursor
      cursor += 1
      if (!states.has(slot)) states.set(slot, initial)
      const set = (next) => {
        const previous = states.get(slot)
        states.set(slot, typeof next === 'function' ? next(previous) : next)
        renderNow()
      }
      return [states.get(slot), set]
    },
    useRef: (initial) => {
      const slot = cursor
      cursor += 1
      if (!states.has(slot)) states.set(slot, { current: initial ?? null })
      return states.get(slot)
    },
    useEffect: () => {},
  }
  return {
    React,
    mount: (Component, props) => {
      component = Component
      currentProps = props
      return renderNow()
    },
    current: () => tree,
  }
}

/**
 * 载入组件工厂。
 * @returns {Function} createSessionHubRail。
 */
function loadFactory() {
  // 组件里的可见文案来自 HUB_STRINGS（单一来源），滚轮折算来自 hub-scroll（纯逻辑），
  // 所以把它们作为自由变量注入——与 bundle 内联时的同一作用域等价。
  // eslint-disable-next-line no-new-func
  return new Function('deriveHubRows', 'deriveRecentRows', 'wheelScrollDelta', 'STATE_LABELS', 'HUB_STRINGS', `${SOURCE}\nreturn createSessionHubRail`)(
    deriveHubRows,
    deriveRecentRows,
    wheelScrollDelta,
    STATE_LABELS,
    HUB_STRINGS,
  )
}

/**
 * 载入行悬停提示组件工厂。
 * @returns {Function} createSessionHubRowHint。
 */
function loadHintFactory() {
  // eslint-disable-next-line no-new-func
  return new Function('projectionOf', 'failureKindOf', 'HUB_STRINGS', `${SOURCE}\nreturn createSessionHubRowHint`)(
    projectionOf,
    failureKindOf,
    HUB_STRINGS,
  )
}

/**
 * 载入插件详情页设置区块工厂。
 * @returns {Function} createHubSettingsPanel。
 */
function loadSettingsFactory() {
  // eslint-disable-next-line no-new-func
  return new Function('HUB_STRINGS', `${SOURCE}\nreturn createHubSettingsPanel`)(HUB_STRINGS)
}

/**
 * 找到第一个满足条件的节点。
 * @param {object} node 根节点。
 * @param {(node: object) => boolean} predicate 条件。
 * @returns {object|undefined} 节点。
 */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 收集节点树里的全部文本。
 * @param {object} node 根节点。
 * @returns {string[]} 文本片段。
 */
function collectText(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => collectText(child))
  return (node.children ?? []).flatMap((child) => collectText(child))
}

/**
 * 收集满足条件的全部节点（按出现顺序）。
 * @param {object} node 根节点。
 * @param {(node: object) => boolean} predicate 条件。
 * @returns {object[]} 节点列表。
 */
function findAll(node, predicate) {
  if (node === null || typeof node !== 'object') return []
  const hit = predicate(node) ? [node] : []
  for (const child of node.children ?? []) hit.push(...findAll(child, predicate))
  return hit
}

/**
 * 收集某个 class 的 chip。
 * @param {object} tree 组件树。
 * @param {string} modifier chip 的修饰类名（如 `dsh-hub__chip--recent`）。
 * @returns {object[]} chip 节点。
 */
function chipsOf(tree, modifier) {
  return findAll(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes(modifier))
}

/**
 * 取一组 chip 的标题（渲染出来的可见文本）。
 * @param {object[]} chips chip 节点。
 * @returns {string[]} 每条的标题文本。
 */
function titlesOf(chips) {
  return chips.map((chip) => collectText(chip).join(''))
}

/**
 * 造一个会话行。
 * @param {string} id 会话 id。
 * @param {object} [patch] 覆盖字段。
 * @returns {object} 会话行。
 */
function row(id, patch = {}) {
  return { id, displayTitle: `会话 ${id}`, title: `会话 ${id}`, running: false, blank: false, updatedAt: 1, ...patch }
}

test('四类状态渲染成 chip，空状态渲染「全部空闲」', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: {
      a: row('a', { running: true }),
      b: row('b'),
      c: row('c'),
      d: row('d'),
    },
    projectionsBySession: {
      b: { values: { hubTurnOutcome: { outcome: 'error', seq: 3, turn: 1, time: 1, code: null, message: null } } },
      c: { values: { hubTurnOutcome: null } },
      d: { values: { hubTurnOutcome: null } },
    },
  }
  const statuses = new Map([
    ['a', { pendingInteraction: { kind: 'question' } }],
    ['d', { completionUnread: true }],
  ])
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(statuses),
  })
  const text = collectText(tree).join('|')
  assert.match(text, /会话/)
  assert.match(text, /等待回答/)
  assert.match(text, /报错/)
  assert.match(text, /待查看/)
  assert.doesNotMatch(text, /全部空闲/)

  const empty = Rail({
    useSessions: (selector) => selector({ byId: {}, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.match(collectText(empty).join('|'), /全部空闲/)
})

test('点击 chip：先确认该条目的报错 seq，再打开会话', () => {
  const opened = []
  const acked = []
  const Rail = loadFactory()(reactStub(), {
    openSession: (id, options) => opened.push([id, options]),
    ackError: (id, seq) => acked.push([id, seq]),
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: { s1: row('s1') },
    projectionsBySession: {
      s1: { values: { hubTurnOutcome: { outcome: 'error', seq: 7, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const chip = findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip--error'))
  assert.ok(chip !== undefined, '应当渲染报错 chip')
  chip.props.onClick()
  assert.deepEqual(acked, [['s1', 7]])
  assert.deepEqual(opened, [['s1', { raise: false }]])
})

test('已确认的报错不再渲染 chip', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({ s1: 7 }) },
  })
  const list = {
    byId: { s1: row('s1') },
    projectionsBySession: {
      s1: { values: { hubTurnOutcome: { outcome: 'error', seq: 7, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.equal(findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip--error')), undefined)
  assert.match(collectText(tree).join('|'), /全部空闲/)
})

test('行悬停提示：只在有未确认失败时出现，区分失败与中断', () => {
  const Hint = loadHintFactory()(reactStub(), {
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: { bad: row('bad'), broken: row('broken'), ok: row('ok') },
    projectionsBySession: {
      bad: { values: { hubTurnOutcome: { outcome: 'error', seq: 5, turn: 1, time: 1, code: 'rate-limit', message: 'too many' } } },
      broken: { values: { hubTurnOutcome: { outcome: 'interrupted', seq: 6, turn: 1, time: 1, code: null, message: null } } },
      ok: { values: { hubTurnOutcome: { outcome: 'completed', seq: 7, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const useSessions = (selector) => selector(list)

  const failed = Hint({ sessionId: 'bad', useSessions })
  assert.match(collectText(failed).join('|'), /本轮失败/)
  assert.match(collectText(failed).join('|'), /rate-limit/)

  const interrupted = Hint({ sessionId: 'broken', useSessions })
  assert.match(collectText(interrupted).join('|'), /本轮中断/)

  // 正常完成的会话不显示提示（否则绿点旁边会多出一条假警报）。
  assert.equal(Hint({ sessionId: 'ok', useSessions }), null)
  // 没有 sessionId 时不渲染。
  assert.equal(Hint({ useSessions }), null)

  // 已确认的失败不再提示。
  const HintAcked = loadHintFactory()(reactStub(), {
    acks: { subscribe: () => () => {}, getSnapshot: () => ({ bad: 5 }) },
  })
  assert.equal(HintAcked({ sessionId: 'bad', useSessions }), null)
})

test('「后台完成」记账也会渲染成「待查看」chip（官方 completionUnread 覆盖不到主视图）', () => {
  const unreadStore = {
    subscribe: () => () => {},
    getSnapshot: () => ({ s1: 12 }),
  }
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    unread: unreadStore,
  })
  const list = {
    // 主视图会话：官方永远不会给它置 completionUnread。
    byId: { s1: row('s1', { retainedBy: { mainView: 1 } }) },
    projectionsBySession: {
      s1: { values: { hubTurnOutcome: { outcome: 'completed', seq: 12, turn: 1, time: 1, code: null, message: null } } },
    },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map([['s1', { completionUnread: false }]])),
  })
  const chip = findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip--unread'))
  assert.ok(chip !== undefined, '应当渲染待查看 chip')
  assert.match(collectText(tree).join('|'), /待查看/)

  // 没有注入 unread 仓库（旧接线 / 测试）时组件照常工作，只是没有补记的绿点。
  const RailWithoutUnread = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const plain = RailWithoutUnread({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map([['s1', { completionUnread: false }]])),
  })
  assert.match(collectText(plain).join('|'), /全部空闲/)
})

test('有未发送草稿的会话渲染成灰色「未开始」chip', () => {
  const draftStore = {
    subscribe: () => () => {},
    getSnapshot: () => ({ s1: { chars: 6 } }),
  }
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    drafts: draftStore,
  })
  const list = {
    byId: { s1: row('s1') },
    projectionsBySession: { s1: { values: { hubTurnOutcome: null } } },
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map([['s1', { running: false }]])),
  })
  const chip = findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__chip--draft'))
  assert.ok(chip !== undefined, '应当渲染未开始 chip')
  assert.match(collectText(tree).join('|'), /未开始/)
  // 灰色点复用主题的中性色（与官方空闲点同色），不给它安排任何强调色。
  const style = tree.children[0].children[0]
  assert.match(style, /\.dsh-hub__chip--draft \.dsh-hub__dot\{background:var\(--dsw-alias-label-tertiary\)\}/)
})

test('组标题是开关：点「状态会话」整组收起再展开，chevron 与 aria-expanded 同步', () => {
  const harness = statefulReact()
  const Rail = loadFactory()(harness.React, {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: { s1: row('s1', { running: true, updatedAt: 10 }) },
    projectionsBySession: {},
  }
  const tree = harness.mount(Rail, {
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })

  const toggle = findNode(tree, (node) => node.props?.['data-dsh-hub-group-toggle'] === 'status')
  assert.ok(toggle !== undefined, '组标题应当是按钮（data-dsh-hub-group-toggle="status"）')
  assert.equal(toggle.props['aria-expanded'], true)
  assert.match(toggle.props.className, /dsh-hub__labelbtn/)
  assert.doesNotMatch(toggle.props.className, /dsh-hub__labelbtn--collapsed/)
  assert.equal(toggle.props.title, '收起状态会话')
  assert.equal(chipsOf(tree, 'dsh-hub__chip--running').length, 1)

  toggle.props.onClick()
  const collapsedTree = harness.current()
  const collapsed = findNode(collapsedTree, (node) => node.props?.['data-dsh-hub-group-toggle'] === 'status')
  assert.equal(collapsed.props['aria-expanded'], false)
  assert.match(collapsed.props.className, /dsh-hub__labelbtn--collapsed/)
  assert.equal(collapsed.props.title, '展开状态会话')
  assert.deepEqual(chipsOf(collapsedTree, 'dsh-hub__chip'), [], '收起后一条 chip 都不渲染')
  // 收起时标题后面用小号灰字补上「还有几条」，折起来也不丢信息。
  const count = findNode(collapsedTree, (node) => node.props?.className === 'dsh-hub__count')
  assert.deepEqual(count.children, ['1'])
  assert.doesNotMatch(collectText(collapsedTree).join('|'), /全部空闲/)

  collapsed.props.onClick()
  assert.equal(chipsOf(harness.current(), 'dsh-hub__chip--running').length, 1, '再点一次恢复展开')
})

test('点「最近会话」标题只收起该组：标题留着、条目消失，状态组不受影响', () => {
  const harness = statefulReact()
  const Rail = loadFactory()(harness.React, {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: { active: row('active', { running: true, updatedAt: 20 }), idle: row('idle', { updatedAt: 10 }) },
    projectionsBySession: {},
  }
  const tree = harness.mount(Rail, {
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.deepEqual(titlesOf(chipsOf(tree, 'dsh-hub__chip--recent')), ['会话 idle'])

  const toggle = findNode(tree, (node) => node.props?.['data-dsh-hub-group-toggle'] === 'recent')
  assert.ok(toggle !== undefined, '最近会话组标题也应当是开关')
  toggle.props.onClick()

  const collapsedTree = harness.current()
  assert.deepEqual(chipsOf(collapsedTree, 'dsh-hub__chip--recent'), [])
  assert.match(collectText(collapsedTree).join('|'), /最近会话/, '收起只是藏条目，标题还在')
  // 状态组完全不受影响。
  assert.equal(chipsOf(collapsedTree, 'dsh-hub__chip--running').length, 1)
})

test('组标题按钮有可点的视觉线索：cursor / hover 底色 / chevron 转向过渡', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const tree = Rail({
    useSessions: (selector) => selector({ byId: { s1: row('s1', { running: true }) }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const css = tree.children[0].children[0]
  // 没有 cursor:pointer 用户就不会去点标题；没有 hover 态就不知道能点。
  assert.match(css, /\.dsh-hub__labelbtn\{[^}]*cursor:pointer/)
  assert.match(css, /\.dsh-hub__labelbtn:hover\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/)
  assert.match(css, /\.dsh-hub__labelbtn:focus-visible\{/)
  // 图标转向：展开朝下，收起旋转 -90° → 朝右，带 transition 让它是「转动」而不是跳变。
  assert.match(css, /\.dsh-hub__chevron\{[^}]*transition:transform/)
  assert.match(css, /\.dsh-hub__labelbtn--collapsed \.dsh-hub__chevron\{transform:rotate\(-90deg\)\}/)
  // chevron 是自绘 SVG（不依赖图标库 / 字体）。
  const chevron = findNode(tree, (node) => node.type === 'svg')
  assert.ok(chevron !== undefined, '标题里应当有 chevron 图标')
  assert.equal(chevron.props['aria-hidden'], 'true')
})

test('chrome 变体带 fixed 顶栏类与菜单偏移 CSS', () => {
  const factory = loadFactory()
  const Rail = factory(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  }, 'chrome')
  const list = { byId: { s1: row('s1', { running: true }) }, projectionsBySession: {} }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.match(tree.props.className, /dsh-hub--chrome/)
  const style = tree.children[0]
  assert.match(style.children[0], /position:fixed/)
  assert.match(style.children[0], /--dsh-windows-menu-start/)
})

test('「状态会话」组之后追加「最近会话」组：最多 5 个、不与状态组重复', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  // r1 在等你回答（进状态组）；r2..r9 空闲，更新时间依次递减。
  const byId = { r1: row('r1', { updatedAt: 900 }) }
  for (let index = 2; index <= 9; index += 1) {
    byId[`r${index}`] = row(`r${index}`, { updatedAt: 900 - index * 10 })
  }
  const list = { byId, projectionsBySession: {} }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map([['r1', { pendingInteraction: { kind: 'question' } }]])),
  })

  const text = collectText(tree).join('|')
  assert.match(text, /状态会话/)
  assert.match(text, /最近会话/)
  // 组标题顺序：状态会话在前，最近会话在后（追加在同一行末尾）。
  assert.ok(
    text.indexOf(HUB_STRINGS.zh.label) < text.indexOf(HUB_STRINGS.zh['recent.label']),
    '最近会话组必须排在状态会话组之后',
  )

  // 与状态组同款：默认 3 条，其余收在 +N 里（模型层最多给 5 条）。
  const recent = chipsOf(tree, 'dsh-hub__chip--recent')
  assert.equal(recent.length, 3, '最近会话默认只显示 3 条')
  // 状态组里的 r1 不会在最近会话里重复出现；剩下按更新时间倒序。
  assert.deepEqual(titlesOf(recent), ['会话 r2', '会话 r3', '会话 r4'])
  assert.deepEqual(titlesOf(chipsOf(tree, 'dsh-hub__chip--answer')), ['会话 r1等待回答'])
  const moreRecent = findNode(tree, (node) => node.props?.className === 'dsh-hub__more'
    && node.props?.title === '还有 2 个最近会话')
  assert.ok(moreRecent !== undefined, '还有 2 条时应当渲染 +2')
  assert.deepEqual(moreRecent.children, ['+2'])

  // 最近会话组带自己的无障碍标签，读屏能把两组分开（组里共 5 条，展开后可全部看到）。
  const recentGroup = findNode(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-hub__group--recent'))
  assert.ok(recentGroup !== undefined, '应当渲染最近会话组容器')
  assert.equal(recentGroup.props.role, 'group')
  assert.equal(recentGroup.props['aria-label'], '最近会话：5 个')
})

test('最近会话点 +N 展开到 5 条，再点「收起」回到 3 条', () => {
  const harness = statefulReact()
  const Rail = loadFactory()(harness.React, {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const byId = {}
  for (let index = 1; index <= 8; index += 1) {
    byId[`r${index}`] = row(`r${index}`, { updatedAt: 900 - index * 10 })
  }
  const tree = harness.mount(Rail, {
    useSessions: (selector) => selector({ byId, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.equal(chipsOf(tree, 'dsh-hub__chip--recent').length, 3, '默认 3 条')

  const more = findNode(tree, (node) => node.props?.className === 'dsh-hub__more')
  assert.deepEqual(more.children, ['+2'], '模型层最多给 5 条，因此 +2')
  more.props.onClick()
  const expandedTree = harness.current()
  assert.deepEqual(titlesOf(chipsOf(expandedTree, 'dsh-hub__chip--recent')), [
    '会话 r1', '会话 r2', '会话 r3', '会话 r4', '会话 r5',
  ])
  const collapse = findNode(expandedTree, (node) => node.props?.className === 'dsh-hub__more')
  assert.deepEqual(collapse.children, ['收起'])
  collapse.props.onClick()
  assert.equal(chipsOf(harness.current(), 'dsh-hub__chip--recent').length, 3, '收起后回到默认 3 条')
})

test('滚轮可以把顶部这排会话横向滚动（纵向滚轮折算成 scrollLeft）', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  // 状态栏只在溢出时接管滚轮：边界情况由模型层纯函数保证（见 hub-scroll-test）。
  assert.equal(wheelScrollDelta({ deltaY: 120, scrollWidth: 600, clientWidth: 600, scrollLeft: 0 }), 0)
  assert.equal(wheelScrollDelta({ deltaY: 120, scrollWidth: 900, clientWidth: 600, scrollLeft: 100 }), 120)

  const tree = Rail({
    useSessions: (selector) => selector({ byId: { s1: row('s1', { running: true }) }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  // 滚轮监听挂在容器上（ref 存在），容器本身横向滚动。
  assert.equal(typeof tree.props.ref, 'object')
  assert.match(tree.children[0].children[0], /\.dsh-hub\{[^}]*overflow-x:auto/)
})

test('已归档会话不显示：组件从 useWorkspaces 的 archivedSessionIds 过滤两组', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const list = {
    byId: {
      live: row('live', { running: true, updatedAt: 50 }),
      archived: row('archived', { updatedAt: 40 }),
    },
    projectionsBySession: {},
  }
  const useWorkspaces = (selector) => selector({ items: [], archivedSessionIds: ['archived'], pinnedSessionIds: [] })

  const filtered = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
    useWorkspaces,
  })
  assert.match(collectText(filtered).join('|'), /会话 live/)
  assert.doesNotMatch(collectText(filtered).join('|'), /会话 archived/)

  // 拿不到 useWorkspaces（旧宿主 / 独立插槽）时不做归档过滤，但组件必须照常渲染。
  const unfiltered = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const text = collectText(unfiltered).join('|')
  assert.match(text, /会话 live/)
  assert.match(text, /会话 archived/)
})

test('点击「最近会话」chip 只跳转，不去确认报错；没有可回头的会话时不渲染该组', () => {
  const opened = []
  const acked = []
  const Rail = loadFactory()(reactStub(), {
    openSession: (id, options) => opened.push([id, options]),
    ackError: (id, seq) => acked.push([id, seq]),
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })

  const list = {
    byId: { active: row('active', { running: true, updatedAt: 50 }), old: row('old', { updatedAt: 10 }) },
    projectionsBySession: {},
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const recent = chipsOf(tree, 'dsh-hub__chip--recent')
  assert.deepEqual(titlesOf(recent), ['会话 old'])
  recent[0].props.onClick()
  assert.deepEqual(opened, [['old', { raise: false }]])
  assert.deepEqual(acked, [], '最近会话没有状态可确认')

  // 所有会话都在状态组里时（这里只有一个运行中会话），最近会话组整体不渲染。
  const onlyStatus = Rail({
    useSessions: (selector) => selector({ byId: { active: row('active', { running: true }) }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.deepEqual(chipsOf(onlyStatus, 'dsh-hub__chip--recent'), [])
  assert.doesNotMatch(collectText(onlyStatus).join('|'), /最近会话/)
  // 空白「新会话」占位行不会跑到最近会话里变成一串同名条目。
  const withBlank = Rail({
    useSessions: (selector) => selector({
      byId: { blank: row('blank', { blank: true }) },
      projectionsBySession: {},
    }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.deepEqual(chipsOf(withBlank, 'dsh-hub__chip--recent'), [])
  assert.match(collectText(withBlank).join('|'), /全部空闲/)
})

test('「状态会话」前面有前进 / 后退按钮：位置在前、无历史时置灰禁用', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    // 历史只有一条（当前会话），两个方向都没有可去的地方。
    history: { subscribe: () => () => {}, getSnapshot: () => ({ entries: ['s1'], index: 0, canBack: false, canForward: false }) },
    goBack: () => true,
    goForward: () => true,
  })
  const tree = Rail({
    useSessions: (selector) => selector({ byId: { s1: row('s1', { running: true }) }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })

  const back = findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'back')
  const forward = findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'forward')
  assert.ok(back !== undefined, '应当渲染后退按钮')
  assert.ok(forward !== undefined, '应当渲染前进按钮')
  assert.equal(back.props.disabled, true)
  assert.equal(forward.props.disabled, true)
  assert.equal(back.props.title, '后退会话')
  assert.equal(forward.props.title, '前进会话')
  // 图标是自绘 SVG，不依赖图标库 / 字体。
  assert.equal(findNode(back, (node) => node.type === 'svg').props['aria-hidden'], 'true')

  // 位置：「状态会话」组标题之前（导航组是状态栏里的第一组）。
  const railChildren = tree.children.filter((child) => child?.props?.className !== undefined)
  assert.match(railChildren[0].props.className, /dsh-hub__navgroup/)
  assert.match(railChildren[1].props.className, /dsh-hub__group--status/)
})

test('有历史时点 ‹ › 会分别调用 goBack / goForward，且不去确认任何状态', () => {
  const calls = []
  const acked = []
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: (id, seq) => acked.push([id, seq]),
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    history: { subscribe: () => () => {}, getSnapshot: () => ({ entries: ['a', 'b', 'c'], index: 1, canBack: true, canForward: true }) },
    goBack: () => { calls.push('back'); return true },
    goForward: () => { calls.push('forward'); return true },
  })
  const tree = Rail({
    useSessions: (selector) => selector({ byId: { b: row('b') }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })

  const back = findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'back')
  const forward = findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'forward')
  assert.equal(back.props.disabled, false)
  assert.equal(forward.props.disabled, false)
  back.props.onClick()
  forward.props.onClick()
  assert.deepEqual(calls, ['back', 'forward'])
  assert.deepEqual(acked, [], '导航按钮是纯跳转，不确认任何状态')
})

test('没有注入历史仓库与动作时按钮照常渲染但不可点（不会报错）', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const tree = Rail({
    useSessions: (selector) => selector({ byId: { s1: row('s1') }, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const back = findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'back')
  assert.ok(back !== undefined)
  assert.equal(back.props.disabled, true)
  assert.equal(back.props.onClick, undefined)
})

test('导航按钮的视觉线索：hover 底色、focus 描边、禁用态降透明度', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const tree = Rail({
    useSessions: (selector) => selector({ byId: {}, projectionsBySession: {} }),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const css = tree.children[0].children[0]
  assert.match(css, /\.dsh-hub__navbtn\{[^}]*cursor:pointer/)
  assert.match(css, /\.dsh-hub__navbtn:hover:not\(:disabled\)\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/)
  assert.match(css, /\.dsh-hub__navbtn:focus-visible\{/)
  assert.match(css, /\.dsh-hub__navbtn:disabled\{[^}]*opacity:/)
})

test('设置里关掉「最近会话」：状态栏只剩状态会话组，导航按钮照常', () => {
  const Rail = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
    settings: { subscribe: () => () => {}, getSnapshot: () => ({ showRecentSessions: false }) },
  })
  const list = {
    byId: { active: row('active', { running: true, updatedAt: 50 }), idle: row('idle', { updatedAt: 10 }) },
    projectionsBySession: {},
  }
  const tree = Rail({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  const text = collectText(tree).join('|')
  assert.match(text, /状态会话/)
  assert.doesNotMatch(text, /最近会话/, '关掉设置后不该再渲染这一组')
  assert.deepEqual(chipsOf(tree, 'dsh-hub__chip--recent'), [])
  // 状态组与导航按钮不受影响。
  assert.equal(chipsOf(tree, 'dsh-hub__chip--running').length, 1)
  assert.ok(findNode(tree, (node) => node.props?.['data-dsh-hub-nav'] === 'back') !== undefined)

  // 没有注入设置仓库时按默认渲染（显示最近会话）。
  const RailDefault = loadFactory()(reactStub(), {
    openSession: () => {},
    ackError: () => {},
    acks: { subscribe: () => () => {}, getSnapshot: () => ({}) },
  })
  const defaultTree = RailDefault({
    useSessions: (selector) => selector(list),
    useSessionStatus: (selector) => selector(new Map()),
  })
  assert.match(collectText(defaultTree).join('|'), /最近会话/)
})

test('详情页设置区块：默认勾选，取消勾选写入 showRecentSessions=false', () => {
  const calls = []
  const Settings = loadSettingsFactory()(reactStub(), {
    settings: { subscribe: () => () => {}, getSnapshot: () => ({ showRecentSessions: true }) },
    setShowRecentSessions: (visible) => calls.push(visible),
  })
  const tree = Settings({})
  const box = findNode(tree, (node) => node.props?.['data-dsh-hub-setting'] === 'recent-sessions')
  assert.ok(box !== undefined, '应当渲染「显示最近会话」勾选框')
  assert.equal(box.props.checked, true)
  assert.equal(box.props.disabled, false)
  assert.equal(box.props.type, 'checkbox')
  // 区块标题与说明来自 HUB_STRINGS（单一来源）。
  assert.match(collectText(tree).join('|'), /状态栏/)
  assert.match(collectText(tree).join('|'), /最近会话/)

  box.props.onChange({ target: { checked: false } })
  box.props.onChange({ target: { checked: true } })
  assert.deepEqual(calls, [false, true])

  // 设置值为 false 时勾选框未勾选。
  const Off = loadSettingsFactory()(reactStub(), {
    settings: { subscribe: () => () => {}, getSnapshot: () => ({ showRecentSessions: false }) },
    setShowRecentSessions: () => {},
  })
  const offBox = findNode(Off({}), (node) => node.props?.['data-dsh-hub-setting'] === 'recent-sessions')
  assert.equal(offBox.props.checked, false)

  // 没有写入动作时勾选框禁用（不会出现「点了没反应」的假开关）。
  const ReadOnly = loadSettingsFactory()(reactStub(), {
    settings: { subscribe: () => () => {}, getSnapshot: () => ({ showRecentSessions: true }) },
  })
  const readonlyBox = findNode(ReadOnly({}), (node) => node.props?.['data-dsh-hub-setting'] === 'recent-sessions')
  assert.equal(readonlyBox.props.disabled, true)
})
