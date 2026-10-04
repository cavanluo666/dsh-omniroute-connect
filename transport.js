/**
 * OmniRoute —— OpenAI 兼容传输层（自写 LlmAdapter 的内核）。
 *
 * OmniRoute 是一个自托管的 AI 网关：对外只讲 OpenAI 的 Chat Completions
 * 协议，`POST {baseURL}/chat/completions`（默认 baseURL 为
 * `http://localhost:20128/v1`），对内把 350+ 个上游供应商、路由策略、
 * 上下文压缩、语义缓存全部藏在一个 endpoint 后面。
 *
 * 这一层只做三件事，且都只做一遍：
 *
 *   1. **Harness 消息 → OpenAI 消息**（`buildRequestBody`）。
 *      harness 的历史里有 system / developer / user / assistant / tool 五种
 *      角色，以及 text / reasoning / image / file / tool-call / tool-addition /
 *      tool-removal 七种 block。OpenAI 的切法不同：developer 并进 system，
 *      reasoning 与 tool-addition/removal 对上游没有意义（丢弃），
 *      tool 结果变成 role:"tool" + tool_call_id。图片按 OmniRoute 期望的
 *      `image_url` data URL 内联发送。
 *
 *   2. **SSE → StreamChunk**（`parseSse` + `createTranslator`）。
 *      OmniRoute 透传上游的 OpenAI SSE。这里只依赖协议里真正稳定的部分：
 *      `data:` 行、`[DONE]` 终止符、`choices[0].delta` 的
 *      content / reasoning_content / reasoning / tool_calls / finish_reason，
 *      以及可选的新式 `usage`（含 `prompt_tokens_details.cached_tokens`）。
 *      未知字段一律忽略而不是报错——网关背后的上游五花八门，
 *      「多一个字段就炸」是不能接受的失败模式。
 *
 *   3. **把网关自己的响应头带出来**（`readRouteFacts`）。
 *      `X-OmniRoute-Provider` / `-Decision` / `-Response-Cost` /
 *      `-Cost-Saved` / `-Cache` 是 OmniRoute 独有的可观测性，是「到底谁答的、
 *      省了多少钱」的唯一答案。自写适配器的最大好处就是能拿到它们，
 *      所以这里不放过。
 *
 * 设计上的两条硬纪律：
 *
 *   - **认证是可选的。** 全新安装的 OmniRoute 用 `auto` 模型零密钥即可应答
 *     （keyless 的 OpenCode Free 预接在 auto combo 里）。所以「没配 key」
 *     是**正常的配置状态**，不是错误：只有「配了 key 但取不到值」才报
 *     MISSING_CREDENTIAL。
 *   - **失败要说人话。** 网关背后有 350 家上游，401/402/429/5xx 的成因和
 *     修法各不相同，所以每一种都映射到 harness 的稳定 failure code，
 *     并带上能直接指路的 message。
 *
 * @module omniroute/transport
 */

/** OpenAI 兼容 SSE 的数据行前缀。 */
const SSE_DATA_PREFIX = 'data:'

/**
 * 压缩模式：客户端通过 `x-omniroute-compression` 逐请求覆盖网关的压缩策略。
 *
 * 取值来自 OmniRoute 的压缩文档。未知取值网关会忽略（不会 400），
 * 所以这里保持成开放列表，只把最常用的几个作为界面选项。
 */
export const COMPRESSION_MODES = Object.freeze(['off', 'default', 'safe', 'allow-lossy'])

/**
 * 判断一个 HTTP 状态码是否值得重试。
 *
 * 与 dsh-llm-retry 的默认可重试集合保持同一套语言
 * （RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT），这样适配器抛出的 code
 * 与重试策略说的是同一件事。401/403/404/413/422 明确不重试：
 * 它们不会因为再试一次而变好。
 *
 * @param {number} status - 上游 HTTP 状态码。
 * @returns {{retryable: boolean, code: string}} 稳定 code 与是否可重试。
 */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return { retryable: false, code: 'AUTH' }
  if (status === 402) return { retryable: false, code: 'QUOTA' }
  if (status === 404) return { retryable: false, code: 'NO_MODEL' }
  if (status === 408) return { retryable: true, code: 'TIMEOUT' }
  if (status === 413) return { retryable: false, code: 'CONTEXT_WINDOW_EXCEEDED' }
  if (status === 429) return { retryable: true, code: 'RATE_LIMIT' }
  if (status >= 500) return { retryable: true, code: 'SERVER' }
  if (status >= 400) return { retryable: false, code: 'REQUEST' }
  return { retryable: false, code: 'TRANSPORT' }
}

/**
 * 把网关的错误响应体压成一句能读的话。
 *
 * OpenAI 兼容网关的错误体几乎都是 `{error: {message, type, code}}`，
 * 但 OmniRoute 背后有 350 家上游，偶尔会直接吐一个字符串或 HTML。
 * 解析失败不算失败——退回到截断后的原文即可，因为这段文本唯一的作用
 * 就是让人看懂该改哪里。
 *
 * @param {string} text - 响应体原文。
 * @returns {string} 供人阅读的失败摘要（可能为空）。
 */
export function describeErrorBody(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return ''
  try {
    const parsed = JSON.parse(raw)
    const error = parsed?.error
    if (typeof error === 'string' && error.trim() !== '') return error.trim()
    if (error !== null && typeof error === 'object') {
      const message = typeof error.message === 'string' ? error.message.trim() : ''
      const type = typeof error.type === 'string' ? error.type.trim() : ''
      const code = typeof error.code === 'string' ? error.code.trim() : ''
      const detail = [message, type === '' ? '' : `type=${type}`, code === '' ? '' : `code=${code}`]
        .filter(part => part !== '')
        .join(' | ')
      if (detail !== '') return detail
    }
    if (typeof parsed?.message === 'string' && parsed.message.trim() !== '') return parsed.message.trim()
  } catch {
    // 不是 JSON：按原文处理。
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw
}

/**
 * 读取网关在响应头上额外给出的路由事实。
 *
 * 这些头是 OmniRoute 相对「裸 OpenAI」多出来的全部可观测性，所以每一个都
 * 单独取值、单独容错：网关版本变化时少一个头只应该少一条信息，
 * 不应该让一次成功的请求失败。
 *
 * @param {Headers} headers - 上游响应头。
 * @returns {object|undefined} 有内容时返回事实对象，否则 undefined。
 */
export function readRouteFacts(headers) {
  if (headers === undefined || headers === null) return undefined
  /** 取一个头，空串与缺席等价。 */
  const pick = name => {
    try {
      const value = headers.get(name)
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    } catch {
      return undefined
    }
  }
  const facts = {
    provider: pick('x-omniroute-provider'),
    model: pick('x-omniroute-model'),
    decision: pick('x-omniroute-decision'),
    cache: pick('x-omniroute-cache'),
    cacheHit: pick('x-omniroute-cache-hit'),
    costSaved: pick('x-omniroute-cost-saved'),
    responseCost: pick('x-omniroute-response-cost'),
    latencyMs: pick('x-omniroute-latency-ms'),
    fallbackAttempts: pick('x-omniroute-fallback-attempts'),
    compression: pick('x-omniroute-compression'),
    version: pick('x-omniroute-version'),
  }
  return Object.values(facts).some(value => value !== undefined) ? facts : undefined
}

/**
 * 一步到位地把 OmniRoute 的路由事实渲染成一行可读文本。
 *
 * 形如：`provider=opencode-free decision=strategy=auto cache=MISS cost=$0.000`。
 * 用途是诊断（日志、卡片），因此缺字段就跳过，不补默认值——
 * 凭空补一个 `unknown` 会让人以为是网关答的。
 *
 * @param {object|undefined} facts - {@link readRouteFacts} 的结果。
 * @returns {string} 单行摘要，无事实时为空串。
 */
export function formatRouteFacts(facts) {
  if (facts === undefined || facts === null) return ''
  const parts = []
  if (facts.provider !== undefined) parts.push(`provider=${facts.provider}`)
  if (facts.model !== undefined) parts.push(`model=${facts.model}`)
  if (facts.decision !== undefined) parts.push(`decision=${facts.decision}`)
  if (facts.cache !== undefined) parts.push(`cache=${facts.cache}`)
  if (facts.responseCost !== undefined) parts.push(`cost=$${facts.responseCost}`)
  else if (facts.costSaved !== undefined) parts.push(`saved=$${facts.costSaved}`)
  if (facts.compression !== undefined) parts.push(`compression=${facts.compression}`)
  if (facts.fallbackAttempts !== undefined) parts.push(`fallbacks=${facts.fallbackAttempts}`)
  if (facts.latencyMs !== undefined) parts.push(`latency=${facts.latencyMs}ms`)
  return parts.join(' ')
}

/**
 * 把 harness 的一条消息投成 OpenAI 的 message 对象。
 *
 * 返回 `undefined` 表示这条消息对上游没有意义，应当整条丢弃
 * （例如只含 tool-addition 的 developer 消息）。这一点很重要：
 * 发一条 content 为空串的消息给上游，比不发更容易触发上游的 400。
 *
 * @param {object} message - harness 的 Message（或请求期 user 输入）。
 * @returns {object|undefined} OpenAI 消息。
 */
function projectMessage(message) {
  const role = message?.role
  const content = Array.isArray(message?.content) ? message.content : []

  if (role === 'tool') {
    // tool 结果：OpenAI 只接受纯文本，且必须用 tool_call_id 对上之前的调用。
    const text = content
      .map(block => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .join('')
    return { role: 'tool', tool_call_id: String(message.toolCallId ?? ''), content: text }
  }

  if (role === 'assistant') {
    const text = content
      .filter(block => block?.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('')
    const calls = content.filter(block => block?.type === 'tool-call')
    // 既没有文本也没有调用：上游会把它当成非法消息，丢弃比发出去安全。
    if (text === '' && calls.length === 0) return undefined
    const projected = { role: 'assistant', content: text }
    if (calls.length > 0) {
      projected.tool_calls = calls.map(block => ({
        id: String(block.id ?? ''),
        type: 'function',
        function: {
          name: String(block.name ?? ''),
          // harness 约定 arguments 始终是原始 JSON 字符串；上游要的也是字符串。
          arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
        },
      }))
    }
    return projected
  }

  // system / developer / user 都走「文本 + 图片」这条路径。
  // developer 是 harness 的增量工具声明通道，OpenAI 没有对应角色，
  // 并进 system 是最接近语义的投影（它本来就是给模型的指令）。
  const parts = []
  for (const block of content) {
    if (block?.type === 'text') {
      const text = String(block.text ?? '')
      if (text !== '') parts.push({ type: 'text', text })
      continue
    }
    if (block?.type === 'image') {
      const url = block?.dataUrl
      // 上层已经把图读成 data URL；读不到（附件没了、被 offload 了）
      // 就退化成一行占位文本，而不是发一个坏 URL 让上游 400。
      if (typeof url === 'string' && url !== '') parts.push({ type: 'image_url', image_url: { url } })
      else parts.push({ type: 'text', text: '[image omitted]' })
    }
  }
  if (parts.length === 0) return undefined
  const target = role === 'developer' ? 'system' : role
  if (parts.length === 1 && parts[0].type === 'text') return { role: target, content: parts[0].text }
  return { role: target, content: parts }
}

/**
 * 组装一次 Chat Completions 请求体。
 *
 * `system`（一次性调用者的独立系统提示）会被前置成第一条 system 消息，
 * 这与 harness 的约定一致：循环构建的请求把系统提示放在 messages 的
 * 第一条 system 里，`system` 字段只有一次性调用者会填。
 *
 * @param {object} request - 归一化后的请求描述。
 * @returns {object} OpenAI Chat Completions 请求体。
 */
export function buildRequestBody(request) {
  const messages = []
  if (typeof request.system === 'string' && request.system !== '') {
    messages.push({ role: 'system', content: request.system })
  }
  for (const message of request.messages ?? []) {
    const projected = projectMessage(message)
    if (projected !== undefined) messages.push(projected)
  }

  const body = {
    model: request.model,
    messages,
    stream: true,
    // 让网关在流末尾补一个 usage 帧。OpenAI 官方与绝大多数兼容网关都认这个字段；
    // 不认的网关只是不回 usage，不会 400。
    stream_options: { include_usage: true },
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map(schema => ({
      type: 'function',
      function: {
        name: String(schema?.name ?? ''),
        description: String(schema?.description ?? ''),
        parameters: schema?.parameters ?? { type: 'object', properties: {} },
      },
    }))
    body.tool_choice = 'auto'
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxTokens === 'number' && request.maxTokens > 0) body.max_tokens = request.maxTokens
  return body
}

/**
 * 把 harness 的 provider / model 路由拆成网关真正认识的两个值。
 *
 * harness 的路由是 `provider` + `model` 两段，而 OmniRoute 的 `model` 字段
 * 本身还可以带一个 `供应商/模型` 前缀或 `供应商::模型` 双冒号前缀来做 pin。
 * 所以规则是：模型 id 里**显式**写了 `a/b` 或 `a::b`（用户在模型选择器里
 * 手输的），原样透传，让网关的 pin 语义生效（网关会自己剥掉前缀再转发）。
 *
 * 这样 `omniroute/auto` 得到「交给网关的 auto 组合」，
 * 而 `omniroute/openrouter::gpt-5` 得到「pin 到 openrouter 的 gpt-5」。
 *
 * @param {string} model - harness 传来的 model id。
 * @returns {{model: string, pinnedProvider: string|undefined}} 拆分结果。
 */
export function splitRoute(model) {
  const raw = typeof model === 'string' ? model : ''
  const doubleColon = raw.indexOf('::')
  if (doubleColon > 0) return { model: raw, pinnedProvider: raw.slice(0, doubleColon) }
  const slash = raw.indexOf('/')
  if (slash > 0 && slash < raw.length - 1) return { model: raw, pinnedProvider: raw.slice(0, slash) }
  return { model: raw, pinnedProvider: undefined }
}

/**
 * 读一行 SSE，返回它承载的事件（如果需要上报）。
 * @param {string} line - 一行（已去掉行尾符）。
 * @returns {{done: true}|{payload: string}|undefined} 事件，或无关行。
 */
function readLine(line) {
  if (line === '') return undefined
  if (line.startsWith(':')) return undefined // SSE 注释 / 心跳
  if (!line.startsWith(SSE_DATA_PREFIX)) return undefined
  const payload = line.slice(SSE_DATA_PREFIX.length).trim()
  if (payload === '') return undefined
  if (payload === '[DONE]') return { done: true }
  return { payload }
}

/**
 * 解析上游的 SSE 字节流，逐条产出 `data:` 载荷。
 *
 * 三个必须处理对的细节：
 *   - **跨 chunk 断行**：一个 `data:` 行可能被 TCP 切成两半，所以保留
 *     未完成的行尾巴，等下个 chunk 拼回来；
 *   - **注释与心跳**：以 `:` 开头的行是 SSE 注释，必须忽略；
 *   - **`[DONE]`**：OpenAI 兼容流的终止符，作为终止信号单独上报，
 *     不当作 JSON 解析。
 *
 * @param {ReadableStream<Uint8Array>} body - 上游响应体。
 * @param {AbortSignal|undefined} signal - 取消信号。
 * @yields {{done: true}|{payload: string}} 终止标记或一条 data 载荷。
 */
export async function* parseSse(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted === true) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 的行分隔符可以是 \n / \r\n / \r，统一按 \n 切。
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        const event = readLine(line)
        if (event !== undefined) {
          yield event
          if (event.done === true) return
        }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') {
      const event = readLine(buffer.replace(/\r$/, ''))
      if (event !== undefined) yield event
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 取消一个已经结束的流不是错误。
    }
  }
}

/**
 * 把一条 SSE JSON 片段里的增量整理成「我们认识的形状」。
 *
 * 这里刻意容忍几种上游风格：
 *   - 标准 OpenAI：`choices[0].delta.content` + `tool_calls[]`；
 *   - 带思维链的上游（DeepSeek / Z.ai / vLLM 等）：追加
 *     `delta.reasoning_content`、`delta.reasoning`，或顶层的 `reasoning`。
 * 还容忍 `choices` 为空数组的 usage-only 帧，以及带 `error` 的帧。
 *
 * @param {string} payload - 一条 `data:` 的 JSON 文本。
 * @returns {object|undefined} 整理后的事件，无法理解时 undefined。
 */
export function readChunk(payload) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
  const delta = choice !== null && typeof choice?.delta === 'object' && choice.delta !== null ? choice.delta : {}
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined

  let text = ''
  if (typeof delta.content === 'string') text = delta.content
  else if (typeof choice?.text === 'string') text = choice.text

  // 思维链字段在不同上游叫不同名字，全收。
  let reasoning = ''
  if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
  else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning
  if (typeof parsed.reasoning === 'string') reasoning += parsed.reasoning

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined
  const usage = parsed.usage !== null && typeof parsed.usage === 'object' ? parsed.usage : undefined
  const error = parsed.error !== null && typeof parsed.error === 'object' ? parsed.error : undefined

  return { delta, text, reasoning, toolCalls, finishReason, usage, error }
}

/**
 * 一个数若为有限非负数则取它，否则取兜底值。
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 兜底值。
 * @returns {number} 结果。
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 把 OpenAI 的 usage 折算成 harness 的 TokenUsage。
 *
 * 关键差别在**口径**：harness 要求输入侧是「互不重叠」的三个数
 * （未缓存输入 / 缓存读 / 缓存写），而 OpenAI 系协议报的 `prompt_tokens`
 * 是**含缓存的总额**。所以这里必须把缓存命中量减出去，否则每一次带缓存
 * 命中的对话都会把输入 token 重复计一遍，直接体现在上下文预算和成本估算上。
 *
 * @param {object} usage - OpenAI 风格的 usage 对象。
 * @returns {object} harness 的 TokenUsage。
 */
export function projectUsage(usage) {
  const prompt = numberOr(usage?.prompt_tokens, 0)
  const completion = numberOr(usage?.completion_tokens, 0)
  const details = usage?.prompt_tokens_details ?? usage?.prompt_tokensDetails
  const cachedRead = numberOr(details?.cached_tokens, numberOr(details?.cachedTokens, 0))
  const cacheWrite = numberOr(details?.cache_write_tokens, 0)
  const reasoning = numberOr(
    usage?.completion_tokens_details?.reasoning_tokens,
    numberOr(usage?.reasoning_tokens, 0),
  )

  // 缓存读 + 缓存写都不能超过 prompt 总额，且两者本身不重叠。
  const billedCacheRead = Math.max(0, Math.min(cachedRead, prompt))
  const billedCacheWrite = Math.max(0, Math.min(cacheWrite, prompt - billedCacheRead))
  const inputTokens = Math.max(0, prompt - billedCacheRead - billedCacheWrite)

  const projected = {
    inputTokens,
    outputTokens: completion,
    totalTokens: numberOr(usage?.total_tokens, prompt + completion),
  }
  if (billedCacheRead > 0) projected.cacheReadTokens = billedCacheRead
  if (billedCacheWrite > 0) projected.cacheWriteTokens = billedCacheWrite
  if (reasoning > 0) projected.reasoningTokens = reasoning
  return projected
}

/**
 * 把上游的 finish_reason 映射成 harness 的终止原因。
 *
 * 认不出来的一律落到 `stop`：一个未知字符串会让下游对 `kind` 的判断全部
 * 落空；退化成正常结束至少不会把一次成功的回答变成错误。
 *
 * @param {string|undefined} reason - OpenAI 的 finish_reason。
 * @returns {object} harness 的 FinishReason。
 */
export function projectFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 把一段 OpenAI 流的增量状态翻译成 harness 的 StreamChunk 序列。
 *
 * 形态说明：这是一个**有状态**的转换器，因为 harness 的协议要求
 * `block-start` / 增量 / `block-end` 三段式且索引连贯，而上游是纯增量、
 * 不告诉你「这一段文本结束了」。所以转换器自己维护索引与「当前打开的是
 * 哪个 block」：
 *
 *   - 遇到第一段文本 → 开一个 text block；
 *   - 文本中间夹进思维链 → 先关掉文本 block，再开 reasoning block
 *     （两种内容不能共用一个 block，否则阅读区会把思考当成回答显示）；
 *   - 工具调用按上游给的 `index` 独立成块，id 与 name 可能只在第一帧出现，
 *     所以要记住它们，后续只有 arguments 增量。
 *
 * @returns {object} 转换器：`push(event)` 产出流片段，`finish(facts)` 收尾。
 */
export function createTranslator() {
  /** 下一个可用的 block 索引（单调递增，关闭后不复用）。 */
  let nextIndex = 0
  /** 当前打开的 block：`{index, type, text}` 或 undefined。 */
  let open
  /** tool_calls 的上游 index → `{index, id, name, args}`。 */
  const toolBlocks = new Map()
  let usedUsage
  let finishReason
  let sawContent = false

  /** 关闭当前打开的 block，产出它的 block-end。 */
  function closeOpen() {
    if (open === undefined) return []
    const chunk = { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } }
    open = undefined
    return [chunk]
  }

  return {
    /**
     * 吃一条 {@link readChunk} 的结果，产出 harness 的流片段。
     * @param {object} event - readChunk 的返回值。
     * @returns {Array} StreamChunk 列表（可能为空）。
     */
    push(event) {
      const out = []
      if (event === undefined) return out

      // 思维链与可见文本是两种 block：上游把它们交错发来时，
      // 谁先出现谁先收尾，避免两个 block 抢同一个 index。
      if (event.reasoning !== '') {
        if (open !== undefined && open.type !== 'reasoning') out.push(...closeOpen())
        if (open === undefined) {
          open = { index: nextIndex++, type: 'reasoning', text: '' }
          out.push({ type: 'block-start', index: open.index, blockType: 'reasoning' })
        }
        open.text += event.reasoning
        sawContent = true
        out.push({ type: 'reasoning-delta', index: open.index, text: event.reasoning })
      }

      if (event.text !== '') {
        if (open !== undefined && open.type !== 'text') out.push(...closeOpen())
        if (open === undefined) {
          open = { index: nextIndex++, type: 'text', text: '' }
          out.push({ type: 'block-start', index: open.index, blockType: 'text' })
        }
        open.text += event.text
        sawContent = true
        out.push({ type: 'text-delta', index: open.index, text: event.text })
      }

      for (const call of event.toolCalls ?? []) {
        const key = typeof call?.index === 'number' ? call.index : 0
        let slot = toolBlocks.get(key)
        if (slot === undefined) {
          // 工具调用一出现就说明「说话」阶段结束了。
          if (open !== undefined) out.push(...closeOpen())
          slot = { index: nextIndex++, id: '', name: '', args: '' }
          toolBlocks.set(key, slot)
          out.push({ type: 'block-start', index: slot.index, blockType: 'tool-call' })
        }
        if (typeof call?.id === 'string' && call.id !== '') slot.id = call.id
        if (typeof call?.function?.name === 'string' && call.function.name !== '') slot.name = call.function.name
        const argsDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
        if (argsDelta !== '') {
          slot.args += argsDelta
          sawContent = true
          if (slot.id === '') slot.id = `call_${String(slot.index)}`
          out.push({
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.id,
            ...(slot.name === '' ? {} : { name: slot.name }),
            argumentsDelta: argsDelta,
          })
        }
      }

      if (event.usage !== undefined) usedUsage = projectUsage(event.usage)
      if (event.finishReason !== undefined) finishReason = event.finishReason
      return out
    },

    /**
     * 收尾：关闭所有还开着的 block，产出 usage 与 finish。
     *
     * 顺序是协议规定的：usage 必须在终止帧之前，终止帧之后不能再有内容。
     *
     * @param {object|undefined} routeFacts - 网关响应头里读到的路由事实，
     *   作为 replayState 的一部分落盘，供卡片与诊断读取。
     * @returns {Array} 收尾的 StreamChunk 列表。
     */
    finish(routeFacts) {
      const out = []
      if (open !== undefined) out.push(...closeOpen())
      for (const slot of toolBlocks.values()) {
        out.push({
          type: 'block-end',
          index: slot.index,
          block: {
            type: 'tool-call',
            id: slot.id === '' ? `call_${String(slot.index)}` : slot.id,
            name: slot.name,
            arguments: slot.args,
          },
        })
      }
      if (usedUsage !== undefined) out.push({ type: 'usage', usage: usedUsage })
      const reason = finishReason ?? (toolBlocks.size > 0 ? 'tool_calls' : 'stop')
      const replayState = routeFacts === undefined ? undefined : { response: { omniroute: routeFacts } }
      out.push({
        type: 'finish',
        reason: projectFinishReason(reason),
        ...(replayState === undefined ? {} : { replayState }),
      })
      return out
    },

    /** 这一次流里是否出现过任何真实内容（用于识别「空应答」）。 */
    get sawContent() {
      return sawContent
    },

    /** 上游给的终止原因原文。 */
    get rawFinishReason() {
      return finishReason
    },
  }
}
