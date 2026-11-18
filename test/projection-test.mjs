/**
 * 宿主半（hubTurnOutcome 投影 + 路由）单测。
 *
 * 运行：node --test test/projection-test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  createRouteHandler,
  foldHubTurnOutcome,
  hubTurnOutcomeSchema,
  inject,
  name,
  PLUGIN_ID,
  PROJECTION_KEY,
  ROUTE_HEADER,
  ROUTE_PATH,
} from '../index.js'
import { resolveTargetProcessId } from '../lib/raise-window.js'
import { ROUTE_HEADER_VALUE } from '../src/hub-identity.js'

/** 读 package.json 的 version，作为两半版本标识的单一事实来源。 */
function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url))
  return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
}

/** 构造一个 turn/end 事件。 */
function turnEndEvent(kind, seq = 4, extra = {}) {
  return {
    type: 'turn/end',
    seq,
    time: 1_700_000_000_000,
    data: { turn: 2, reason: { kind, ...extra } },
  }
}

test('插件声明了会话投影依赖', () => {
  assert.equal(name, 'session-hub')
  assert.deepEqual(inject, ['sessionProjections'])
  assert.equal(PROJECTION_KEY, 'hubTurnOutcome')
})

test('只关心 turn/end：其他事件保持旧引用', () => {
  const state = { outcome: 'completed', turn: 1, seq: 3, time: 1, code: null, message: null }
  const same = foldHubTurnOutcome(state, { type: 'turn/start', seq: 4, time: 2, data: { turn: 2 } })
  assert.equal(same, state)
})

test('completed 折叠出完整状态', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('completed'))
  assert.deepEqual(state, {
    outcome: 'completed',
    turn: 2,
    seq: 4,
    time: 1_700_000_000_000,
    code: null,
    message: null,
  })
})

test('error 带出错误码与信息', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, {
    error: { code: 'LLM_REQUEST_FAILED', message: '连接被重置' },
  }))
  assert.equal(state.outcome, 'error')
  assert.equal(state.code, 'LLM_REQUEST_FAILED')
  assert.equal(state.message, '连接被重置')
})

test('error 缺字段时退化为 null', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, { error: null }))
  assert.equal(state.code, null)
  assert.equal(state.message, null)
})

test('账号登出钩子触发的 aborted 重分类为 error', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('aborted', 5, {
    reason: { kind: 'hook', reason: 'deepseek-account/signed-out' },
  }))
  assert.equal(state.outcome, 'error')
  assert.equal(state.code, 'ACCOUNT_SIGNED_OUT')
})

test('普通手动中断保持 aborted', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('aborted', 5, {
    reason: { kind: 'user', reason: 'stop-button' },
  }))
  assert.equal(state.outcome, 'aborted')
  assert.equal(state.code, null)
})

test('崩溃恢复的 interrupted 与分叉的 forked 原样记录', () => {
  assert.equal(foldHubTurnOutcome(null, turnEndEvent('interrupted', 6)).outcome, 'interrupted')
  assert.equal(foldHubTurnOutcome(null, turnEndEvent('forked', 7)).outcome, 'forked')
})

test('reason 缺失或形状不对时保持旧状态', () => {
  const state = { outcome: 'completed', turn: 1, seq: 3, time: 1, code: null, message: null }
  assert.equal(foldHubTurnOutcome(state, { type: 'turn/end', seq: 8, time: 2, data: {} }), state)
  assert.equal(foldHubTurnOutcome(state, { type: 'turn/end', seq: 8, time: 2, data: { reason: 'nope' } }), state)
  assert.equal(foldHubTurnOutcome(state, turnEndEvent('未知结局', 8)), state)
})

test('同一 seq 重放幂等', () => {
  const first = foldHubTurnOutcome(null, turnEndEvent('completed', 4))
  const replay = foldHubTurnOutcome(first, turnEndEvent('error', 4, { error: { code: 'X', message: 'y' } }))
  assert.equal(replay, first)
})

test('超长错误信息被截断', () => {
  const long = 'x'.repeat(500)
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 9, { error: { code: 'X', message: long } }))
  assert.equal(state.message.length, 201)
  assert.equal(state.message.endsWith('…'), true)
})

test('schema 接受合法状态并拒绝非法形状', () => {
  const good = { outcome: 'completed', turn: 0, seq: 0, time: 0, code: null, message: null }
  assert.equal(hubTurnOutcomeSchema.parse(good), good)
  assert.equal(hubTurnOutcomeSchema.parse(null), null)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, outcome: '瞎写' }), /非法的 outcome/)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, seq: -1 }), /seq/)
  assert.throws(() => hubTurnOutcomeSchema.parse({ ...good, code: 5 }), /code/)
  assert.throws(() => hubTurnOutcomeSchema.parse([good]), /对象或 null/)
})

test('状态可 JSON 往返', () => {
  const state = foldHubTurnOutcome(null, turnEndEvent('error', 11, { error: { code: 'A', message: 'B' } }))
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
})

test('apply 向注册表注册一个 stateVersion 为 1 的单元，并挂上路由', () => {
  let registered = null
  let routeRegistered = null
  let injectedDeps = null
  const disposers = []
  const ctx = {
    sessionProjections: { register: (definition) => { registered = definition } },
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => { disposers.push(callback()) },
    inject: (deps, callback) => {
      injectedDeps = deps
      callback({
        effect: (inner) => { disposers.push(inner()) },
        webServer: {
          register: (route) => {
            routeRegistered = route
            return () => {}
          },
        },
      })
    },
  }
  apply(ctx)
  assert.equal(registered.key, 'hubTurnOutcome')
  assert.equal(registered.stateVersion, 1)
  assert.equal(registered.init(), null)
  assert.equal(registered.apply, foldHubTurnOutcome)
  assert.equal(registered.wire.viewSchema, hubTurnOutcomeSchema)

  // webServer 是软依赖：不能进硬 inject（否则没有 web 服务器的组合整插件不激活）。
  assert.deepEqual(inject, ['sessionProjections'])
  assert.deepEqual(injectedDeps, ['webServer'])
  assert.equal(routeRegistered.kind, 'prefix')
  assert.equal(routeRegistered.path, ROUTE_PATH)
  assert.equal(typeof routeRegistered.handler, 'function')

  // 卸载时应当把前置器一起收拾掉。
  assert.equal(disposers.length, 2)
  for (const dispose of disposers) dispose()
})

/**
 * 构造一次路由调用。
 * @param {object} handler 路由处理器。
 * @param {string} method HTTP 方法。
 * @param {string} url 路径。
 * @param {object|undefined} body 请求体（提供时触发 data/end）。
 * @param {{ headers?: object }} [options] 请求头（缺省带合法签名头）。
 * @returns {object} 捕获到的 status/headers/body。
 */
function callRoute(handler, method, url, body, options = {}) {
  const captured = {}
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = options.headers ?? { [ROUTE_HEADER]: '1' }
  req.resume = () => {}
  req.destroy = () => {}
  const res = {
    writeHead: (status, headers) => { captured.status = status; captured.headers = headers },
    end: (payload) => { captured.body = payload === undefined ? undefined : JSON.parse(payload) },
  }
  handler(req, res)
  if (body !== undefined) {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }
  return captured
}

test('路由只认 POST，ping / debug / raise / warmup / taskbar / 未知动作各有明确回应', () => {
  const calls = []
  const raiser = {
    warmup: () => { calls.push('warmup'); return true },
    raise: (pid) => { calls.push(`raise:${pid}`); return true },
    overlay: (state, pid) => { calls.push(`overlay:${state}:${pid}`); return true },
    isRunning: () => false,
    overlayState: () => 'none',
  }
  const handler = createRouteHandler(raiser, () => ({ hostHalf: true, marked: 'diagnostics' }))

  const ping = callRoute(handler, 'POST', `${ROUTE_PATH}/ping`)
  assert.equal(ping.status, 200)
  assert.equal(ping.body.host, PLUGIN_ID)
  assert.equal(ping.body.projectionKey, 'hubTurnOutcome')
  assert.equal(ping.body.raiserRunning, false)
  assert.equal(ping.body.overlayState, 'none')
  // 能力标记：本构建带有 /jobs 动作（「后台任务」状态的数据源）。
  assert.equal(ping.body.jobsAction, true)
  // 版本必须与 package.json 一致（宿主半运行时读的就是它），否则两半版本标识会失真。
  assert.equal(ping.body.version, packageVersion())

  const debug = callRoute(handler, 'POST', `${ROUTE_PATH}/debug`)
  assert.equal(debug.status, 200)
  assert.deepEqual(debug.body, { hostHalf: true, marked: 'diagnostics' })

  const raise = callRoute(handler, 'POST', `${ROUTE_PATH}/raise`)
  assert.equal(raise.status, 200)
  assert.equal(raise.body.raised, true)
  assert.equal(calls[0], `raise:${resolveTargetProcessId()}`)

  const warm = callRoute(handler, 'POST', `${ROUTE_PATH}/warmup`)
  assert.equal(warm.status, 200)
  assert.deepEqual(warm.body, { warm: true })

  const taskbar = callRoute(handler, 'POST', `${ROUTE_PATH}/taskbar`, { state: 'red' })
  assert.equal(taskbar.status, 200)
  assert.deepEqual(taskbar.body, { ok: true, state: 'red' })
  assert.equal(calls[calls.length - 1], `overlay:red:${resolveTargetProcessId()}`)

  const invalid = callRoute(handler, 'POST', `${ROUTE_PATH}/taskbar`, { state: 'purple' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.reason, 'invalid-state')

  const bad = callRoute(handler, 'POST', `${ROUTE_PATH}/nope`)
  assert.equal(bad.status, 404)
  assert.equal(bad.body.error, 'unknown-action')

  const method = callRoute(handler, 'GET', `${ROUTE_PATH}/raise`)
  assert.equal(method.status, 405)
  assert.equal(method.body.error, 'method-not-allowed')

  // 查询串不影响动作解析。
  const query = callRoute(handler, 'POST', `${ROUTE_PATH}/raise?x=1`)
  assert.equal(query.status, 200)

  // 诊断回调抛异常也不能把路由打挂。
  const captured = callRoute(createRouteHandler(raiser, () => { throw new Error('诊断炸了') }),
    'POST', `${ROUTE_PATH}/debug`)
  assert.match(captured.body.error, /diagnostics failed/)
})

test('缺少签名头一律 403，且不触发任何窗口 / 任务栏动作', () => {
  const calls = []
  const raiser = {
    warmup: () => { calls.push('warmup'); return true },
    raise: (pid) => { calls.push(`raise:${pid}`); return true },
    overlay: (state, pid) => { calls.push(`overlay:${state}:${pid}`); return true },
    isRunning: () => false,
    overlayState: () => 'none',
  }
  const handler = createRouteHandler(raiser, () => ({ hostHalf: true }))

  for (const action of ['ping', 'debug', 'raise', 'warmup', 'taskbar', 'jobs']) {
    const body = action === 'taskbar' ? { state: 'red' } : undefined
    const res = callRoute(handler, 'POST', `${ROUTE_PATH}/${action}`, body, { headers: {} })
    assert.equal(res.status, 403, `${action} 缺签名头必须被拒`)
    assert.equal(res.body.error, 'forbidden')
    assert.equal(res.body.reason, 'missing-header')
  }
  assert.deepEqual(calls, [], '被拒的请求不得产生副作用')

  // 头名对但值不对同样拒。
  const wrongValue = callRoute(handler, 'POST', `${ROUTE_PATH}/raise`, undefined,
    { headers: { [ROUTE_HEADER]: 'yes' } })
  assert.equal(wrongValue.status, 403)

  // node 会把重复的头合并成数组：只要包含合法值就放行。
  const duplicated = callRoute(handler, 'POST', `${ROUTE_PATH}/ping`, undefined,
    { headers: { [ROUTE_HEADER]: ['1'] } })
  assert.equal(duplicated.status, 200)

  // 方法不对时仍先报 405：跨站预检（OPTIONS）应当得到 405 而不是「缺签名头」。
  const preflight = callRoute(handler, 'OPTIONS', `${ROUTE_PATH}/raise`, undefined, { headers: {} })
  assert.equal(preflight.status, 405)
})

test('/jobs 动作：回传聚合回调的结果，回调缺失或抛错时说清原因', () => {
  const raiser = {
    warmup: () => true,
    raise: () => true,
    overlay: () => true,
    isRunning: () => false,
    overlayState: () => 'none',
  }

  // 回调直接回传：路由只做转发与兜底，不加工内容。
  const ok = callRoute(createRouteHandler(raiser, undefined, () => ({
    sessions: [{ sessionId: 's1', jobs: [{ id: 'b1', label: 'npm run watch', status: 'running' }] }],
  })), 'POST', `${ROUTE_PATH}/jobs`)
  assert.equal(ok.status, 200)
  // 成功必须带 ok: true —— 客户端解析只认这个字段（0.5.0 曾漏掉，青点永远不出现）。
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.sessions[0].sessionId, 's1')
  assert.equal(ok.body.sessions[0].jobs[0].label, 'npm run watch')

  // 回调缺失（jobs / sessions 服务不在的自定义组合）：明确说「拿不到」，而不是空列表。
  const missing = callRoute(createRouteHandler(raiser, undefined, undefined), 'POST', `${ROUTE_PATH}/jobs`)
  assert.equal(missing.status, 200)
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.reason, 'jobs-unavailable')

  // 回调抛错：同样给 ok:false，绝不让路由 500。
  const boom = callRoute(createRouteHandler(raiser, undefined, () => { throw new Error('炸了') }),
    'POST', `${ROUTE_PATH}/jobs`)
  assert.equal(boom.status, 200)
  assert.equal(boom.body.ok, false)
  assert.match(boom.body.reason, /jobs snapshot failed/)
})

test('collectRunningJobs：只收「运行中 + 本会话拥有」的任务，label 有界截断', () => {
  let jobsHandler = null
  const disposers = []
  /** ctx.get 按服务名返回假实现：apply 里的聚合回调读 jobs / sessions 两个服务。 */
  const ctx = {
    sessionProjections: { register: () => {} },
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => { disposers.push(callback()) },
    get: (serviceName) => {
      if (serviceName === 'jobs') {
        return {
          // 所有者围栏之外的读法：任务统归 s1（回调里按 owner === sessionId 过滤），
          // 另有一条别人的任务，验证不会串到别的会话名下。
          list: () => [
            { id: 'bash-run', kind: 'bash', label: 'npm run watch', status: 'running', owner: 's1' },
            { id: 'bash-stop', kind: 'bash', label: 'stopping job', status: 'stopping', owner: 's1' },
            { id: 'bash-done', kind: 'bash', label: 'completed job', status: 'completed', owner: 's1' },
            { id: 'bash-foreign', kind: 'bash', label: 'elsewhere', status: 'running', owner: 'other-session' },
            { id: 'bash-long', kind: 'bash', label: 'x'.repeat(500), status: 'running', owner: 's1' },
          ],
        }
      }
      if (serviceName === 'sessions') {
        return { list: () => [{ id: 's1' }, { id: 's2' }] }
      }
      return undefined
    },
    inject: (deps, callback) => {
      callback({
        effect: (inner) => { disposers.push(inner()) },
        webServer: {
          register: (route) => { jobsHandler = route.handler; return () => {} },
        },
      })
    },
  }
  apply(ctx)
  assert.equal(typeof jobsHandler, 'function')

  const captured = callRoute(jobsHandler, 'POST', `${ROUTE_PATH}/jobs`)
  assert.equal(captured.status, 200)
  // s2 在注册表里没有任何「运行中 + 自己拥有」的任务，连条目都不该出现；
  // s1 只剩 running / stopping 两个（completed 与别人的任务都滤掉）。
  assert.deepEqual(captured.body.sessions.map((entry) => entry.sessionId), ['s1'])
  const [s1] = captured.body.sessions
  assert.equal(s1.jobs.length, 3)
  assert.deepEqual(s1.jobs.map((job) => job.status), ['running', 'stopping', 'running'])
  assert.equal(s1.jobs[0].label, 'npm run watch')
  // 超长 label 截到 200 字符 + 省略号（与错误 message 同一条上限）。
  assert.ok(s1.jobs[2].label.length <= 201, '超长 label 要被截断')

  // 单个会话读失败（注册表竞态）只跳过该会话，不影响其余聚合。
  ctx.get = (serviceName) => {
    if (serviceName === 'jobs') {
      return {
        list: (sessionId) => {
          if (sessionId === 's1') throw new Error('race')
          return [{ id: 'b2', label: 's2 job', status: 'running', owner: sessionId }]
        },
      }
    }
    if (serviceName === 'sessions') return { list: () => [{ id: 's1' }, { id: 's2' }] }
    return undefined
  }
  const partial = callRoute(jobsHandler, 'POST', `${ROUTE_PATH}/jobs`)
  assert.equal(partial.status, 200)
  assert.deepEqual(partial.body.sessions.map((entry) => entry.sessionId), ['s2'])
  assert.equal(partial.body.sessions[0].jobs[0].label, 's2 job')

  for (const dispose of disposers.splice(0)) dispose()
})

test('两半契约：宿主半 /jobs 的真实应答必须能被客户端半的真实解析器吃下', async () => {
  // 0.5.0 的教训：路由回 `{ sessions: [...] }` 而客户端解析要求 `ok === true`，
  // 两半各测各的都绿（e2e 的 fetch 桩用的是「理想形状」），合起来却是断的——
  // 青点永远不出现。这个用例把「宿主半路由的真实应答」直接喂给「客户端半的真实
  // 解析器」（src/hub-host.js 按构建脚本同样的方式内联加载），契约再漂移就在这里红。
  const here = dirname(fileURLToPath(import.meta.url))
  const hostSource = readFileSync(join(here, '..', 'src', 'hub-host.js'), 'utf8')
  const { createHostBridge } = new Function(
    'ROUTE_HEADER',
    'ROUTE_HEADER_VALUE',
    `${hostSource.replace(/^export\s+/gm, '')}\nreturn { createHostBridge }`,
  )(ROUTE_HEADER, ROUTE_HEADER_VALUE)

  /** 用真实路由应答驱动客户端桥接器；返回 [解析结果, 能力状态]。 */
  const parseThroughClient = async (routeResponse) => {
    const bridge = createHostBridge({
      pluginId: PLUGIN_ID,
      version: packageVersion(),
      getConfig: () => ({ raiseWindow: false }),
      isDesktopShell: () => false,
      isDisposed: () => false,
      fetchImpl: () => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(routeResponse),
      }),
    })
    const jobs = await bridge.fetchRunningJobs()
    return [jobs, bridge.jobsRouteState()]
  }

  const raiser = {
    warmup: () => true,
    raise: () => true,
    overlay: () => true,
    isRunning: () => false,
    overlayState: () => 'none',
  }

  // 成功路径：聚合回调 → 路由应答 → 客户端解析出任务表。
  const ok = callRoute(createRouteHandler(raiser, undefined, () => ({
    sessions: [
      { sessionId: 's1', jobs: [{ id: 'b1', label: 'npm run watch', status: 'running' }, { id: 'b2', label: 'build', status: 'stopping' }] },
      { sessionId: 's2', jobs: [] },
    ],
  })), 'POST', `${ROUTE_PATH}/jobs`)
  const [parsed, capability] = await parseThroughClient(ok.body)
  assert.deepEqual(parsed, { s1: { count: 2, label: 'npm run watch' } })
  assert.equal(capability, 'supported')

  // 空聚合（任务都结束了）：明确给 ok + 空 sessions，客户端清空任务表。
  const empty = callRoute(createRouteHandler(raiser, undefined, () => ({ sessions: [] })),
    'POST', `${ROUTE_PATH}/jobs`)
  const [parsedEmpty] = await parseThroughClient(empty.body)
  assert.deepEqual(parsedEmpty, {})

  // 服务不在（自定义组合）：ok:false 只算「这次没拿到」，不锁死降级。
  const unavailable = callRoute(createRouteHandler(raiser, undefined, undefined),
    'POST', `${ROUTE_PATH}/jobs`)
  const [parsedUnavailable, capabilityUnavailable] = await parseThroughClient(unavailable.body)
  assert.equal(parsedUnavailable, null)
  assert.equal(capabilityUnavailable, 'unknown')
})
