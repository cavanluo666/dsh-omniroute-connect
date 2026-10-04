/**
 * OmniRoute 的 LlmAdapter 实现。
 *
 * 这个插件**自己就是网关**，所以这一层比「转发给一个外部网关」薄得多：
 * 它只做三件事，其余全部交给 gateway.js。
 *
 *   1. **把 harness 的图片变成 data URL**（`inlineMessageImages`）。
 *      harness 的图片是耐久附件引用，而上游的视觉入口要 `image_url`。
 *   2. **把请求交给网关**（`runGateway`）——路由、回退、断路器、
 *      竞速都在那里，这一层不掺和决策。
 *   3. **实现 LlmAdapter 的元数据方法**（providerInfo / listModels /
 *      resolveModel / prepareCall），让模型选择器能看到这个 provider。
 *
 * ## 为什么这些方法必须存在
 *
 * harness 的 `registerAdapter` 是**结构化校验**的（按方法存在与否判断），
 * 所以缺一个方法会在注册时报错，而不是在调用时才炸。这一点比继承
 * 一个基类更宽容，也意味着「契约」完全由这个方法集合定义。
 *
 * ## 图片为什么要在这里处理
 *
 * 因为它是**唯一**需要 harness 特有服务的环节（附件存储、路径映射），
 * 而网关本身应该对 harness 一无所知——那样它才能被单独测试，
 * 也才能被理解为「一个普通的 OpenAI 兼容层」。
 *
 * @module omniroute/adapter
 */

import { runGateway } from './gateway.js'
import { baseModelId } from './gateway-upstream.js'
import { collectModels, upstreamServes } from './gateway-model.js'

/** 一个请求最多内联多少图片字节（base64 之前的原始字节）。 */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024

/** 图片编码的并发上限：一张图一次，避免大附件把内存顶上去。 */
const IMAGE_READ_CONCURRENCY = 3

/**
 * 把一批 harness 图片 block 解析成 data URL 并就地替换。
 *
 * 逐条容错是刻意的：「图没了」和「请求失败」对这个 harness 是完全不同的
 * 后果——前者模型还能接着聊，后者会把整个 turn 打断。
 * 而 350 家上游里有的根本不支持视觉，有的单张限额很小。
 *
 * @param {Array} content - 一条消息的 content block 列表。
 * @param {object|undefined} deps - 运行时依赖（attachments）。
 * @param {AbortSignal|undefined} signal - 取消信号。
 * @returns {Promise<Array>} 投影后的 content（不改原数组）。
 */
async function inlineImages(content, deps, signal) {
  const hasImage = content.some(block => block?.type === 'image')
  if (!hasImage) return content

  const attachments = deps?.getAttachments?.()
  const out = []
  const queue = []

  for (const block of content) {
    if (block?.type !== 'image') {
      out.push(block)
      continue
    }
    if (typeof block.dataUrl === 'string' && block.dataUrl !== '') {
      out.push(block)
      continue
    }
    // 先放占位，读到字节后补上 dataUrl。transport 会把没有 dataUrl 的
    // 图片投影成一行说明文本，而不是发一个坏 URL 让上游 400。
    const placeholder = { type: 'image', mediaType: block.attachment?.mediaType }
    out.push(placeholder)
    if (attachments === undefined) continue
    if (typeof block.attachment?.bytes === 'number' && block.attachment.bytes > MAX_INLINE_IMAGE_BYTES) continue

    queue.push((async () => {
      try {
        const stored = await attachments.readImage(block.attachment, signal)
        const bytes = stored?.data ?? stored?.bytes
        if (bytes === undefined || bytes === null) return
        const mediaType = stored?.mediaType ?? block.attachment?.mediaType ?? 'image/png'
        placeholder.dataUrl = `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
      } catch {
        // 读不出来就保留占位。
      }
    })())
  }

  for (let index = 0; index < queue.length; index += IMAGE_READ_CONCURRENCY) {
    await Promise.all(queue.slice(index, index + IMAGE_READ_CONCURRENCY))
  }
  return out
}

/**
 * 一次性把整条历史的图片都补上 dataUrl。
 * @param {Array} messages - harness 的请求消息列表。
 * @param {object|undefined} deps - 运行时依赖。
 * @param {AbortSignal|undefined} signal - 取消信号。
 * @returns {Promise<Array>} 投影后的消息列表。
 */
async function inlineMessageImages(messages, deps, signal) {
  const out = []
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content) || !message.content.some(block => block?.type === 'image')) {
      out.push(message)
      continue
    }
    out.push({ ...message, content: await inlineImages(message.content, deps, signal) })
  }
  return out
}

/**
 * 构造 OmniRoute 适配器的类。
 *
 * 之所以是「工厂返回类」而不是「导出类」：`LlmAdapter` 基类只能从运行时
 * 拿到（profile 的 node_modules 里没有 @deepseek-ai/*）。但**继承不是
 * 必需的**——harness 按方法做结构化校验，所以这里的类可以平平常常。
 * 继承运行时基类只是为了「万一 harness 给基类加了新的默认实现」时
 * 能自动跟上，是个加分项而不是前提。
 *
 * @param {Function|undefined} BaseClass - 运行时的 `LlmAdapter`（可选）。
 * @returns {Function} 可实例化的适配器类。
 */
export function createAdapterClass(BaseClass) {
  /** 有基类就继承它，没有就用一个空基类。 */
  const Base = typeof BaseClass === 'function' ? BaseClass : class {}

  return class OmniRouteAdapter extends Base {
    /**
     * @param {object} options - 运行时依赖。
     * @param {() => object} options.resolveConfig - 每次操作读一次当前配置。
     * @param {() => object|undefined} options.getAttachments - 当前的附件服务。
     * @param {object} options.health - 健康记录（跨请求存活，由插件持有）。
     * @param {(facts: object) => void} [options.onRoute] - 记录一次请求的路由结果。
     */
    constructor(options) {
      super()
      this.deps = options
    }

    /** 读一次当前配置快照。 */
    snapshot() {
      return this.deps.resolveConfig()
    }

    /**
     * 这个 route 显示成什么名字。
     * @param {string} provider - 注册的 route 名。
     * @returns {{id: string, name: string}} 元数据。
     */
    providerInfo(provider) {
      return { id: provider, name: this.snapshot().displayName }
    }

    /**
     * 这个 route 自己的重试策略。
     *
     * 返回**完全解析好的**策略（字段在顶层），不是配置片段。
     * 这一点有个真实的坑：harness 把这个对象原样存下来，
     * 而退避调度器读的是顶层的延迟字段；把延迟嵌在 `backoff` 下面
     * 会让每次调度延迟变成 NaN，然后被耐久会话日志拒绝——
     * 一个可恢复的瞬时故障就变成了一个中止的 turn。
     *
     * 这里返回 `undefined`，表示「用 harness 的默认策略」：回退到别的上游
     * 是我们自己的事（gateway 做），不需要 harness 再叠一层重试。
     *
     * @returns {undefined} 用默认策略。
     */
    providerRetryPolicy() {
      return undefined
    }

    /**
     * 建议性的模型目录：模型选择器的下拉用它。
     *
     * 返回所有上游声称服务的模型的**并集**。没有配置任何上游时，
     * 内置的免密钥上游会在这里（它在 normalizeUpstreams 里被补上），
     * 所以全新安装也有东西可选。
     *
     * @param {string} provider - 注册的 route 名。
     * @returns {Promise<Array>} 模型元数据列表。
     */
    async listModels(provider) {
      const snapshot = this.snapshot()
      return collectModels(snapshot.upstreams).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
        // 描述里写清「谁能服务它」，选择器上就能看出这条是否有回退。
        description: model.servedBy.length > 1
          ? `${String(model.servedBy.length)} 个上游可服务`
          : `仅 ${model.servedBy[0] ?? '内置'} 可服务`,
      }))
    }

    /**
     * 精确模型的元数据。
     *
     * 已知的用已知容量；未知的（用户手输的 id）退到配置里的
     * `defaultContextWindow`。**绝不因为「没查到」就拒绝请求**：
     * 网关会自己路由，harness 只是缺一个用于压缩触发的数字，
     * 用保守的默认值远好过让人打不出字。
     *
     * @param {string} provider - 注册的 route 名。
     * @param {string} model - 精确模型 id。
     * @returns {Promise<object>} 模型元数据。
     */
    async resolveModel(provider, model) {
      const config = this.snapshot()
      const id = baseModelId(model)
      const known = collectModels(config.upstreams).find(entry => entry.id === id)
      const resolved = {
        provider,
        id,
        name: known?.name ?? id,
        context: { contextWindow: known?.contextWindow ?? config.defaultContextWindow },
      }
      if (known?.inputModalities !== undefined) resolved.inputModalities = known.inputModalities
      const defaultMaxTokens = known?.maxTokens ?? config.defaultMaxTokens
      if (defaultMaxTokens > 0) resolved.defaultMaxTokens = defaultMaxTokens
      return resolved
    }

    /**
     * 把模型元数据与之后的 dispatch 绑到同一代配置上。
     *
     * 这是热改安全的关键：返回的 `stream` 闭包捕获**此刻**的配置快照。
     * 如果用户在请求飞行途中改了上游列表或策略，正在飞的那一次仍然
     * 按旧的配置走完，而不是「用旧策略配新上游列表」这种半新半旧的状态。
     *
     * @param {string} provider - 注册的 route 名。
     * @param {string} model - 精确模型 id。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<{model: object, stream: Function}>} 绑定好的一代。
     */
    async prepareCall(provider, model, signal) {
      const snapshot = this.snapshot()
      const resolved = await this.resolveModel(provider, model)
      return {
        model: resolved,
        stream: options => this.generate(options, snapshot, signal),
      }
    }

    /**
     * 发一次请求（未绑定代的入口）。
     * @param {object} options - harness 的 GenerateOptions。
     * @returns {AsyncIterable<object>} StreamChunk 流。
     */
    stream(options) {
      return this.generate(options, this.snapshot(), options?.signal)
    }

    /**
     * 把请求交给网关。
     *
     * 刻意不用 `async *`：整个函数体要在**第一次 await 之前**就确定
     * 是同步抛错还是返回流，否则 instantiate 阶段抛出的错误会被包进
     * Promise 里，harness 的 adapterStream 就分不清「没建起来」和
     * 「建起来了但流炸了」。用一个自制的 async iterable 能同时满足两边。
     *
     * @param {object} options - harness 的 GenerateOptions。
     * @param {object} snapshot - 本次请求绑定的配置快照。
     * @param {AbortSignal|undefined} outerSignal - prepareCall 传入的信号。
     * @returns {AsyncIterable<object>} StreamChunk 流。
     */
    generate(options, snapshot, outerSignal) {
      const self = this
      const signal = options?.signal ?? outerSignal
      return {
        async *[Symbol.asyncIterator]() {
          const messages = await inlineMessageImages(options.messages, self.deps, signal)
          yield* runGateway({
            messages,
            options,
            snapshot,
            health: self.deps.health,
            signal,
            onRoute: facts => {
              // 记住这次是谁成功的，供 lkgp 策略下次优先用它。
              if (typeof facts?.upstreamId === 'string' && facts.upstreamId !== '') {
                self.deps.onLastGood?.(facts.upstreamId)
              }
              self.deps.onRoute?.(facts)
            },
          })
        },
      }
    }
  }
}

/**
 * 判断某个模型在当前配置下有没有任何上游能服务它。
 * 界面上用来把「选了但用不了」的模型标出来，而不是等发请求才报错。
 *
 * @param {object} snapshot - 配置快照。
 * @param {string} model - 模型 id。
 * @returns {Array} 能服务它的上游 id。
 */
export function upstreamsForModel(snapshot, model) {
  const id = baseModelId(model)
  return snapshot.upstreams
    .filter(upstream => upstream.enabled !== false && upstreamServes(upstream, id))
    .map(upstream => upstream.id)
}

