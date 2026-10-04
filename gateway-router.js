/**
 * 路由器：决定一次请求发给谁，以及失败之后换谁。
 *
 * ## 两个阶段，不是一个
 *
 * 这是这个文件里最重要的设计决定。「路由」实际上有两件事：
 *
 *   1. **排序（candidates）**：按策略把候选上游排成一个**完整的顺序**，
 *      而不是只挑出「最好的那一个」。
 *   2. **回退（fallback）**：沿着这个顺序依次尝试，直到成功。
 *
 * 之所以要有第 1 步产出一个**顺序**而不是一个选择：回退链必须是有序的，
 * 否则「失败了换谁」就没有答案。random / weighted 这类策略本来只定义
 * 「首选是谁」，把整个顺序都随机化会让回退行为不可复现——出了问题时
 * 没人能说清「为什么这次走到了第三家」。所以这里的规定是：
 *
 *   - 策略只决定**首选**；
 *   - 回退顺序始终是配置里的**稳定顺序**（用户能看、能预测）。
 *
 * 唯一的例外是 `least-latency` / `cost-first`：它们的「偏好」本身就是
 * 全序的，所以直接拿排序结果当回退顺序，行为依然可解释。
 *
 * ## 哪些上游参与
 *
 * 一个候选必须同时满足三条，缺一不可：
 *   - `enabled !== false`；
 *   - 它声称服务这个模型（`upstreamServes`）；
 *   - 断路器允许（closed，或半开时的那个探测）。
 *
 * 被排除的每一条都要带上**原因**，因为界面上要回答
 * 「我明明配了四家，为什么只用了这一家」——没有原因的话，
 * 用户只能靠猜。
 *
 * @module omniroute/router
 */

import { upstreamServes } from './gateway-model.js'

/**
 * 把一个上游列表按策略排出候选顺序。
 *
 * @param {object} input - 输入。
 * @param {Array} input.upstreams - 全部上游（已归一化）。
 * @param {string} input.model - 这次请求要用的模型 id。
 * @param {string} input.strategy - 策略 id。
 * @param {import('./gateway-breaker.js').HealthRegistry} input.health - 健康记录。
 * @param {string|undefined} input.lastGoodId - 上一次成功的上游 id（lkgp 用）。
 * @param {() => number} [input.random] - 随机源，注入以便测试可复现。
 * @param {number} [input.now] - 当前时刻，注入以便测试。
 * @returns {{candidates: Array, excluded: Array<{id: string, name: string, reason: string}>}} 候选与排除说明。
 */
export function orderCandidates(input) {
  const now = input.now ?? Date.now()
  const random = input.random ?? Math.random
  const candidates = []
  const excluded = []

  for (const upstream of input.upstreams) {
    if (upstream.enabled === false) {
      excluded.push({ id: upstream.id, name: upstream.name, reason: '已停用' })
      continue
    }
    if (!upstreamServes(upstream, input.model)) {
      excluded.push({ id: upstream.id, name: upstream.name, reason: `未声明服务模型 ${input.model}` })
      continue
    }
    const health = input.health.for(upstream.id)
    const admission = health.admit({ cooldownMs: upstream.breakerCooldownMs }, now)
    if (!admission.allowed) {
      excluded.push({ id: upstream.id, name: upstream.name, reason: admission.reason })
      continue
    }
    candidates.push({ upstream, health, halfOpen: admission.halfOpen })
  }

  if (candidates.length <= 1) return { candidates, excluded }

  return { candidates: sortCandidates(candidates, input, random), excluded }
}

/**
 * 按策略排序候选。
 *
 * 每条分支都刻意保持**稳定**（用配置顺序做 tie-break），
 * 因为一个每次都不一样的顺序无法被用户验证，也无法被测试。
 *
 * @param {Array} candidates - 通过筛选的候选。
 * @param {object} input - 与 {@link orderCandidates} 相同的输入。
 * @param {() => number} random - 随机源。
 * @returns {Array} 排序后的候选。
 */
function sortCandidates(candidates, input, random) {
  const indexOf = new Map(candidates.map((candidate, index) => [candidate.upstream.id, index]))
  /** 稳定比较：a 在 b 前返回负数。 */
  const stable = (a, b) => indexOf.get(a.upstream.id) - indexOf.get(b.upstream.id)

  switch (input.strategy) {
    case 'lkgp': {
      // 上次成功的那个提到最前，其余保持配置顺序。
      const target = input.lastGoodId
      if (target === undefined) return [...candidates].sort(stable)
      const preferred = candidates.filter(candidate => candidate.upstream.id === target)
      if (preferred.length === 0) return [...candidates].sort(stable)
      return [...preferred, ...candidates.filter(candidate => candidate.upstream.id !== target).sort(stable)]
    }

    case 'weighted': {
      // 按权重排出一个**完整顺序**：反复按剩余权重抽签。
      // 这样既有随机的分流效果，又给出一个确定的回退链。
      const pool = [...candidates].sort(stable)
      const out = []
      while (pool.length > 0) {
        const total = pool.reduce((sum, candidate) => sum + candidate.upstream.weight, 0)
        let ticket = random() * total
        let picked = pool.length - 1
        for (let index = 0; index < pool.length; index += 1) {
          ticket -= pool[index].upstream.weight
          if (ticket <= 0) {
            picked = index
            break
          }
        }
        out.push(pool[picked])
        pool.splice(picked, 1)
      }
      return out
    }

    case 'round-robin': {
      // 用一个进程级的游标把「第一个」往后挪，其余保持配置顺序。
      const ordered = [...candidates].sort(stable)
      const cursor = (roundRobinCursor + 1) % ordered.length
      roundRobinCursor = cursor
      return [...ordered.slice(cursor), ...ordered.slice(0, cursor)]
    }

    case 'least-latency': {
      // 全序：平均延迟小的在前。没有样本的（=0）排在有样本的**后面**，
      // 因为「没测过」不等于「最快」——让新上游插队会把刚积累的
      // 延迟数据废掉。
      return [...candidates].sort((a, b) => {
        const left = a.health.averageLatencyMs
        const right = b.health.averageLatencyMs
        const leftKnown = a.health.samples.length > 0
        const rightKnown = b.health.samples.length > 0
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
        if (leftKnown && left !== right) return left - right
        return stable(a, b)
      })
    }

    case 'cost-first': {
      // 全序：按输入+输出单价之和排序。没配价格的排最后（不参与比较）。
      return [...candidates].sort((a, b) => {
        const left = priceOf(a.upstream)
        const right = priceOf(b.upstream)
        if (left === undefined && right === undefined) return stable(a, b)
        if (left === undefined) return 1
        if (right === undefined) return -1
        if (left !== right) return left - right
        return stable(a, b)
      })
    }

    case 'priority':
    default:
      return [...candidates].sort(stable)
  }
}

/** 轮询游标。模块级，因为「轮询」的语义就是跨请求记住上次轮到谁。 */
let roundRobinCursor = -1

/** 测试与「重置」用：把轮询游标归零。 */
export function resetRoundRobin() {
  roundRobinCursor = -1
}

/**
 * 一个上游的综合单价（输入 + 输出，美元 / 百万 token）。
 * 两个价格都没配时返回 undefined，表示它不参与成本比较。
 * @param {object} upstream - 上游条目。
 * @returns {number|undefined} 单价和。
 */
function priceOf(upstream) {
  const input = upstream.inputPricePerMTok
  const output = upstream.outputPricePerMTok
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0)
}

/**
 * 跑一次带回退的请求。
 *
 * ## 这个函数管什么、不管什么
 *
 * 它管**顺序与记账**：依次尝试候选、把结果记进健康统计、
 * 在合适的时机停止。它不管**怎么发请求**——那由调用方通过
 * `attempt` 注入，因为它需要模型、消息、工具等一整套上下文，
 * 而那些是适配器的事。
 *
 * 这样切分的收益是可测性：这个函数的逻辑（回退、记账、何时放弃）
 * 可以用一个假的 `attempt` 完全覆盖，不需要网络。
 *
 * ## 什么时候停止
 *
 * - 成功 → 立刻返回。
 * - 失败但**不应该换一家**（请求本身有问题）→ 立刻返回，
 *   因为换一家大概率是同样的错，白白多花一次往返和一份配额。
 * - 候选耗尽 → 返回**最后一个**失败，而不是第一个：
 *   最后一个通常最能说明「现在到底怎么了」。
 *
 * @param {object} input - 输入。
 * @param {Array} input.candidates - {@link orderCandidates} 的结果。
 * @param {Array} input.excluded - 被排除的上游及原因（用于诊断信息）。
 * @param {(candidate: object, index: number) => Promise<object>} input.attempt - 尝试一个候选。
 *   返回 `{ok: true, value}` 或 `{ok: false, code, message}`。
 * @param {(event: object) => void} [input.onAttempt] - 每次尝试后的回调（记账/日志）。
 * @param {string} [input.model] - 模型 id（诊断信息用）。
 * @returns {Promise<object>} `{ok, value?, failure?, attempts, excluded}`。
 */
export async function runWithFallback(input) {
  const attempts = []
  let lastFailure

  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]
    const started = Date.now()
    const result = await input.attempt(candidate, index)
    const elapsed = Date.now() - started

    if (result.ok === true) {
      candidate.health.recordSuccess(elapsed)
      const record = {
        upstreamId: candidate.upstream.id,
        upstreamName: candidate.upstream.name,
        ok: true,
        elapsedMs: elapsed,
        halfOpen: candidate.halfOpen,
      }
      attempts.push(record)
      input.onAttempt?.(record)
      return { ok: true, value: result.value, attempts, excluded: input.excluded ?? [] }
    }

    const counted = candidate.health.recordFailure({
      code: result.code,
      message: result.message,
      threshold: candidate.upstream.breakerThreshold,
      cooldownMs: candidate.upstream.breakerCooldownMs,
    })
    lastFailure = result
    const record = {
      upstreamId: candidate.upstream.id,
      upstreamName: candidate.upstream.name,
      ok: false,
      code: result.code,
      message: result.message,
      elapsedMs: elapsed,
      counted,
      halfOpen: candidate.halfOpen,
    }
    attempts.push(record)
    input.onAttempt?.(record)

    // 请求本身的问题：换一家大概率一模一样，别浪费往返和配额。
    if (!counted && isTerminalForRouting(result.code)) {
      return { ok: false, failure: result, attempts, excluded: input.excluded ?? [], terminal: true }
    }
  }

  return { ok: false, failure: lastFailure, attempts, excluded: input.excluded ?? [] }
}

/**
 * 这类失败是否意味着「别再换上游了」。
 *
 * 判断依据是「换一个上游有没有可能改变结果」：
 *   - 请求体非法、上下文超长、模型 id 不认识 → 换谁都一样，停。
 *   - 鉴权失败 → **继续换**。这正是多上游配置的价值所在：
 *     一家的密钥过期了，另一家还能答。
 *
 * @param {string} code - harness 的 failure code。
 * @returns {boolean} 是否应立刻停止回退。
 */
export function isTerminalForRouting(code) {
  switch (code) {
    case 'REQUEST':
    case 'NO_MODEL':
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'ABORTED':
      return true
    default:
      return false
  }
}

/**
 * 把一次回退过程总结成一句给模型/用户看的话。
 *
 * 只在**发生过回退**时才生成。一次就成功的请求不需要这句话——
 * 往正常的对话里塞一句「本次由 X 提供」是噪音，而这正是很多网关
 * 让人烦的地方。只有「路上出过事」才值得说。
 *
 * @param {Array} attempts - {@link runWithFallback} 的 attempts。
 * @param {Array} excluded - 被排除的上游。
 * @returns {string|undefined} 摘要，无需说明时 undefined。
 */
export function describeRoute(attempts, excluded = []) {
  const failures = attempts.filter(attempt => attempt.ok === false)
  if (failures.length === 0) return undefined
  const winner = attempts.find(attempt => attempt.ok === true)
  const parts = failures.map(attempt => `${attempt.upstreamName}(${attempt.code})`)
  if (winner === undefined) {
    const note = excluded.length > 0 ? `；已跳过 ${String(excluded.length)} 个：${excluded.map(entry => `${entry.name}(${entry.reason})`).join('、')}` : ''
    return `所有上游都失败了：${parts.join(' → ')}${note}`
  }
  return `前 ${String(failures.length)} 个上游失败（${parts.join(' → ')}），已改用 ${winner.upstreamName}`
}
