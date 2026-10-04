/**
 * 网关核心：把「请求 → 路由 → 上游 → 流」这四步接起来。
 *
 * 这是这个插件从「接入层」变成「网关」的所在。适配器（adapter.js）
 * 只负责协议翻译，这个模块负责**决策**：发给谁、失败了换谁、
 * 什么时候并行、什么时候放弃。
 *
 * ## 一次请求的完整生命周期
 *
 * ```
 *   GenerateOptions
 *        │  组装 OpenAI 请求体（transport.buildRequestBody）
 *        ▼
 *   orderCandidates  ──▶ 候选顺序 + 被排除的原因
 *        │
 *        ▼
 *   runWithFallback  ──▶ 依次尝试（或并行竞速）
 *        │                 每个候选：postStream → frames()
 *        ▼
 *   translator       ──▶ StreamChunk（transport.createTranslator）
 *        │
 *        ▼
 *   AsyncIterable<StreamChunk>
 * ```
 *
 * ## 为什么回退判定要看「流里的第一个真实事件」而不是 HTTP 状态
 *
 * HTTP 200 **不等于**成功。上游经常用 200 + 流内 error 帧来报错
 * （尤其是套了一层网关的时候）。所以一次尝试的「成功」判定被推迟到
 * 读到第一个**有内容的**帧为止：
 *
 *   - 读到内容 → 这次尝试成功，开始向外吐 chunk；
 *   - 读到 error 帧或流直接结束且没内容 → 这次尝试失败，回退到下一家。
 *
 * 这就是 `attempt` 里那个「先探一帧」的逻辑。它带来的唯一代价是
 * 首字节延迟增加一次读取，而那远小于「把错误当答案吐给用户」的代价。
 *
 * ## 并行竞速为什么不默认开
 *
 * 同一个请求发给 N 家，只有 1 个答案被采用，另外 N-1 个是**已经产生的
 * 真实计费**。所以它默认关闭，且开启时界面上要明确提示这一点。
 * 它真正划算的场景是「首字节延迟比钱重要」，而不是日常使用。
 *
 * @module omniroute/gateway
 */

import { createTranslator, buildRequestBody } from './transport.js'
import { orderCandidates, runWithFallback, describeRoute } from './gateway-router.js'
import { postStream, baseModelId } from './gateway-upstream.js'
import { collectModels, upstreamServes } from './gateway-model.js'

/**
 * 一次尝试：向一个候选上游发起请求，并探到第一个真实事件。
 *
 * 「探到第一个真实事件」是这里的核心：只有它能区分
 * 「上游真的开始答了」和「上游用 200 包了一个错误」。
 *
 * @param {object} input - 输入。
 * @param {object} input.candidate - 候选（含 upstream 与 health）。
 * @param {object} input.options - harness 的 GenerateOptions。
 * @param {object} input.snapshot - 本次请求绑定的网关配置快照。
 * @param {AbortSignal|undefined} input.signal - 取消信号。
 * @returns {Promise<object>} `{ok: true, stream}` 或 `{ok: false, code, message}`。
 */
async function attemptUpstream(input) {
  const { candidate, options, snapshot, signal } = input
  const upstream = candidate.upstream

  const body = buildRequestBody({
    model: baseModelId(options.model),
    system: options.system,
    messages: input.messages,
    tools: options.tools,
    temperature: options.temperature,
    maxTokens: snapshot.maxTokensOverride > 0 ? snapshot.maxTokensOverride : options.maxTokens,
  })
  if (snapshot.reasoningEffort !== undefined && options.reasoningEffort !== undefined) {
    body.reasoning_effort = String(options.reasoningEffort)
  }

  const posted = await postStream({
    upstream,
    body,
    callerTools: options.tools,
    sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
    signal,
  })
  if (posted.ok !== true) return posted

  // 探第一帧：区分「真的开始答了」与「200 包了个错误」。
  const frames = posted.frames()
  let probe
  try {
    probe = await frames.next()
  } catch (error) {
    return {
      ok: false,
      code: signal?.aborted === true ? 'ABORTED' : 'TRANSPORT',
      message: `读取 ${upstream.name} 的流失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (probe.done === true) {
    return {
      ok: false,
      code: 'EMPTY_RESPONSE',
      message: `${upstream.name} 没有返回任何内容`,
    }
  }

  const first = probe.value.chunk
  if (first?.error !== undefined) {
    return {
      ok: false,
      code: typeof first.error.code === 'string' && first.error.code !== '' ? first.error.code : 'SERVER',
      message: `${upstream.name} 在流内报错：${typeof first.error.message === 'string' ? first.error.message : '未给出原因'}`,
    }
  }

  return {
    ok: true,
    upstream,
    headers: posted.headers,
    /**
     * 把这一家的帧流翻译成 harness 的 StreamChunk。
     *
     * `first` 是探测时已经取走的那一帧，必须**先吐出去**——
     * 丢掉它就是丢掉模型答案的第一个字。
     *
     * @param {object|undefined} facts - 网关自己记录的路由事实（写进 replayState）。
     * @yields {object} StreamChunk。
     */
    async * translate(facts) {
      const translator = createTranslator()
      // 先处理探测时取走的那一帧。
      for (const out of translator.push(first)) yield out
      if (first.usage !== undefined || first.finishReason !== undefined) {
        // 这一帧同时带 usage/finish：说明整个回答只有这一帧，继续读会立刻结束。
      }
      for await (const frame of frames) {
        if (frame.done === true) break
        const chunk = frame.chunk
        if (chunk?.error !== undefined) {
          // 流中途出错：此时已经有内容吐出去了，不能再回退，
          // 只能把失败如实报告成终止原因。
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: `${facts?.upstreamName ?? '上游'} 在流中途报错：${typeof chunk.error.message === 'string' ? chunk.error.message : '未给出原因'}`,
                code: typeof chunk.error.code === 'string' && chunk.error.code !== '' ? chunk.error.code : 'SERVER',
              },
            },
          }
          return
        }
        for (const out of translator.push(chunk)) yield out
      }
      // `finish` 自己会把这份事实包成 replayState 信封，所以这里传**裸的**
      // 事实对象；再包一层 `{omniroute: …}` 会变成双层嵌套，
      // 读的人得写 `replayState.response.omniroute.omniroute` 才拿得到。
      for (const out of translator.finish(facts)) yield out
    },
    sawContent: () => true,
  }
}

/**
 * 跑一次网关请求。
 *
 * @param {object} input - 输入。
 * @param {Array} input.messages - 已经处理过图片的 harness 消息列表。
 * @param {object} input.options - harness 的 GenerateOptions。
 * @param {object} input.snapshot - 网关配置快照。
 * @param {import('./gateway-breaker.js').HealthRegistry} input.health - 健康记录。
 * @param {AbortSignal|undefined} input.signal - 取消信号。
 * @param {() => number} [input.random] - 随机源（测试用）。
 * @param {number} [input.now] - 当前时刻（测试用）。
 * @returns {AsyncIterable<object>} StreamChunk 流。
 */
export function runGateway(input) {
  const self = { ...input }
  return {
    [Symbol.asyncIterator]() {
      return self.snapshot.raceEnabled === true
        ? raceStream(self)
        : fallbackStream(self)
    },
  }
}

/**
 * 顺序回退：默认路径。
 *
 * @param {object} input - 与 {@link runGateway} 相同的输入。
 * @yields {object} StreamChunk。
 */
async function* fallbackStream(input) {
  const { options, snapshot, health, signal } = input
  const model = baseModelId(options.model)

  const ordered = orderCandidates({
    upstreams: snapshot.upstreams,
    model,
    strategy: snapshot.strategy,
    health,
    lastGoodId: snapshot.lastGoodId,
    now: input.now,
    random: input.random,
  })

  if (ordered.candidates.length === 0) {
    yield { type: 'finish', reason: { kind: 'error', failure: noCandidateFailure(model, ordered.excluded) } }
    return
  }

  const attempts = []
  // 用一个只跑一次、把流交出来的壳：runWithFallback 负责顺序与记账，
  // 真正的翻译由这里在拿到成功结果后做。
  let winner
  const outcome = await runWithFallback({
    candidates: ordered.candidates,
    excluded: ordered.excluded,
    model,
    attempt: async candidate => {
      const result = await attemptUpstream({ candidate, options, snapshot, signal, messages: input.messages })
      if (result.ok === true) winner = { result, candidate }
      return result.ok === true ? { ok: true, value: result } : result
    },
    onAttempt: record => { attempts.push(record) },
  })

  if (outcome.ok !== true || winner === undefined) {
    const failure = outcome.failure ?? { code: 'TRANSPORT', message: '没有可用的上游' }
    yield {
      type: 'finish',
      reason: {
        kind: signal?.aborted === true ? 'aborted' : 'error',
        failure: {
          message: `${failure.message ?? '全部上游都失败了'}${attempts.length > 1 ? `（依次尝试了 ${attempts.map(a => a.upstreamName).join(' → ')}）` : ''}`,
          code: failure.code ?? 'TRANSPORT',
        },
      },
    }
    return
  }

  const facts = {
    upstreamId: winner.candidate.upstream.id,
    upstreamName: winner.candidate.upstream.name,
    strategy: snapshot.strategy,
    model,
    attempts: attempts.map(record => ({
      upstream: record.upstreamName,
      ok: record.ok,
      ...(record.code === undefined ? {} : { code: record.code }),
      elapsedMs: record.elapsedMs,
    })),
    routeNote: describeRoute(attempts, ordered.excluded),
    excluded: ordered.excluded,
  }
  input.onRoute?.(facts)
  yield* winner.result.translate(facts)
}

/**
 * 并行竞速：把同一个请求同时发给前 N 家，用第一个**真正开始答**的。
 *
 * ## 三件必须做对的事
 *
 * 1. **输家要取消。** 第一个赢家出现后立刻 abort 其余请求——
 *    否则它们在后台继续跑完，照样计费，竞速就变成了「花 N 份钱买一份答案」。
 * 2. **输家的失败不计入断路器。** 竞速里输掉是**预期行为**，
 *    不是上游有问题。把输家记为失败会让所有上游很快全被拉闸。
 *    只有「在赢家出现之前就失败」的才算数。
 * 3. **赢家判定用「第一个有内容的帧」**，与顺序回退同一套语义，
 *    否则一个快速返回空响应的上游会赢过慢但正确的那个。
 *
 * @param {object} input - 与 {@link runGateway} 相同的输入。
 * @yields {object} StreamChunk。
 */
async function* raceStream(input) {
  const { options, snapshot, health, signal } = input
  const model = baseModelId(options.model)
  const width = Math.max(2, Math.min(snapshot.raceWidth, 4))

  const ordered = orderCandidates({
    upstreams: snapshot.upstreams,
    model,
    strategy: snapshot.strategy,
    health,
    lastGoodId: snapshot.lastGoodId,
    now: input.now,
    random: input.random,
  })

  if (ordered.candidates.length === 0) {
    yield { type: 'finish', reason: { kind: 'error', failure: noCandidateFailure(model, ordered.excluded) } }
    return
  }

  const racers = ordered.candidates.slice(0, width)
  const controllers = racers.map(() => new AbortController())
  const linkOuter = () => { for (const controller of controllers) controller.abort() }
  if (signal !== undefined) signal.addEventListener('abort', linkOuter, { once: true })

  /** 每个竞速者的结果。 */
  const settled = await Promise.all(racers.map(async (candidate, index) => {
    const started = Date.now()
    const result = await attemptUpstream({
      candidate,
      options,
      snapshot,
      signal: controllers[index].signal,
      messages: input.messages,
    })
    return { candidate, index, result, elapsedMs: Date.now() - started }
  }))

  const winners = settled.filter(entry => entry.result.ok === true)
  const losers = settled.filter(entry => entry.result.ok !== true)

  if (winners.length === 0) {
    // 全败：每一家的失败都是真实的，都要记账。
    for (const entry of losers) {
      entry.candidate.health.recordFailure({
        code: entry.result.code,
        message: entry.result.message,
        threshold: entry.candidate.upstream.breakerThreshold,
        cooldownMs: entry.candidate.upstream.breakerCooldownMs,
      })
    }
    signal?.removeEventListener?.('abort', linkOuter)
    const first = losers[0]?.result
    yield {
      type: 'finish',
      reason: {
        kind: signal?.aborted === true ? 'aborted' : 'error',
        failure: {
          message: `${first?.message ?? '全部上游都失败了'}（并行尝试了 ${String(racers.length)} 个）`,
          code: first?.code ?? 'TRANSPORT',
        },
      },
    }
    return
  }

  // 最快的那个赢；同速时按候选顺序（稳定，可复现）。
  winners.sort((a, b) => (a.elapsedMs - b.elapsedMs) || (a.index - b.index))
  const winner = winners[0]

  // 输家：取消掉，且**不记失败**——输掉是竞速的预期结果，不是上游有病。
  for (const entry of losers) {
    controllers[entry.index].abort()
    entry.candidate.health.reset()
  }
  for (const entry of winners.slice(1)) {
    controllers[entry.index].abort()
    entry.candidate.health.reset()
  }
  winner.candidate.health.recordSuccess(winner.elapsedMs)
  signal?.removeEventListener?.('abort', linkOuter)

  const facts = {
    upstreamId: winner.candidate.upstream.id,
    upstreamName: winner.candidate.upstream.name,
    strategy: `race(${snapshot.strategy})`,
    model,
    raced: true,
    racers: racers.map((candidate, index) => ({
      upstream: candidate.upstream.name,
      won: index === winner.index,
      ...(settled[index].result.ok === true ? {} : { code: settled[index].result.code }),
      elapsedMs: settled[index].elapsedMs,
    })),
  }
  input.onRoute?.(facts)
  yield* winner.result.translate(facts)
}

/**
 * 造一个「没有可用上游」的失败。
 *
 * 这条消息要尽量能直接指出下一步该做什么，因为它出现的场景
 * 几乎总是配置问题：要么所有上游都停用了，要么都拉闸了，
 * 要么没有一个声明服务这个模型。
 *
 * @param {string} model - 模型 id。
 * @param {Array} excluded - 被排除的上游及原因。
 * @returns {object} LlmFailure 形状。
 */
function noCandidateFailure(model, excluded) {
  if (excluded.length === 0) {
    return {
      message: `网关里没有配置任何上游。请在「插件 → OmniRoute 网关」里添加一个上游。`,
      code: 'NO_UPSTREAM',
    }
  }
  const detail = excluded.map(entry => `${entry.name}（${entry.reason}）`).join('；')
  return {
    message: `模型 "${model}" 当前没有可用上游：${detail}`,
    code: 'NO_UPSTREAM',
  }
}

/**
 * 网关的一份只读视图：给界面显示「现在能用什么」。
 *
 * @param {object} snapshot - 网关配置快照。
 * @param {import('./gateway-breaker.js').HealthRegistry} health - 健康记录。
 * @param {number} [now] - 当前时刻。
 * @returns {object} 视图。
 */
export function describeGateway(snapshot, health, now = Date.now()) {
  const healthSnapshot = health.snapshot()
  return {
    strategy: snapshot.strategy,
    raceEnabled: snapshot.raceEnabled === true,
    raceWidth: snapshot.raceWidth,
    upstreams: snapshot.upstreams.map(upstream => {
      const record = healthSnapshot[upstream.id] ?? {}
      return {
        id: upstream.id,
        name: upstream.name,
        baseURL: upstream.baseURL,
        kind: upstream.kind ?? 'openai',
        builtin: upstream.builtin === true,
        enabled: upstream.enabled !== false,
        hasApiKey: typeof upstream.apiKey === 'string' && upstream.apiKey !== '',
        modelCount: (upstream.models ?? []).length,
        /**
         * 模型列表本身，而不只是数量。
         *
         * 界面上的「模型列表」文本框需要它才能显示和编辑现有内容；
         * 只给数量会让「编辑一条上游」在保存时把模型列表清空——
         * 一个用户完全没打算做的破坏性操作。
         */
        models: (upstream.models ?? []).map(model => model.id),
        weight: upstream.weight,
        inputPricePerMTok: upstream.inputPricePerMTok,
        outputPricePerMTok: upstream.outputPricePerMTok,
        health: {
          state: record.state ?? 'closed',
          successRate: record.successRate,
          sampleCount: record.sampleCount ?? 0,
          totals: record.totals ?? { success: 0, failure: 0 },
          averageLatencyMs: record.averageLatencyMs ?? 0,
          consecutiveFailures: record.consecutiveFailures ?? 0,
          lastSuccessAt: record.lastSuccessAt,
          lastFailure: record.lastFailure,
          openedAt: record.openedAt,
        },
        ...(record.state === 'open' && record.openedAt !== undefined
          ? { cooldownRemainingMs: Math.max(0, upstream.breakerCooldownMs - (now - record.openedAt)) }
          : {}),
      }
    }),
    models: collectModels(snapshot.upstreams),
  }
}

/**
 * 判断某个模型在当前网关配置下有没有任何上游能服务它。
 * 界面上用来把「选了但用不了」的模型标出来，而不是等到发请求才报错。
 *
 * @param {object} snapshot - 网关配置快照。
 * @param {string} model - 模型 id。
 * @returns {Array} 能服务它的上游 id。
 */
export function upstreamsForModel(snapshot, model) {
  return snapshot.upstreams
    .filter(upstream => upstream.enabled !== false && upstreamServes(upstream, model))
    .map(upstream => upstream.id)
}
