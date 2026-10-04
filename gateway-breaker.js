/**
 * 断路器与上游健康统计。
 *
 * 这是让「失败回退」真正有用的那一块。没有它，回退就退化成
 * 「每次请求都先去撞一遍已经坏掉的上游、等它超时、再换下一个」——
 * 用户感受到的是每一步都慢一拍，而回退本来是为了更快地拿到答案。
 *
 * ## 三态模型
 *
 * 状态机是标准的断路器三态，名字与语义一一对应：
 *
 * ```
 *   closed ──连续失败到阈值──▶ open ──冷却时间到──▶ half-open
 *     ▲                                                │
 *     └──────────── 试探成功 ──────────────────────────┘
 *                      │
 *                  试探失败 ──▶ open（冷却重新计时）
 * ```
 *
 * - **closed**：正常放行。
 * - **open**：直接拒绝，不发起请求。这是省时间的关键。
 * - **half-open**：放**一个**探测请求过去。成功就恢复 closed，
 *   失败就回到 open 并重新计时。只放一个，是因为「同时放十个探测」
 *   等于没拉闸。
 *
 * ## 什么算失败
 *
 * 不是所有失败都该记到断路器头上。这是这里最重要的一条判断：
 *
 * - **上游的问题**（5xx、超时、连不上、限流）→ 计数。
 * - **我们自己的问题**（请求体非法 400、上下文超长 413、模型不存在 404）
 *   → **不计数**。这些错误换成另一家上游八成也一样，或者根本是调用方的问题；
 *   把它们记进去会让一个健康的上游因为用户的坏输入被拉闸。
 * - **鉴权问题**（401/403）→ 计数。这家的密钥无效，短期内不会自己好，
 *   正是应该换别家的场景。
 *
 * @module omniroute/breaker
 */

/** 断路器状态。 */
export const BREAKER_STATE = Object.freeze({
  closed: 'closed',
  open: 'open',
  halfOpen: 'half-open',
})

/**
 * 判断一次失败是否应该计入断路器。
 *
 * 判断依据是 harness 的稳定 failure code（适配器层的产物），
 * 而不是解析错误文本——文本是给人看的，会变。
 *
 * ## 默认值为什么是「计入」而不是「不计入」
 *
 * 这里刻意做成**白名单式的不计入**：只有明确知道「换一家也没用」的那几个
 * code 才跳过，其余一律计入。
 *
 * 早先写反了（默认不计入），代价在一次自检里暴露出来：上游用
 * `200 + 流内 error` 报错时，错误码来自上游自己的错误体
 * （例如 `upstream_boom`），**必然是个不认识的字符串**。默认不计入
 * 的结果是「所有这类失败都被静默丢弃」——断路器永远不拉闸，
 * 于是每次都先去撞一遍已经坏掉的上游、等它报错、再换下一家。
 * 那正是断路器要消除的浪费。
 *
 * 方向的判断是这样的：一个**已经发生**的请求失败，大概率是上游的问题
 * （网络、限流、上游内部错误），而「请求本身有问题」是少数几种
 * 可枚举的情况。所以白名单该开给后者。
 *
 * @param {string} code - harness 的 failure code。
 * @returns {boolean} 是否计入。
 */
export function countsTowardBreaker(code) {
  switch (code) {
    // 请求本身的问题：换一家大概率一样，或者是调用方的错。不计入。
    case 'REQUEST':
    case 'NO_MODEL':
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'ABORTED':
      return false
    // 其余一律计入，包括上游自定义的错误码。
    default:
      return true
  }
}

/**
 * 一个上游的健康记录。
 *
 * 只保留**最近若干次**的结果，而不是全量计数：上游的健康状况会变化
 * （限流窗口会过去、额度会重置），一个从启动开始累计的成功率
 * 会让一个已经恢复的上游永远显得很糟。
 */
export class UpstreamHealth {
  /**
   * @param {object} options - 配置。
   * @param {number} [options.windowSize] - 保留最近多少次结果。
   */
  constructor(options = {}) {
    /** 保留的样本数。20 次足以看出趋势，又不至于让旧状态赖着不走。 */
    this.windowSize = options.windowSize ?? 20
    /** 最近的结果，true = 成功。 */
    this.samples = []
    /** 连续失败次数（成功一次就归零）。 */
    this.consecutiveFailures = 0
    /** 断路器状态。 */
    this.state = BREAKER_STATE.closed
    /** 进入 open 的时刻。 */
    this.openedAt = 0
    /** 是否已经放过一个半开探测（防止并发请求同时探测）。 */
    this.probeInFlight = false
    /** 累计的成功/失败总数（用于界面显示总体表现，不参与判闸）。 */
    this.totals = { success: 0, failure: 0 }
    /** 最近一次成功的时刻。 */
    this.lastSuccessAt = 0
    /** 最近一次失败的说明（给人看的）。 */
    this.lastFailure = undefined
    /** 平均延迟（毫秒），只在成功样本上算。 */
    this.averageLatencyMs = 0
  }

  /**
   * 记录一次成功。
   * @param {number} latencyMs - 这次请求的耗时。
   * @param {number} at - 发生时刻。
   */
  recordSuccess(latencyMs, at = Date.now()) {
    this.#push(true)
    this.consecutiveFailures = 0
    this.state = BREAKER_STATE.closed
    this.probeInFlight = false
    this.lastSuccessAt = at
    this.lastFailure = undefined
    this.totals.success += 1
    // 指数滑动平均：新样本占 1/4。比简单平均更能反映「现在快不快」，
    // 又不会因为一次抖动就翻盘。
    const sample = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0
    this.averageLatencyMs = this.averageLatencyMs === 0
      ? sample
      : this.averageLatencyMs * 0.75 + sample * 0.25
  }

  /**
   * 记录一次失败。
   *
   * @param {object} detail - 失败详情。
   * @param {string} detail.code - harness 的 failure code。
   * @param {string} [detail.message] - 给人看的说明。
   * @param {number} detail.threshold - 连续失败多少次要拉闸。
   * @param {number} detail.cooldownMs - 拉闸后冷却多久。
   * @param {number} at - 发生时刻。
   * @returns {boolean} 这次失败是否计入（未计入时不该改变状态）。
   */
  recordFailure(detail, at = Date.now()) {
    if (!countsTowardBreaker(detail.code)) return false
    this.#push(false)
    this.consecutiveFailures += 1
    this.totals.failure += 1
    this.lastFailure = { code: detail.code, message: detail.message ?? '', at }
    this.probeInFlight = false
    if (this.consecutiveFailures >= detail.threshold) {
      this.state = BREAKER_STATE.open
      this.openedAt = at
    }
    return true
  }

  /**
   * 现在是否允许向这个上游发请求。
   *
   * 这是被调用最频繁的方法，所以它是**纯读**的（除了半开探测的占位，
   * 那个占位本身就是为了防止并发放行）。
   *
   * @param {object} options - 判断依据。
   * @param {number} options.cooldownMs - 冷却时长。
   * @param {number} at - 当前时刻。
   * @returns {{allowed: boolean, reason: string, halfOpen: boolean}} 判断结果。
   */
  admit(options, at = Date.now()) {
    if (this.state === BREAKER_STATE.closed) return { allowed: true, reason: 'closed', halfOpen: false }
    if (this.state === BREAKER_STATE.open) {
      if (at - this.openedAt < options.cooldownMs) {
        const remainMs = options.cooldownMs - (at - this.openedAt)
        return { allowed: false, reason: `已拉闸，${String(Math.ceil(remainMs / 1000))}s 后重试`, halfOpen: false }
      }
      // 冷却结束 → 半开，放一个探测过去。
      this.state = BREAKER_STATE.halfOpen
    }
    // 半开：只放一个。已经在探测中就拒绝其余的，否则「探测」变成了洪峰。
    if (this.probeInFlight) return { allowed: false, reason: '正在探测恢复情况', halfOpen: true }
    this.probeInFlight = true
    return { allowed: true, reason: 'half-open 探测', halfOpen: true }
  }

  /**
   * 手动恢复：把状态清回 closed。
   *
   * 界面上要有这个按钮，因为自动恢复只覆盖「上游自己好了」这种情况；
   * 如果用户刚刚改好了密钥或换了地址，他不该等冷却时间走完。
   */
  reset() {
    this.state = BREAKER_STATE.closed
    this.consecutiveFailures = 0
    this.probeInFlight = false
    this.openedAt = 0
    this.samples = []
    this.lastFailure = undefined
  }

  /**
   * 成功率（基于窗口内的样本）；没有样本时返回 undefined。
   *
   * 返回 undefined 而不是 1 或 0：**「还不知道」和「全都失败」
   * 是完全不同的两件事**，界面上要能区分，路由策略也要能区分。
   *
   * @returns {number|undefined} 0..1 的成功率。
   */
  successRate() {
    if (this.samples.length === 0) return undefined
    const ok = this.samples.filter(Boolean).length
    return ok / this.samples.length
  }

  /** 供界面显示的一份快照。 */
  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      successRate: this.successRate(),
      sampleCount: this.samples.length,
      totals: { ...this.totals },
      averageLatencyMs: Math.round(this.averageLatencyMs),
      lastSuccessAt: this.lastSuccessAt === 0 ? undefined : this.lastSuccessAt,
      lastFailure: this.lastFailure,
      openedAt: this.openedAt === 0 ? undefined : this.openedAt,
    }
  }

  /** 推入一个样本，超出窗口就丢最旧的。 */
  #push(ok) {
    this.samples.push(ok)
    if (this.samples.length > this.windowSize) this.samples.shift()
  }
}

/**
 * 一组上游的健康记录，按上游 id 索引。
 *
 * 独立成一个类是因为**健康状态必须跨请求存活**，而适配器每次请求
 * 都会重新读配置。把它挂在插件实例上（而不是适配器实例上）也保证了
 * 一次配置热改不会把好不容易积累的健康数据清空。
 */
export class HealthRegistry {
  constructor(options = {}) {
    /** @type {Map<string, UpstreamHealth>} */
    this.byId = new Map()
    this.windowSize = options.windowSize ?? 20
  }

  /**
   * 取一个上游的健康记录（不存在就建）。
   * @param {string} id - 上游 id。
   * @returns {UpstreamHealth} 记录。
   */
  for(id) {
    let health = this.byId.get(id)
    if (health === undefined) {
      health = new UpstreamHealth({ windowSize: this.windowSize })
      this.byId.set(id, health)
    }
    return health
  }

  /** 所有上游的一份快照，供界面显示。 */
  snapshot() {
    const out = {}
    for (const [id, health] of this.byId) out[id] = health.snapshot()
    return out
  }

  /** 全部恢复到 closed（界面上的「全部重置」）。 */
  resetAll() {
    for (const health of this.byId.values()) health.reset()
  }
}
