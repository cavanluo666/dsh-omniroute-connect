/**
 * 上游（upstream）与网关切面的数据模型。
 *
 * 这个文件是「插件自己就是网关」这条路的**唯一事实来源**：什么是一个上游、
 * 一个上游如何被校验、有哪些路由策略、配置如何合成。它不碰网络、
 * 不碰文件系统，所以可以被纯函数地测试。
 *
 * ## 术语
 *
 * - **上游 (upstream)**：一个 OpenAI 兼容的 endpoint（OpenAI、DeepSeek、
 *   Groq、本地 Ollama……），带一个名字、一个 baseURL、一个可选密钥，
 *   以及它服务的模型列表。
 * - **路由 (route)**：某一次请求该发给哪个上游，由策略决定。
 * - **回退链 (fallback chain)**：首选上游失败后依次尝试的顺序。
 * - **断路器 (breaker)**：某个上游连续失败到阈值时被临时摘掉，
 *   避免每次都去撞一个已经坏掉的东西。
 *
 * ## 为什么内置一个免密钥上游
 *
 * 「装上就能用」是这个插件的第一体验目标。全新安装、没填任何密钥时，
 * 如果网关没有任何可用上游，用户看到的是一个空的模型选择器，
 * 完全不知道下一步该做什么。所以预置一个免鉴权上游作为默认项。
 *
 * 但必须诚实标注：那是**别人家的免费额度**，随时可能失效、限流或关停。
 * 所以它在界面上单独标出，且在回退链上排在自己填的上游之后——
 * 用户一旦配上自己的上游，内置那条自然退居备选。
 *
 * @module omniroute/model
 */

/** 一个上游条目的默认值。 */
export const UPSTREAM_DEFAULTS = Object.freeze({
  /** 该上游请求超时（毫秒）。 */
  timeoutMs: 120000,
  /** 连续失败多少次后拉闸。 */
  breakerThreshold: 3,
  /** 拉闸后多久自动半开重试（毫秒）。 */
  breakerCooldownMs: 60000,
  /** 这个上游的权重（weighted 策略用）。 */
  weight: 1,
  /** 是否启用。 */
  enabled: true,
})

/**
 * 内置的免密钥上游。
 *
 * 这不是一个普通的「OpenAI 兼容 endpoint」——它是 opencode.ai 的网关，
 * 免费层要求一组特定的客户端指纹。所以它带一个 `kind` 标记，
 * 让上游客户端知道该用哪套握手方式。
 *
 * 依据：opencode.ai 网关的公开行为——公开的池化凭据、
 * `opencode/<版本>` 的 User-Agent 门槛、免费层的工具指纹要求。
 *
 * `models` 预置的是验证过可用的那几个 id，而不是随手猜的：
 * 这条通道的 `/models` 会列出 85 个模型，但其中绝大多数在这个出口上
 * 返回 403（免费额度按账号/额度网关，不是「列出来就能用」）。
 * 验证结论：`space-bunny-free` 正常应答；
 * `mimo-*` / `nemotron-*` / `longcat-*` 等一律 403，
 * 而 `claude-*` / `gemini-*` 那类非 `-free` 的模型是 401（需要单独密钥）。
 *
 * 所以预置列表只放验证过的那一个，其余靠用户在管理页点
 * 「探测可用模型」自己挑——给用户一个能用的默认值，
 * 而不是一屏看着漂亮但点下去全报错的模型。
 */
export const BUILTIN_UPSTREAM = Object.freeze({
  id: 'builtin-free',
  name: '内置免费额度',
  kind: 'opencode-free',
  baseURL: 'https://opencode.ai/zen/v1',
  apiKey: '',
  models: [
    { id: 'space-bunny-free', name: 'Space Bunny（免密钥）' },
  ],
  builtin: true,
  enabled: true,
})

/**
 * 路由策略。
 *
 * 从 OmniRoute 的 19 种策略里，挑出在**单机、无配额数据库**的前提下
 * 真正有意义、且行为可解释的那几种。刻意不做「看起来像但其实随机」的
 * 那些——一个说不清行为的策略比没有策略更糟。
 */
export const STRATEGIES = Object.freeze([
  {
    id: 'priority',
    name: '按顺序',
    description: '永远用列表里第一个可用的上游，它挂了才用下一个。最简单、最可预测。',
  },
  {
    id: 'lkgp',
    name: '记住上次好的',
    description: '优先用最近一次成功的那个上游，它挂了才换。适合「主用一家、偶尔兜底」。',
  },
  {
    id: 'weighted',
    name: '按权重',
    description: '按每个上游配的权重随机选，权重高的概率大。适合按成本比例分流。',
  },
  {
    id: 'round-robin',
    name: '轮询',
    description: '轮流用，请求尽量均匀分到各家。适合分摊免费额度。',
  },
  {
    id: 'least-latency',
    name: '最快优先',
    description: '优先用最近平均响应最快的上游。需要先积累一些请求才有意义。',
  },
  {
    id: 'cost-first',
    name: '成本优先',
    description: '优先用单价最低的上游（按每家配的每百万 token 价格算）。',
  },
])

/** 所有策略的 id 集合，供校验用。 */
export const STRATEGY_IDS = Object.freeze(STRATEGIES.map(strategy => strategy.id))

/** 默认策略：最可预测的那个，也是新用户最该先看到的行为。 */
export const DEFAULT_STRATEGY = 'priority'

/** 生成一个未被占用的上游 id（只用于「新建」按钮的初值）。 */
export function makeUpstreamId(existing = []) {
  const taken = new Set(existing.map(entry => entry?.id))
  for (let index = 1; index < 1000; index += 1) {
    const id = `upstream-${String(index)}`
    if (!taken.has(id)) return id
  }
  return `upstream-${String(Date.now())}`
}

/**
 * 判断一个字符串是不是可用的 baseURL。
 *
 * 只接受 http/https——网关是本地基础设施，`file://` 之类的协议在这里
 * 没有意义，而放行它们会让 `fetch` 报一个没人看得懂的错。
 *
 * @param {unknown} value - 候选值。
 * @returns {boolean} 是否可用。
 */
export function isUsableBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 取一个正整数，否则用兜底值。
 * @param {unknown} value - 候选值。
 * @param {number|undefined} fallback - 兜底值。
 * @returns {number|undefined} 结果。
 */
function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 取一个正数（可为小数），否则用兜底值。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 取一个非负数，否则 undefined。 */
function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 归一化一个模型条目。
 *
 * 支持两种写法：裸字符串 `"gpt-4o"`（最省事），或对象
 * `{id, name, contextWindow, maxTokens, inputModalities}`（要覆盖容量时）。
 *
 * @param {unknown} raw - 原始条目。
 * @returns {object|undefined} 归一化后的模型条目。
 */
export function normalizeModelEntry(raw) {
  if (typeof raw === 'string') {
    const id = raw.trim()
    return id === '' ? undefined : { id, name: id }
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (id === '') return undefined
  const entry = { id, name: typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : id }
  const contextWindow = positiveInt(source.contextWindow, undefined)
  const maxTokens = positiveInt(source.maxTokens, undefined)
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  if (Array.isArray(source.inputModalities)) {
    const modalities = source.inputModalities.filter(value => value === 'text' || value === 'image')
    if (modalities.length > 0) entry.inputModalities = [...new Set(modalities)]
  }
  return entry
}

/**
 * 把一个上游条目归一化。
 *
 * 校验策略是「能修就修，不能修就丢」：上游是用户手写的配置，
 * 一个多打了斜杠的地址不该让整条上游失效，但一个不是 URL 的地址
 * 也不该被放行到 `fetch` 那里去报错。返回 `undefined` 表示这一条
 * 无法使用，调用方负责在界面上说明原因。
 *
 * @param {unknown} raw - 原始条目。
 * @param {number} index - 它在列表里的位置（用于生成兜底 id）。
 * @returns {object|undefined} 归一化后的上游。
 */
export function normalizeUpstream(raw, index = 0) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (raw)

  const rawId = typeof source.id === 'string' ? source.id.trim() : ''
  const id = rawId !== '' ? rawId : `upstream-${String(index + 1)}`
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return undefined

  const baseURL = typeof source.baseURL === 'string' ? source.baseURL.trim().replace(/\/+$/, '') : ''
  if (!isUsableBaseUrl(baseURL)) return undefined

  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : id
  const upstream = {
    id,
    name,
    baseURL,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    enabled: source.enabled === undefined ? UPSTREAM_DEFAULTS.enabled : source.enabled === true,
    timeoutMs: positiveInt(source.timeoutMs, UPSTREAM_DEFAULTS.timeoutMs),
    breakerThreshold: positiveInt(source.breakerThreshold, UPSTREAM_DEFAULTS.breakerThreshold),
    breakerCooldownMs: positiveInt(source.breakerCooldownMs, UPSTREAM_DEFAULTS.breakerCooldownMs),
    weight: positiveNumber(source.weight, UPSTREAM_DEFAULTS.weight),
  }
  if (typeof source.kind === 'string' && source.kind !== '') upstream.kind = source.kind
  if (source.builtin === true) upstream.builtin = true
  // 单价（美元 / 百万 token）：cost-first 策略与成本估算用；不填就是不参与比较。
  const inputPrice = nonNegativeNumber(source.inputPricePerMTok)
  const outputPrice = nonNegativeNumber(source.outputPricePerMTok)
  if (inputPrice !== undefined) upstream.inputPricePerMTok = inputPrice
  if (outputPrice !== undefined) upstream.outputPricePerMTok = outputPrice
  // 模型列表：这一条上游声称能服务哪些模型 id。空列表 = 「它说什么都接」。
  upstream.models = Array.isArray(source.models)
    ? source.models.map(normalizeModelEntry).filter(entry => entry !== undefined)
    : []
  return upstream
}

/**
 * 把配置里的上游列表整理成一个可用的集合。
 *
 * 三条规则：
 *   1. 丢掉完全不可用的条目（记在 `rejected` 里，界面要能显示为什么）；
 *   2. 重复 id 只留第一个——两个同名上游会让「谁成功了」无法表达；
 *   3. 一条都没有时补上内置免密钥上游，保证开箱可用。
 *
 * **内置那条也必须走一遍 {@link normalizeUpstream}**，不能直接展开常量：
 * 常量里只有「身份」字段，没有 `timeoutMs` / `breakerThreshold` /
 * `breakerCooldownMs` / `weight` 这些**行为**字段，而它们全都由归一化
 * 补上默认值。早先直接 `{...BUILTIN_UPSTREAM}` 的结果是
 * `upstream.timeoutMs === undefined`，于是
 * `setTimeout(…, undefined)` 立刻超时——
 * 一个「刚发出去就报超时」的诡异故障（错误信息里还写着 `undefinedms`）。
 *
 * @param {unknown} raw - 配置里的 upstreams 数组。
 * @returns {{upstreams: Array, rejected: Array<{index: number, reason: string}>}} 结果。
 */
export function normalizeUpstreams(raw) {
  const list = Array.isArray(raw) ? raw : []
  const upstreams = []
  const rejected = []
  const seen = new Set()

  list.forEach((entry, index) => {
    const upstream = normalizeUpstream(entry, index)
    if (upstream === undefined) {
      rejected.push({ index, reason: '缺少有效的 http(s) baseURL，或 id 含有非法字符' })
      return
    }
    if (seen.has(upstream.id)) {
      rejected.push({ index, reason: `id "${upstream.id}" 重复，已忽略后一条` })
      return
    }
    seen.add(upstream.id)
    upstreams.push(upstream)
  })

  if (upstreams.length === 0) {
    const builtin = normalizeUpstream({ ...BUILTIN_UPSTREAM }, 0)
    if (builtin === undefined) {
      // 常量写错了属于开发期错误，但这里不抛：一个坏掉的默认值
      // 不该让整个插件装不起来，宁可让界面显示「没有上游」。
      rejected.push({ index: 0, reason: '内置上游定义无效' })
    } else {
      upstreams.push(builtin)
    }
  }
  return { upstreams, rejected }
}

/**
 * 某个上游是否服务某个模型。
 *
 * 空模型列表表示「它说自己什么都接」——这是常见情形（用户不想逐个列），
 * 所以不能把空列表理解成「什么都不接」。
 *
 * @param {object} upstream - 上游条目。
 * @param {string} model - 模型 id。
 * @returns {boolean} 是否服务。
 */
export function upstreamServes(upstream, model) {
  if (!Array.isArray(upstream.models) || upstream.models.length === 0) return true
  return upstream.models.some(entry => entry.id === model)
}

/**
 * 汇总所有上游能服务的模型（并集）。
 *
 * 模型选择器需要列出所有可用模型，而同一个模型 id 可能被多家上游服务。
 * 这里记下每家谁服务它，路由时用来判断候选。
 *
 * @param {Array} upstreams - 上游列表。
 * @returns {Array<object>} 模型并集，每项带 `servedBy`。
 */
export function collectModels(upstreams) {
  const byId = new Map()
  for (const upstream of upstreams) {
    if (upstream.enabled === false) continue
    for (const model of upstream.models ?? []) {
      const existing = byId.get(model.id)
      if (existing === undefined) {
        byId.set(model.id, {
          id: model.id,
          name: model.name,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
          servedBy: [upstream.id],
        })
        continue
      }
      existing.servedBy.push(upstream.id)
      // 取各家声明里**最大**的容量：宁可给模型多一点预算，也不要因为
      // 某一家声明得保守就让压缩过早触发。
      if (model.contextWindow !== undefined && (existing.contextWindow ?? 0) < model.contextWindow) {
        existing.contextWindow = model.contextWindow
      }
      if (model.maxTokens !== undefined && (existing.maxTokens ?? 0) < model.maxTokens) {
        existing.maxTokens = model.maxTokens
      }
    }
  }
  return [...byId.values()]
}
