/**
 * 网关核心自检：真 HTTP 假上游 + 真路由 + 真回退 + 真断路器。
 *
 * 这一套的重点不是覆盖率，而是**把那些「错了会静默错」的行为钉死**：
 *
 *   - 回退是不是真的换了下一家，而不是把错误当答案；
 *   - 输掉的竞速者有没有被取消（不取消 = 白花 N 份钱）；
 *   - 竞速输家有没有被误记成失败（误记 = 很快全被拉闸）；
 *   - 请求本身的问题（400/413）有没有**停止**回退（不停止 = 白花配额）；
 *   - 断路器拉闸后是不是真的不再发起请求（不拉闸 = 每次都在等超时）。
 *
 * 运行：node gateway.test.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { HealthRegistry, BREAKER_STATE, countsTowardBreaker } from './gateway-breaker.js'
import {
  normalizeUpstreams,
  collectModels,
  upstreamServes,
  STRATEGY_IDS,
  DEFAULT_STRATEGY,
} from './gateway-model.js'
import { orderCandidates, runWithFallback, describeRoute, resetRoundRobin, isTerminalForRouting } from './gateway-router.js'
import { runGateway, describeGateway, upstreamsForModel } from './gateway.js'
import { adaptBodyForUpstream, baseModelId, upstreamHeaders } from './gateway-upstream.js'

let failures = 0
/** 跑一个用例，失败不中断其余用例。 */
async function test(name, body) {
  try {
    await body()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${error?.stack ?? error}`)
  }
}

/**
 * 起一个假上游。
 *
 * @param {object} behaviour - 行为。
 * @param {number} [behaviour.status] - 非 200 时直接回这个状态码。
 * @param {string[]} [behaviour.frames] - 200 时发这些 SSE 数据帧。
 * @param {number} [behaviour.delayMs] - 多久之后才开始回。
 * @param {number} [behaviour.trailingDelayMs] - 发完内容帧后隔多久才结束流。
 *   用来模拟「开始答了但很慢」的上游——竞速里它是必然被掐断的那个。
 * @param {boolean} [behaviour.hang] - 是否一直不回（测超时）。
 * @param {string} [behaviour.errorBody] - 非 200 时的响应体。
 * @returns {Promise<object>} 句柄。
 */
async function fakeUpstream(behaviour = {}) {
  const requests = []
  let cutOff = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    // 「被掐断」的判定必须看 res 的 close 且响应未写完：
    // req 的 'aborted' 事件在这个场景下不会触发（请求体早就发完了），
    // 用它会得出「取消没生效」的错误结论。
    res.on('close', () => { if (!res.writableEnded) cutOff += 1 })
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      const start = () => {
        if (behaviour.hang === true) return
        if (behaviour.status !== undefined && behaviour.status !== 200) {
          res.writeHead(behaviour.status, { 'content-type': 'application/json' })
          res.end(behaviour.errorBody ?? JSON.stringify({ error: { message: 'upstream says no', code: 'boom' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const frame of behaviour.frames ?? ['{"choices":[{"delta":{"content":"好"},"finish_reason":null}]}']) {
          res.write(`data: ${frame}\n\n`)
        }
        const finish = () => {
          if (res.writableEnded) return
          res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        }
        if (behaviour.trailingDelayMs !== undefined) setTimeout(finish, behaviour.trailingDelayMs)
        else finish()
      }
      if (behaviour.delayMs !== undefined) setTimeout(start, behaviour.delayMs)
      else start()
    })
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${String(server.address().port)}/v1`
  return {
    origin,
    requests,
    /** 响应还没写完就被切断的次数——竞速里输家应当 >= 1。 */
    get cutOff() { return cutOff },
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}

/** 把一条流跑完，收集所有 chunk。 */
async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** 从一个上游句柄造一个配置条目。 */
function entry(id, origin, extra = {}) {
  return { id, name: id, baseURL: origin, apiKey: 'k', models: [{ id: 'm', name: 'm' }], ...extra }
}

/** 造一个网关配置快照。 */
function snapshotOf(upstreams, extra = {}) {
  return {
    upstreams,
    strategy: DEFAULT_STRATEGY,
    raceEnabled: false,
    raceWidth: 2,
    maxTokensOverride: 0,
    reasoningEffort: undefined,
    lastGoodId: undefined,
    ...extra,
  }
}

/** 一个最小的 GenerateOptions。 */
function callOptions(model = 'm') {
  return { provider: 'omniroute', model, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }
}

console.log('网关核心自检')

// ─────────────────────────── 模型与配置 ───────────────────────────

await test('normalizeUpstreams：丢掉坏条目、去重、无上游时补内置', () => {
  const { upstreams, rejected } = normalizeUpstreams([
    { id: 'a', baseURL: 'http://x.example/v1' },
    { id: 'b', baseURL: 'not-a-url' },
    { id: 'a', baseURL: 'http://y.example/v1' },
    { id: 'bad id!', baseURL: 'http://z.example/v1' },
  ])
  assert.deepEqual(upstreams.map(u => u.id), ['a'])
  assert.equal(rejected.length, 3)

  const empty = normalizeUpstreams([])
  assert.equal(empty.upstreams.length, 1)
  assert.equal(empty.upstreams[0].builtin, true, '没有任何上游时必须补上内置免密钥上游')
})

await test('normalizeUpstreams：地址末尾斜杠被归一，默认值被填上', () => {
  const { upstreams } = normalizeUpstreams([{ id: 'a', baseURL: 'http://x.example/v1///' }])
  assert.equal(upstreams[0].baseURL, 'http://x.example/v1')
  assert.equal(upstreams[0].enabled, true)
  assert.equal(upstreams[0].breakerThreshold, 3)
  assert.equal(upstreams[0].weight, 1)
})

await test('upstreamServes：空模型列表 = 什么都接', () => {
  assert.equal(upstreamServes({ models: [] }, 'anything'), true)
  assert.equal(upstreamServes({ models: [{ id: 'a' }] }, 'a'), true)
  assert.equal(upstreamServes({ models: [{ id: 'a' }] }, 'b'), false)
})

await test('collectModels：同一模型被多家服务时取最大容量', () => {
  const models = collectModels([
    { id: 'u1', enabled: true, models: [{ id: 'm', name: 'm', contextWindow: 8000 }] },
    { id: 'u2', enabled: true, models: [{ id: 'm', name: 'm', contextWindow: 32000 }] },
  ])
  assert.equal(models.length, 1)
  assert.equal(models[0].contextWindow, 32000)
  assert.deepEqual(models[0].servedBy, ['u1', 'u2'])
})

// ─────────────────────────── 断路器 ───────────────────────────

await test('断路器：连续失败到阈值才拉闸，成功一次就归零', () => {
  const health = new HealthRegistry()
  const record = health.for('u')
  assert.equal(record.admit({ cooldownMs: 1000 }, 0).allowed, true)

  record.recordFailure({ code: 'SERVER', threshold: 3, cooldownMs: 1000 }, 0)
  record.recordFailure({ code: 'SERVER', threshold: 3, cooldownMs: 1000 }, 1)
  assert.equal(record.state, BREAKER_STATE.closed, '两次还不够，阈值是三次')
  record.recordFailure({ code: 'SERVER', threshold: 3, cooldownMs: 1000 }, 2)
  assert.equal(record.state, BREAKER_STATE.open)

  // 拉闸期间不允许
  assert.equal(record.admit({ cooldownMs: 1000 }, 3).allowed, false)
  // 冷却结束后放一个探测
  const probe = record.admit({ cooldownMs: 1000 }, 2000)
  assert.equal(probe.allowed, true)
  assert.equal(probe.halfOpen, true)
  // 探测在飞时不再放第二个
  assert.equal(record.admit({ cooldownMs: 1000 }, 2000).allowed, false)
})

await test('断路器：请求本身的问题不计入，避免因坏输入拉闸', () => {
  assert.equal(countsTowardBreaker('REQUEST'), false, '请求体非法换谁都一样')
  assert.equal(countsTowardBreaker('CONTEXT_WINDOW_EXCEEDED'), false)
  assert.equal(countsTowardBreaker('NO_MODEL'), false)
  assert.equal(countsTowardBreaker('ABORTED'), false, '用户主动取消不是上游的错')
  // 其余一律计入——包括上游自定义的错误码。
  //
  // 这条断言来自一次真实的翻车：默认写成「不认识就不计入」时，
  // 上游用 `200 + 流内 error` 报的错（错误码必然是自定义的字符串，
  // 比如 upstream_boom）全被静默丢弃，断路器永远不拉闸，
  // 于是每次请求都要先去撞一遍那个坏掉的上游。
  assert.equal(countsTowardBreaker('SERVER'), true)
  assert.equal(countsTowardBreaker('AUTH'), true, '密钥失效正是该换别家的场景')
  assert.equal(countsTowardBreaker('upstream_boom'), true, '上游自定义的错误码必须计入')
  assert.equal(countsTowardBreaker('SOMETHING_NEW'), true)

  const health = new HealthRegistry()
  const record = health.for('u')
  const counted = record.recordFailure({ code: 'REQUEST', threshold: 1, cooldownMs: 1000 }, 0)
  assert.equal(counted, false)
  assert.equal(record.state, BREAKER_STATE.closed)
})

await test('断路器：successRate 在无样本时返回 undefined 而不是 1 或 0', () => {
  const health = new HealthRegistry()
  const record = health.for('u')
  assert.equal(record.successRate(), undefined, '「还不知道」必须与「全都失败」可区分')
  record.recordSuccess(100, 0)
  assert.equal(record.successRate(), 1)
})

await test('断路器：窗口滑动，旧结果不永远压着', () => {
  const health = new HealthRegistry({ windowSize: 3 })
  const record = health.for('u')
  for (let index = 0; index < 3; index += 1) record.recordFailure({ code: 'SERVER', threshold: 99, cooldownMs: 1 }, index)
  assert.equal(record.successRate(), 0)
  for (let index = 0; index < 3; index += 1) record.recordSuccess(10, index)
  assert.equal(record.successRate(), 1, '三次成功应把窗口里的失败全挤出去')
})

// ─────────────────────────── 路由策略 ───────────────────────────

await test('策略：priority 与 lkgp 的排序', () => {
  const health = new HealthRegistry()
  const upstreams = [
    { id: 'a', name: 'a', enabled: true, models: [], weight: 1, breakerCooldownMs: 1000 },
    { id: 'b', name: 'b', enabled: true, models: [], weight: 1, breakerCooldownMs: 1000 },
    { id: 'c', name: 'c', enabled: true, models: [], weight: 1, breakerCooldownMs: 1000 },
  ]
  const priority = orderCandidates({ upstreams, model: 'm', strategy: 'priority', health, now: 0 })
  assert.deepEqual(priority.candidates.map(c => c.upstream.id), ['a', 'b', 'c'])

  const lkgp = orderCandidates({ upstreams, model: 'm', strategy: 'lkgp', health, lastGoodId: 'c', now: 0 })
  assert.deepEqual(lkgp.candidates.map(c => c.upstream.id), ['c', 'a', 'b'], '上次好的提到最前，其余保持配置顺序')
})

await test('策略：被排除的候选都带原因（界面要能回答「为什么没用它」）', () => {
  const health = new HealthRegistry()
  const upstreams = [
    { id: 'off', name: '停用的', enabled: false, models: [], breakerCooldownMs: 1000 },
    { id: 'nomodel', name: '不服务此模型', enabled: true, models: [{ id: 'other' }], breakerCooldownMs: 1000 },
    { id: 'ok', name: '好的', enabled: true, models: [], breakerCooldownMs: 1000 },
  ]
  const result = orderCandidates({ upstreams, model: 'm', strategy: 'priority', health, now: 0 })
  assert.deepEqual(result.candidates.map(c => c.upstream.id), ['ok'])
  const reasons = Object.fromEntries(result.excluded.map(e => [e.id, e.reason]))
  assert.match(reasons.off, /停用/)
  assert.match(reasons.nomodel, /未声明服务模型 m/)
})

await test('策略：轮询会把首选往后挪', () => {
  resetRoundRobin()
  const health = new HealthRegistry()
  const upstreams = ['a', 'b', 'c'].map(id => ({ id, name: id, enabled: true, models: [], breakerCooldownMs: 1000 }))
  const pick = () => orderCandidates({ upstreams, model: 'm', strategy: 'round-robin', health, now: 0 }).candidates[0].upstream.id
  const seen = [pick(), pick(), pick(), pick()]
  assert.deepEqual(seen, ['a', 'b', 'c', 'a'], '轮询必须跨请求记住上次轮到谁')
  resetRoundRobin()
})

await test('策略：cost-first 按价格排，没配价格的排最后', () => {
  const health = new HealthRegistry()
  const upstreams = [
    { id: 'pricey', name: 'p', enabled: true, models: [], breakerCooldownMs: 1000, inputPricePerMTok: 10, outputPricePerMTok: 30 },
    { id: 'noprice', name: 'n', enabled: true, models: [], breakerCooldownMs: 1000 },
    { id: 'cheap', name: 'c', enabled: true, models: [], breakerCooldownMs: 1000, inputPricePerMTok: 1, outputPricePerMTok: 2 },
  ]
  const result = orderCandidates({ upstreams, model: 'm', strategy: 'cost-first', health, now: 0 })
  assert.deepEqual(result.candidates.map(c => c.upstream.id), ['cheap', 'pricey', 'noprice'])
})

await test('策略：least-latency 全序，「没测过」不插队', () => {
  const health = new HealthRegistry()
  health.for('slow').recordSuccess(900, 0)
  health.for('fast').recordSuccess(100, 0)
  const upstreams = [
    { id: 'slow', name: 's', enabled: true, models: [], breakerCooldownMs: 1000 },
    { id: 'fast', name: 'f', enabled: true, models: [], breakerCooldownMs: 1000 },
    { id: 'unknown', name: 'u', enabled: true, models: [], breakerCooldownMs: 1000 },
  ]
  const result = orderCandidates({ upstreams, model: 'm', strategy: 'least-latency', health, now: 0 })
  assert.deepEqual(result.candidates.map(c => c.upstream.id), ['fast', 'slow', 'unknown'],
    '没测过的排在有数据的之后，否则刚积累的延迟数据就废了')
})

await test('策略：weighted 产出一个完整顺序且用尽所有候选', () => {
  const health = new HealthRegistry()
  const upstreams = [
    { id: 'a', name: 'a', enabled: true, models: [], weight: 9, breakerCooldownMs: 1000 },
    { id: 'b', name: 'b', enabled: true, models: [], weight: 1, breakerCooldownMs: 1000 },
  ]
  const result = orderCandidates({ upstreams, model: 'm', strategy: 'weighted', health, now: 0, random: () => 0 })
  assert.equal(result.candidates.length, 2, '回退链必须覆盖所有候选，不能只挑一个')
  assert.equal(result.candidates[0].upstream.id, 'a', 'random=0 时应选中权重最高的')
})

// ─────────────────────────── 回退语义 ───────────────────────────

await test('回退：请求本身的问题立刻停止，不浪费下一家的配额', async () => {
  const tried = []
  const outcome = await runWithFallback({
    candidates: [
      { upstream: { id: 'a', name: 'a', breakerThreshold: 3, breakerCooldownMs: 1000 }, health: new HealthRegistry().for('a') },
      { upstream: { id: 'b', name: 'b', breakerThreshold: 3, breakerCooldownMs: 1000 }, health: new HealthRegistry().for('b') },
    ],
    attempt: async candidate => {
      tried.push(candidate.upstream.id)
      return { ok: false, code: 'REQUEST', message: '请求体非法' }
    },
  })
  assert.deepEqual(tried, ['a'], '400 类错误换一家也一样，必须停')
  assert.equal(outcome.terminal, true)
})

await test('回退：鉴权失败继续换，这正是多上游的价值', async () => {
  const tried = []
  const outcome = await runWithFallback({
    candidates: [
      { upstream: { id: 'a', name: 'a', breakerThreshold: 3, breakerCooldownMs: 1000 }, health: new HealthRegistry().for('a') },
      { upstream: { id: 'b', name: 'b', breakerThreshold: 3, breakerCooldownMs: 1000 }, health: new HealthRegistry().for('b') },
    ],
    attempt: async candidate => {
      tried.push(candidate.upstream.id)
      return candidate.upstream.id === 'a'
        ? { ok: false, code: 'AUTH', message: '密钥无效' }
        : { ok: true, value: '好' }
    },
  })
  assert.deepEqual(tried, ['a', 'b'])
  assert.equal(outcome.ok, true)
})

await test('回退：全部失败时返回最后一个失败（它最能说明现状）', async () => {
  const outcome = await runWithFallback({
    candidates: ['a', 'b', 'c'].map(id => ({
      upstream: { id, name: id, breakerThreshold: 99, breakerCooldownMs: 1000 },
      health: new HealthRegistry().for(id),
    })),
    attempt: async candidate => ({ ok: false, code: 'SERVER', message: `${candidate.upstream.id} 挂了` }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts.length, 3)
  assert.match(outcome.failure.message, /c 挂了/)
})

await test('回退说明：只在真的回退过时才生成', () => {
  assert.equal(describeRoute([{ ok: true, upstreamName: 'a' }]), undefined, '一次就成功不该往对话里塞噪音')
  const note = describeRoute([
    { ok: false, upstreamName: 'a', code: 'SERVER' },
    { ok: true, upstreamName: 'b' },
  ])
  assert.match(note, /前 1 个上游失败/)
  assert.match(note, /已改用 b/)
})

await test('isTerminalForRouting 的分界', () => {
  assert.equal(isTerminalForRouting('REQUEST'), true)
  assert.equal(isTerminalForRouting('CONTEXT_WINDOW_EXCEEDED'), true)
  assert.equal(isTerminalForRouting('AUTH'), false, '鉴权失败要换下一家')
  assert.equal(isTerminalForRouting('SERVER'), false)
})

await test('内置上游必须预置模型，且必须带齐行为字段', () => {
  const { upstreams } = normalizeUpstreams([])
  const builtin = upstreams.find(entry => entry.builtin === true)
  assert.ok(builtin !== undefined, '无上游时必须补上内置那条')

  // 这一条来自一次真实的翻车：内置上游的 models 留空时，「空列表 =
  // 接受任何模型」这个语义会让模型并集为空——用户看得见 provider，
  // 却点不出任何模型可用，正好破坏了「装上就能用」这个第一体验目标。
  assert.ok((builtin.models ?? []).length > 0, '内置上游必须声明至少一个模型')

  // 这一条来自另一次真实的翻车：内置常量直接 `{...}` 展开就 push，
  // 绕过了 normalizeUpstream，于是 timeoutMs 是 undefined，
  // `setTimeout(…, undefined)` 立刻超时——发出去就报「undefinedms 内没有响应」。
  // 所以行为字段必须由归一化补齐。
  for (const field of ['timeoutMs', 'breakerThreshold', 'breakerCooldownMs', 'weight']) {
    assert.equal(typeof builtin[field], 'number', `内置上游缺少行为字段 ${field}`)
    assert.ok(builtin[field] > 0, `${field} 必须是正数`)
  }
})

await test('内置免密钥通道：预置模型能被选出来（并集非空）', () => {
  const { upstreams } = normalizeUpstreams([])
  const models = collectModels(upstreams)
  assert.ok(models.length > 0, '内置上游的模型必须出现在并集里')
  assert.ok(models.every(model => model.servedBy.includes('builtin-free')))
})

// ─────────────────────────── 端到端：真 HTTP ───────────────────────────

await test('端到端：第一家挂了自动换第二家，答案来自第二家', async () => {
  const dead = await fakeUpstream({ status: 500 })
  const alive = await fakeUpstream({ frames: ['{"choices":[{"delta":{"content":"我是第二家"}}]}'] })
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([entry('dead', dead.origin), entry('alive', alive.origin)])
    const routes = []
    const chunks = await drain(runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      options: callOptions(),
      snapshot: snapshotOf(upstreams),
      health,
      onRoute: facts => routes.push(facts),
    }))

    assert.equal(chunks.find(c => c.type === 'block-end')?.block.text, '我是第二家')
    assert.equal(dead.requests.length, 1)
    assert.equal(alive.requests.length, 1)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].upstreamName, 'alive')
    assert.match(routes[0].routeNote, /前 1 个上游失败/)
    assert.equal(health.for('dead').totals.failure, 1)
    assert.equal(health.for('alive').totals.success, 1)
  } finally {
    await dead.close(); await alive.close()
  }
})

await test('端到端：200 但流内报错，也必须回退（不能把错误当答案）', async () => {
  const liar = await fakeUpstream({ frames: ['{"error":{"message":"上游内部炸了","code":"upstream_boom"}}'] })
  const honest = await fakeUpstream({ frames: ['{"choices":[{"delta":{"content":"正常答案"}}]}'] })
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([entry('liar', liar.origin), entry('honest', honest.origin)])
    const chunks = await drain(runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      options: callOptions(),
      snapshot: snapshotOf(upstreams),
      health,
    }))
    assert.equal(chunks.find(c => c.type === 'block-end')?.block.text, '正常答案')
    assert.equal(health.for('liar').totals.failure, 1, 'HTTP 200 但流内报错，仍算这家失败')
  } finally {
    await liar.close(); await honest.close()
  }
})

await test('端到端：断路器拉闸后不再向那家发起请求', async () => {
  const dead = await fakeUpstream({ status: 500 })
  const alive = await fakeUpstream()
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([
      entry('dead', dead.origin, { breakerThreshold: 1 }),
      entry('alive', alive.origin),
    ])
    const snapshot = snapshotOf(upstreams)
    // 第一次：dead 失败一次即拉闸（阈值 1），回退到 alive
    await drain(runGateway({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }], options: callOptions(), snapshot, health }))
    assert.equal(dead.requests.length, 1)
    assert.equal(health.for('dead').state, BREAKER_STATE.open)

    // 第二次：dead 已被拉闸，不该再被请求
    await drain(runGateway({ messages: [{ role: 'user', content: [{ type: 'text', text: 'b' }] }], options: callOptions(), snapshot, health }))
    assert.equal(dead.requests.length, 1, '拉闸的意义就是不再去撞它')
    assert.equal(alive.requests.length, 2)
  } finally {
    await dead.close(); await alive.close()
  }
})

await test('端到端：全部上游失败时给出明确失败，而不是空回答', async () => {
  const a = await fakeUpstream({ status: 503 })
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([entry('a', a.origin)])
    const chunks = await drain(runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      options: callOptions(),
      snapshot: snapshotOf(upstreams),
      health,
    }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'error')
    assert.match(chunks[0].reason.failure.message, /a 返回 HTTP 503/)
  } finally {
    await a.close()
  }
})

await test('端到端：没有可用上游时说清为什么（而不是静默失败）', async () => {
  const health = new HealthRegistry()
  const { upstreams } = normalizeUpstreams([entry('off', 'http://127.0.0.1:1/v1', { enabled: false })])
  const chunks = await drain(runGateway({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    options: callOptions(),
    snapshot: snapshotOf(upstreams),
    health,
  }))
  assert.equal(chunks[0].reason.failure.code, 'NO_UPSTREAM')
  assert.match(chunks[0].reason.failure.message, /已停用/)
})

await test('端到端：竞速取最快，且输家被取消（不白花 N 份钱）', async () => {
  // 输家要同时满足两件事才会在赢家出现时「还写着」：
  //   - delayMs：它更晚才开始回（所以它不是赢家）；
  //   - trailingDelayMs：它开始回之后拖很久才结束（所以取消时有东西可掐）。
  // 只设后者是不够的——那样它反而会瞬间回完并成为赢家。
  const slow = await fakeUpstream({ delayMs: 80, trailingDelayMs: 1500 })
  const fast = await fakeUpstream({ delayMs: 5, frames: ['{"choices":[{"delta":{"content":"快"}}]}'] })
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([entry('slow', slow.origin), entry('fast', fast.origin)])
    const routes = []
    const chunks = await drain(runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      options: callOptions(),
      snapshot: snapshotOf(upstreams, { raceEnabled: true, raceWidth: 2 }),
      health,
      onRoute: facts => routes.push(facts),
    }))
    assert.equal(chunks.find(c => c.type === 'block-end')?.block.text, '快')
    assert.equal(routes[0].raced, true)
    assert.equal(routes[0].upstreamName, 'fast')
    // 给取消一点时间传播到服务端
    await new Promise(resolve => { setTimeout(resolve, 300) })
    assert.ok(slow.cutOff >= 1, '输家必须被 abort，否则它跑完照样计费')
  } finally {
    await slow.close(); await fast.close()
  }
})

await test('端到端：竞速输家不被记成失败（否则很快全被拉闸）', async () => {
  const slow = await fakeUpstream({ delayMs: 200 })
  const fast = await fakeUpstream({ delayMs: 5 })
  try {
    const health = new HealthRegistry()
    const { upstreams } = normalizeUpstreams([entry('slow', slow.origin), entry('fast', fast.origin)])
    await drain(runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      options: callOptions(),
      snapshot: snapshotOf(upstreams, { raceEnabled: true, raceWidth: 2 }),
      health,
    }))
    assert.equal(health.for('slow').totals.failure, 0, '竞速里输掉是预期行为，不是上游有病')
    assert.equal(health.for('slow').state, BREAKER_STATE.closed)
  } finally {
    await slow.close(); await fast.close()
  }
})

// ─────────────────────────── 上游方言 ───────────────────────────

await test('免密钥通道：指纹头与工具四元组都被补上', () => {
  const upstream = { id: 'b', name: 'b', kind: 'opencode-free', baseURL: 'https://x.example/v1', apiKey: '' }
  const headers = upstreamHeaders(upstream, { stream: true, sessionId: 'ses_x', requestId: 'msg_y' })
  assert.equal(headers['x-opencode-client'], 'desktop')
  assert.equal(headers['x-opencode-session'], 'ses_x')
  assert.equal(headers.authorization, 'Bearer public', '池化凭据')
  assert.match(headers['user-agent'], /^opencode\/1\./)

  const body = adaptBodyForUpstream({ model: 'm', messages: [], tools: [] }, upstream, [])
  const names = body.tools.map(tool => tool.function.name)
  for (const required of ['bash', 'glob', 'grep', 'read']) {
    assert.ok(names.includes(required), `缺了指纹工具 ${required} 会被 403`)
  }
})

await test('免密钥通道：不删调用方自己的工具', () => {
  const upstream = { id: 'b', kind: 'opencode-free', baseURL: 'https://x.example/v1' }
  const body = adaptBodyForUpstream(
    { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'pwsh', description: '', parameters: {} } }] },
    upstream,
    [],
  )
  const names = body.tools.map(tool => tool.function.name)
  assert.ok(names.includes('pwsh'), '调用方真正需要的工具不能被删掉')
  assert.ok(names.includes('bash'))
})

await test('普通上游：不加指纹头，用配置里的密钥', () => {
  const upstream = { id: 'o', kind: undefined, baseURL: 'https://api.example/v1', apiKey: 'sk-abc' }
  const headers = upstreamHeaders(upstream, { stream: true })
  assert.equal(headers.authorization, 'Bearer sk-abc')
  assert.equal(headers['x-opencode-client'], undefined)
})

await test('baseModelId：去掉思考档位后缀', () => {
  assert.equal(baseModelId('gpt-4o(high)'), 'gpt-4o')
  assert.equal(baseModelId('gpt-4o'), 'gpt-4o')
})

// ─────────────────────────── 界面视图 ───────────────────────────

await test('describeGateway：给出上游健康与模型并集', () => {
  const health = new HealthRegistry()
  health.for('a').recordSuccess(120, 0)
  health.for('a').recordFailure({ code: 'SERVER', threshold: 5, cooldownMs: 1000 }, 1)
  const { upstreams } = normalizeUpstreams([entry('a', 'http://x.example/v1')])
  const view = describeGateway(snapshotOf(upstreams), health, 0)
  assert.equal(view.upstreams.length, 1)
  assert.equal(view.upstreams[0].builtin, false)
  assert.equal(view.upstreams[0].hasApiKey, true)
  assert.equal(view.upstreams[0].health.totals.success, 1)
  assert.equal(view.upstreams[0].health.totals.failure, 1)
  assert.equal(view.models.length, 1)
  assert.equal(view.strategy, 'priority')
})

await test('upstreamsForModel：找出谁能服务这个模型', () => {
  const { upstreams } = normalizeUpstreams([
    entry('a', 'http://a.example/v1'),
    { id: 'b', baseURL: 'http://b.example/v1', models: [{ id: 'other' }] },
  ])
  assert.deepEqual(upstreamsForModel(snapshotOf(upstreams), 'm'), ['a'])
})

await test('STRATEGIES 的 id 与描述都是完整的', () => {
  for (const strategy of STRATEGY_IDS) assert.equal(typeof strategy, 'string')
  assert.ok(STRATEGY_IDS.includes(DEFAULT_STRATEGY))
})

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 个用例失败`)
process.exitCode = failures === 0 ? 0 : 1
