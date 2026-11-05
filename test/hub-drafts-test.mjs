/**
 * 「未开始」草稿读取的纯逻辑单测。
 *
 * 覆盖 ui-conversation 的两种持久化形状（旧版字符串 / 新版语义对象）、坏数据回落、
 * 只保留非空草稿、以及「内容没变就复用同一个对象」的 React 快照约定。
 *
 * 运行：node --test test/hub-drafts-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  draftStorageKeyOf,
  draftTextOf,
  parseConversationDraft,
  readSessionDraft,
  sameDraftMap,
  scanSessionDrafts,
} from '../src/hub-drafts.js'

/**
 * 造一个只实现 getItem 的假存储。
 * @param {Record<string, string>} [entries] 初始键值。
 * @returns {{ getItem: (key: string) => string|null, entries: Record<string, string> }} 假存储。
 */
function storageOf(entries = {}) {
  return {
    entries,
    getItem(key) {
      return Object.hasOwn(entries, key) ? entries[key] : null
    },
  }
}

/**
 * 造一条当前版本的会话存储值。
 * @param {string} text 草稿正文。
 * @returns {string} JSON 字符串。
 */
function storedObject(text) {
  return JSON.stringify({ draft: { text, references: [] }, view: null, viewRequest: null })
}

test('存储键与 ui-conversation 的约定一致', () => {
  assert.equal(draftStorageKeyOf('session-1'), 'dsh.conversation.session-1')
})

test('旧版字符串草稿与新版语义草稿都能识别', () => {
  assert.equal(parseConversationDraft(JSON.stringify({ draft: '还没发出去' })).chars, 5)
  assert.equal(parseConversationDraft(storedObject('还没发出去')).chars, 5)
  // 新版对象里 text 两边有空白：trim 后长度才算有效草稿。
  assert.equal(parseConversationDraft(storedObject('  hi  ')).chars, 2)
})

test('空草稿 / 纯空白 / 坏数据一律当作没有草稿', () => {
  assert.equal(parseConversationDraft(JSON.stringify({ draft: '' })), null)
  assert.equal(parseConversationDraft(storedObject('   \n\t  ')), null)
  assert.equal(parseConversationDraft(JSON.stringify({ draft: null })), null)
  assert.equal(parseConversationDraft(JSON.stringify({ draft: { text: 42 } })), null)
  assert.equal(parseConversationDraft(JSON.stringify({ view: null })), null)
  assert.equal(parseConversationDraft('{不是 JSON'), null)
  assert.equal(parseConversationDraft(''), null)
  assert.equal(parseConversationDraft(null), null)
})

test('draftTextOf 只认字符串与 { text: string }', () => {
  assert.equal(draftTextOf('abc'), 'abc')
  assert.equal(draftTextOf({ text: 'abc' }), 'abc')
  assert.equal(draftTextOf({ text: 1 }), '')
  assert.equal(draftTextOf(undefined), '')
  assert.equal(draftTextOf([]), '')
})

test('readSessionDraft：缺键、存储缺失、getItem 抛错都返回 null', () => {
  const storage = storageOf({ 'dsh.conversation.s1': storedObject('草稿') })
  assert.deepEqual(readSessionDraft(storage, 's1'), { chars: 2 })
  assert.equal(readSessionDraft(storage, 's2'), null)
  assert.equal(readSessionDraft(null, 's1'), null)
  assert.equal(readSessionDraft({ getItem: () => { throw new Error('blocked') } }, 's1'), null)
  assert.equal(readSessionDraft(storage, ''), null)
})

test('scanSessionDrafts 只保留非空草稿，并复用未变化的元数据对象', () => {
  const storage = storageOf({
    'dsh.conversation.s1': storedObject('第一条'),
    'dsh.conversation.s2': storedObject('   '),
    'dsh.conversation.s3': JSON.stringify({ draft: '第三条' }),
  })
  const first = scanSessionDrafts(storage, ['s1', 's2', 's3', 'missing'])
  assert.deepEqual(first, { s1: { chars: 3 }, s3: { chars: 3 } })

  // 内容不变：对象引用必须复用，避免状态栏做无谓重渲染。
  const second = scanSessionDrafts(storage, ['s1', 's3'], first)
  assert.equal(second.s1, first.s1)
  assert.equal(second.s3, first.s3)

  // 内容变化：只替换变化的那一项。
  storage.entries['dsh.conversation.s1'] = storedObject('改了')
  const third = scanSessionDrafts(storage, ['s1', 's3'], second)
  assert.deepEqual(third.s1, { chars: 2 })
  assert.equal(third.s3, second.s3)
  assert.notEqual(third.s1, second.s1)
})

test('sameDraftMap 只按键与字符数比较', () => {
  assert.equal(sameDraftMap({}, {}), true)
  assert.equal(sameDraftMap({ s1: { chars: 2 } }, { s1: { chars: 2 } }), true)
  assert.equal(sameDraftMap({ s1: { chars: 2 } }, { s1: { chars: 3 } }), false)
  assert.equal(sameDraftMap({ s1: { chars: 2 } }, {}), false)
  assert.equal(sameDraftMap(null, {}), false)
  assert.equal(sameDraftMap(undefined, undefined), true)
})
