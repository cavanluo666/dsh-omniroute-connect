/**
 * 上游客户端：把一次请求发给**一个**上游，并读回它的流。
 *
 * 这一层只负责「怎么和一家上游说话」，不负责「该找谁」——
 * 后者是 router 的事。切分点就在这里：router 决定顺序，
 * upstream 执行单次尝试，gateway 把两者接起来。
 *
 * ## 两种上游方言
 *
 * 绝大多数上游是标准 OpenAI Chat Completions。但内置的免密钥通道
 * （opencode.ai）不是——它的免费层校验一组客户端指纹请求头，
 * 缺了就 403。所以这里用 `kind` 区分：
 *
 *   - `undefined` / `'openai'` → 标准 OpenAI 兼容；
 *   - `'opencode-free'` → 加上那组指纹头，并用池化凭据 `Bearer public`。
 *
 * 指纹那部分的依据是 opencode.ai 网关的公开行为，沿用已验证的部分，不猜。
 *
 * ## 单一职责的边界
 *
 * 这个模块**不**知道 harness 的 StreamChunk。它返回的是
 * 「一条 SSE 事件流 + 一个响应头读取器」，由 transport.js 负责翻译。
 * 这样路由与回退逻辑（router）不需要任何 OpenAI 协议知识，
 * 而协议翻译（transport）不需要任何路由知识。
 *
 * @module omniroute/upstream
 */

import { describeErrorBody, classifyStatus, parseSse, readChunk } from './transport.js'

/** 免密钥通道要求的客户端版本门槛（>= 1.17 才被网关接受）。 */
const FREE_LANE_UA = 'opencode/1.18.31'

/** 免费层要求声明的工具四元组（缺了会 403 FreeTierError）。 */
export const FREE_LANE_FINGERPRINT_TOOLS = Object.freeze(['bash', 'glob', 'grep', 'read'])

/**
 * 拼一个上游的 endpoint，保留 baseURL 里已有的路径段。
 * @param {string} baseURL - 上游基础地址。
 * @param {string} path - 相对路径。
 * @returns {string} 完整 URL。
 */
export function upstreamUrl(baseURL, path) {
  const base = String(baseURL ?? '').replace(/\/+$/, '')
  return `${base}/${String(path).replace(/^\/+/, '')}`
}

/**
 * 构造发给一个上游的请求头。
 *
 * @param {object} upstream - 上游条目。
 * @param {object} options - 选项。
 * @param {boolean} options.stream - 是否流式。
 * @param {string|undefined} options.sessionId - 会话标识（免密钥通道要它做配额记账）。
 * @param {string|undefined} options.requestId - 本次请求标识。
 * @returns {Record<string, string>} 请求头。
 */
export function upstreamHeaders(upstream, options) {
  const headers = {
    'content-type': 'application/json',
    accept: options.stream === true ? 'text/event-stream' : 'application/json',
    // 出站请求必须带 attribution，这是 dsh-llm 的适配器契约。
    'user-agent': 'dsh-omniroute-connect/0.2.0',
  }

  if (upstream.kind === 'opencode-free') {
    // 免费层：池化凭据 + 一组客户端指纹头。缺任何一个都会被 403。
    headers.authorization = 'Bearer public'
    headers['user-agent'] = FREE_LANE_UA
    headers['x-opencode-client'] = 'desktop'
    headers['x-opencode-project'] = 'global'
    headers['x-opencode-session'] = options.sessionId ?? 'ses_000000000000000000000000'
    headers['x-opencode-request'] = options.requestId ?? 'msg_000000000000000000000000'
    return headers
  }

  if (typeof upstream.apiKey === 'string' && upstream.apiKey !== '') {
    headers.authorization = `Bearer ${upstream.apiKey}`
  }
  return headers
}

/**
 * 把 harness 的请求体适配成一个上游要的形状。
 *
 * 目前只做一件必要的事：免密钥通道的免费层要求请求里声明那四个工具名，
 * 否则 403。所以把调用方给的工具列表**并上**四元组里缺的那些。
 *
 * 刻意不删任何调用方的工具——四元组是**额外**要求的，
 * 不是用来替换的。删掉调用方的工具会让模型失去它真正需要的工具。
 *
 * @param {object} body - 已经组装好的 OpenAI 请求体。
 * @param {object} upstream - 上游条目。
 * @param {Array|undefined} callerTools - 调用方原本声明的工具。
 * @returns {object} 适配后的请求体。
 */
export function adaptBodyForUpstream(body, upstream, callerTools) {
  if (upstream.kind !== 'opencode-free') return body
  const declared = new Set((body.tools ?? []).map(tool => tool?.function?.name))
  const missing = FREE_LANE_FINGERPRINT_TOOLS.filter(name => !declared.has(name))
  if (missing.length === 0) return body

  // 四元组用最小可用的 JSON Schema：它们的唯一作用是通过指纹校验，
  // 模型会不会调用它们取决于调用方的提示，不由这里决定。
  const fingerprints = missing.map(name => ({
    type: 'function',
    function: {
      name,
      description: `Declared for client fingerprint compatibility (${name}).`,
      parameters: { type: 'object', properties: {} },
    },
  }))
  return { ...body, tools: [...(body.tools ?? []), ...fingerprints], tool_choice: body.tool_choice ?? 'auto' }
}

/**
 * 模型 id 的「基础 id」：去掉末尾的 `(level)` 之类的思考档位后缀。
 * @param {string} model - 模型 id。
 * @returns {string} 基础 id。
 */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

/**
 * 向一个上游发起一次流式请求。
 *
 * 返回值刻意分成两半，因为调用方对它们的处理时机完全不同：
 *   - `ok: false` 时**请求已经失败**，可以直接拿 `code`/`message` 去记账和回退；
 *   - `ok: true` 时**请求还没真正成功**（HTTP 200 已经到手，但流里可能
 *     还有错误帧），所以返回一个迭代器交给上层边读边判断。
 *
 * 这个区分是必要的：一个 200 + 流内 error 帧的响应，只有读完才知道失败，
 * 而那时已经不能再「回退到上一个 HTTP 请求」了——只能把它当成
 * 一次失败的尝试记账。
 *
 * @param {object} input - 输入。
 * @param {object} input.upstream - 目标上游。
 * @param {object} input.body - 要发送的 OpenAI 请求体（stream 必须为 true）。
 * @param {Array|undefined} input.callerTools - 调用方声明的工具。
 * @param {string|undefined} input.sessionId - 会话标识。
 * @param {AbortSignal|undefined} input.signal - 取消信号。
 * @returns {Promise<object>} 结果。
 */
export async function postStream(input) {
  const { upstream } = input
  const url = upstreamUrl(upstream.baseURL, 'chat/completions')
  const headers = upstreamHeaders(upstream, {
    stream: true,
    sessionId: input.sessionId,
    requestId: input.requestId,
  })
  const payload = adaptBodyForUpstream(input.body, upstream, input.callerTools)

  // 每个上游有自己的超时，也要能被调用方的 signal 取消。
  // 两个取消源合成一个：上游超时不该表现为「用户取消」，
  // 所以用 AbortController 链接，并自己区分是谁触发的。
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, upstream.timeoutMs)
  let timedOut = false
  const onTimeout = () => { timedOut = true }
  const timeoutSignal = controller.signal
  timeoutSignal.addEventListener?.('abort', onTimeout)
  const relay = () => { controller.abort() }
  if (input.signal !== undefined) {
    if (input.signal.aborted === true) {
      clearTimeout(timer)
      return { ok: false, code: 'ABORTED', message: '请求已被调用方取消' }
    }
    input.signal.addEventListener('abort', relay, { once: true })
  }

  /** 收尾：清定时器与外部 signal 的监听。 */
  const cleanup = () => {
    clearTimeout(timer)
    input.signal?.removeEventListener?.('abort', relay)
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    cleanup()
    if (input.signal?.aborted === true) return { ok: false, code: 'ABORTED', message: '请求已被调用方取消' }
    const detail = error instanceof Error ? error.message : String(error)
    if (timedOut) {
      return {
        ok: false,
        code: 'TIMEOUT',
        message: `上游 ${upstream.name} 在 ${String(upstream.timeoutMs)}ms 内没有响应`,
      }
    }
    return { ok: false, code: 'TRANSPORT', message: `连不上上游 ${upstream.name}（${url}）：${detail}` }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    cleanup()
    const verdict = classifyStatus(response.status)
    const detail = describeErrorBody(text)
    return {
      ok: false,
      code: verdict.code,
      status: response.status,
      message: `${upstream.name} 返回 HTTP ${String(response.status)}：${detail === '' ? '未给出原因' : detail}`,
    }
  }

  if (response.body === null) {
    cleanup()
    return { ok: false, code: 'TRANSPORT', message: `${upstream.name} 返回了空响应体` }
  }

  return {
    ok: true,
    upstream,
    url,
    headers: response.headers,
    /**
     * 逐条产出这个上游的数据帧；每条已解析成 transport 认识的形状。
     * 读到 `done` 就结束。调用方负责决定哪些算真实内容。
     * @yields {{done: true}|{chunk: object}}
     */
    async * frames() {
      try {
        for await (const event of parseSse(response.body, controller.signal)) {
          if (event.done === true) {
            yield { done: true }
            return
          }
          if (event.payload === undefined) continue
          const chunk = readChunk(event.payload)
          if (chunk !== undefined) yield { chunk }
        }
        yield { done: true }
      } finally {
        cleanup()
      }
    },
  }
}

/**
 * 探测一个上游：它活着吗？它有哪些模型？
 *
 * 用 `GET {baseURL}/models`，这是 OpenAI 兼容上游的通用约定。
 * 有的上游不实现它（404），那**不代表上游不可用**——所以这种情况
 * 单独归类成 `no-listing`，而不是失败。
 *
 * @param {object} upstream - 上游条目。
 * @param {AbortSignal|undefined} signal - 取消信号。
 * @returns {Promise<object>} 探测结果，永远不抛。
 */
export async function probeUpstream(upstream, signal) {
  const url = upstreamUrl(upstream.baseURL, 'models')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, Math.min(upstream.timeoutMs, 15000))
  const relay = () => { controller.abort() }
  if (signal !== undefined) signal.addEventListener('abort', relay, { once: true })
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: upstreamHeaders(upstream, { stream: false }),
      signal: controller.signal,
    })
    const elapsedMs = Date.now() - started
    if (response.status === 404 || response.status === 405) {
      return { status: 'no-listing', url, elapsedMs, message: '上游没有实现 /models 列表接口' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const verdict = classifyStatus(response.status)
      return {
        status: 'http-error',
        url,
        elapsedMs,
        httpStatus: response.status,
        code: verdict.code,
        message: `HTTP ${String(response.status)}：${describeErrorBody(text) || '未给出原因'}`,
      }
    }
    const body = await response.json().catch(() => undefined)
    const rows = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : undefined)
    if (rows === undefined) {
      return { status: 'no-listing', url, elapsedMs, message: '上游的 /models 不是 OpenAI 的形状' }
    }
    const models = []
    const seen = new Set()
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      models.push({
        id,
        name: typeof row?.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id,
        ...(typeof row?.context_length === 'number' ? { contextWindow: row.context_length } : {}),
        ...(typeof row?.max_output_tokens === 'number' ? { maxTokens: row.max_output_tokens } : {}),
      })
    }
    return { status: 'ready', url, elapsedMs, models, message: `发现 ${String(models.length)} 个模型` }
  } catch (error) {
    const elapsedMs = Date.now() - started
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      status: aborted ? 'timeout' : 'unreachable',
      url,
      elapsedMs,
      message: aborted
        ? `${String(elapsedMs)}ms 内没有响应`
        : `连不上：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', relay)
  }
}
