/**
 * dsh-session-status-hub —— 「未开始」草稿的读取与归一化（零依赖，可单测）
 *
 * ## 为什么是 localStorage，而不是某个客户端服务
 *
 * DSH 的 `ui-conversation` 会把每个会话的输入框草稿持久化到浏览器存储：
 *
 *   localStorage["dsh.conversation.<sessionId>"] = JSON.stringify({
 *     draft: "纯文本" | { text: "…", references: [...], command?: { token } },
 *     view: null,
 *     viewRequest: null,
 *   })
 *
 * 旧版本 `draft` 是字符串；当前版本是语义快照对象（`parseStoredDraft` 两种都认）。
 * 但 DSH 没有暴露「按会话读取草稿」的公开服务：`conversation.input.shell(id)` 只覆盖
 * 已经被 retain 的会话，且会顺带创建一整套输入机 / 编辑器，代价远大于读一个键。
 * 因此这里只读上述**持久化键**，不碰 DOM、不碰编辑器、不 retain 会话。
 *
 * ## 隐私边界
 *
 * 本模块只回答「这个会话有没有非空草稿」，返回值里**没有草稿正文**——解析出 `text`
 * 后立即 `trim()` 取长度，正文不进入插件状态、不落盘、不外发、不渲染。
 *
 * ## 失败策略
 *
 * 存储不可用、键不存在、JSON 坏了、形状不认识，一律当作「没有草稿」。草稿状态是
 * 锦上添花，任何异常都不能影响报错 / 等待回答 / 待查看 / 运行中这四类既有状态。
 *
 * @module dsh-session-status-hub/hub-drafts
 */

/** `ui-conversation` 的 per-session 存储键前缀（与其源码里的 CONVERSATION_STORE_KEY 一致）。 */
export const CONVERSATION_STORE_KEY = 'dsh.conversation'

/**
 * 某个会话的草稿存储键。
 * @param {string} sessionId 会话 id。
 * @returns {string} localStorage 键。
 */
export function draftStorageKeyOf(sessionId) {
  return `${CONVERSATION_STORE_KEY}.${sessionId}`
}

/**
 * 从「草稿字段」里提取文本。只接受字符串（旧版）或 `{ text: string }`（新版）。
 * @param {unknown} draft `stored.draft` 字段。
 * @returns {string} 草稿文本；形状不认识时返回空串。
 */
export function draftTextOf(draft) {
  if (typeof draft === 'string') return draft
  if (draft === null || typeof draft !== 'object') return ''
  return typeof draft.text === 'string' ? draft.text : ''
}

/**
 * 解析一条 `dsh.conversation.<id>` 的原始值。
 *
 * 返回值刻意只带 `chars`（trim 后的字符数）：调用方只需要「有没有草稿」，
 * 不需要、也不应该把用户输入正文留在内存里。
 * @param {string|null|undefined} raw localStorage 原始字符串。
 * @returns {{ chars: number }|null} 非空草稿的元数据；没有草稿时为 null。
 */
export function parseConversationDraft(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }
  if (stored === null || typeof stored !== 'object') return null
  if (!Object.hasOwn(stored, 'draft')) return null
  const chars = draftTextOf(stored.draft).trim().length
  return chars > 0 ? { chars } : null
}

/**
 * 读取一个会话的草稿元数据。
 * @param {{ getItem: (key: string) => string|null }|null|undefined} storage 浏览器存储。
 * @param {string} sessionId 会话 id。
 * @returns {{ chars: number }|null} 非空草稿的元数据；没有时为 null。
 */
export function readSessionDraft(storage, sessionId) {
  if (storage === null || storage === undefined || typeof storage.getItem !== 'function') return null
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    return parseConversationDraft(storage.getItem(draftStorageKeyOf(sessionId)))
  } catch {
    return null
  }
}

/**
 * 扫描一批会话的草稿。
 *
 * `previous` 用来复用未变化的 `{ chars }` 对象：React 侧按引用比较，
 * 每次轮询都造新对象会让状态栏无谓重渲染。传入上一次的扫描结果即可。
 * @param {{ getItem: (key: string) => string|null }|null|undefined} storage 浏览器存储。
 * @param {string[]} sessionIds 会话 id 列表。
 * @param {object|null} [previous] 上一次扫描结果。
 * @returns {Record<string, { chars: number }>} 会话 id → 草稿元数据（只含非空草稿）。
 */
export function scanSessionDrafts(storage, sessionIds, previous = null) {
  const drafts = {}
  if (!Array.isArray(sessionIds)) return drafts
  const previousMap = previous !== null && typeof previous === 'object' ? previous : null
  for (const sessionId of sessionIds) {
    const draft = readSessionDraft(storage, sessionId)
    if (draft === null) continue
    const before = previousMap?.[sessionId]
    drafts[sessionId] = before !== undefined && before !== null && before.chars === draft.chars ? before : draft
  }
  return drafts
}

/**
 * 判断两份草稿表是否等价（只比较键与 `chars`）。
 *
 * 用来决定要不要通知 React 订阅者：内容没变就不发布新快照。
 * @param {object|null|undefined} left 旧表。
 * @param {object|null|undefined} right 新表。
 * @returns {boolean} 是否等价。
 */
export function sameDraftMap(left, right) {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((sessionId) => {
    const before = left[sessionId]
    const after = right[sessionId]
    return before === after || (before !== null && after !== null
      && typeof before === 'object' && typeof after === 'object' && before.chars === after.chars)
  })
}
