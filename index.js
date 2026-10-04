/**
 * dsh-omniroute-connect —— Host 半身。
 *
 * 把 OmniRoute（自托管 AI 网关，OpenAI 兼容，默认 `http://localhost:20128/v1`）
 * 接成 DSH 的一个 provider 路由 `omniroute`。
 *
 * 三件事，按重要性排序：
 *
 *   1. **注册 `omniroute` 路由**（`ctx.llm.registerAdapter`）。
 *      适配器直接继承 harness 的 `LlmAdapter` 抽象类，自己讲 OpenAI 的
 *      Chat Completions 协议。选这条路而不是复用 pi-ai 的网关支持，
 *      是为了拿到 OmniRoute 独有的响应头（`X-OmniRoute-Provider` 等）——
 *      「这一句到底是谁答的、省了多少钱」是网关最值得暴露的东西。
 *
 *   2. **声明为可配置 provider**（`registerConfigurableProviders`）。
 *      这样「设置 → 模型」里会出现 OmniRoute 一行，模型选择器也能列到它。
 *
 *   3. **提供本地 HTTP 接口**（`/api/omniroute-connect/*`）。
 *      浏览器卡片靠它读状态、改配置、刷新模型目录。
 *
 * ## 为什么基类要从运行时拿
 *
 * 这个包被 link 进 profile 的 node_modules，而 profile 里**没有**
 * `@deepseek-ai/*`（它们解析自 dsh 自己的安装目录）。所以
 * `import { LlmAdapter } from '@deepseek-ai/dsh-llm'` 会直接失败。
 * 解法是在 apply 时从服务上取：`ctx.llm` 的构造器原型链上就是
 * `LlmAdapter` 与 `LlmError`。见 `resolveRuntime`。
 *
 * ## 依赖策略
 *
 * `llm` 是硬依赖（没有它这个插件没有意义）。`webServer` / `attachments`
 * 走 `ctx.get()` 或延迟 `ctx.inject()`：缺失时插件降级成一个能用的
 * provider（只是卡片打不开、图片发不出去），而不是整行不激活。
 *
 * @module dsh-omniroute-connect
 */

import { randomBytes } from 'node:crypto'
import { createAdapterClass } from './adapter.js'
import { HealthRegistry } from './gateway-breaker.js'
import { describeGateway, runGateway } from './gateway.js'
import { collectModels, STRATEGIES, STRATEGY_IDS } from './gateway-model.js'
import { probeUpstream } from './gateway-upstream.js'
import { ConfigStore } from './store.js'

/** 插件名（cordis 的行 id 与调试用）。 */
export const name = 'omniroute'

/** provider 的路由名，也就是 `GenerateOptions.provider` 里写的值。 */
export const PROVIDER_ID = 'omniroute'

/**
 * 硬依赖。
 *
 * `llm` 必须在这里声明，不能靠 `ctx.get('llm')`：cordis 只有在 inject 里
 * 列出的服务才会真正挂到上下文对象上（`ctx.llm`），否则读属性会直接抛
 * `cannot get property "llm" without inject`。
 *
 * 其余能力（`webServer` / `attachments`）刻意**不**列进来：
 * 它们缺失时插件应该降级（卡片打不开、图片发不出去）而不是整行不激活，
 * 所以走 `ctx.get()` / 延迟 `ctx.inject()`。
 */
export const inject = ['llm']

/** 本地接口前缀。 */
const API_PREFIX = '/api/omniroute-connect'

/** 请求体上限，防止一个坏请求把 Host 拖死。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 解析 harness 的 `LlmAdapter` 基类。
 *
 * 为什么不能直接 `import`：这个包被 link 进 profile 的 `node_modules`，
 * 而那里没有 `@deepseek-ai/*`——它们解析自 dsh 自己的安装目录。
 * 所以基类必须从**运行时**拿。
 *
 * 拿法有两条，按可靠性排序：
 *
 * 1. **从已注册的适配器实例的原型链上取**（{@link findAdapterBase}）。
 *    这是最准确的来源：拿到的就是 harness 当前这一代真实的类，
 *    连版本漂移都不用管。
 *
 * 2. **退化成一个自足的替身**（{@link createFallbackBase}）。
 *    第 1 条有个真实存在的坏情况：**如果本插件的行比任何别的适配器先加载**，
 *    那一刻 `adapters` 还是空的。早先这里直接抛错，结果是插件在
 *    「刚好排在前面」的 profile 里整行不激活——一个与插件本身无关的
 *    加载顺序问题。既然适配器的契约（`LlmAdapter` 的抽象面）在
 *    dsh-llm 里是稳定且完全文档化的，替身就是安全的兜底。
 *
 * 两条路都不通才抛错，而那时候错的是 harness 版本，不是加载顺序。
 *
 * @param {object} ctx - cordis 上下文。
 * @returns {{BaseClass: Function, EMPTY_RESPONSE_CODE: string}} 运行时基类与常量。
 * @throws {Error} 两条路都不通时（harness 版本不兼容）。
 */
function resolveRuntime(ctx) {
  const runtime = ctx.llm
  const BaseClass = runtime?.constructor?.adapterBaseClass ?? findAdapterBase(runtime) ?? createFallbackBase()
  if (typeof BaseClass !== 'function') {
    throw new Error(
      'dsh-omniroute-connect: 无法解析出 LlmAdapter 基类；这个 harness 版本的内部结构可能变了。',
    )
  }
  return { BaseClass, EMPTY_RESPONSE_CODE: 'EMPTY_RESPONSE' }
}

/**
 * 造一个满足 `LlmAdapter` 契约的替身基类。
 *
 * 契约来自 dsh-llm 的抽象类：只有 `stream` 是抽象方法，其余都有默认实现。
 * 默认实现不是「随便写写」——它们就是 harness 文档里写明的语义：
 *   - `providerInfo(provider)` 返回 `{id: provider, name: ...}`（id 必须等于 route）；
 *   - `providerRetryPolicy` 返回 `undefined` 表示用默认策略（normal，5 次重试）；
 *   - `imageRequestPricing` 返回 `undefined` 表示不声明图片计价；
 *   - `listModels` 返回空目录（GUI 里表现为「该 provider 暂无可选模型」）；
 *   - `resolveModel` 返回 provider/model 身份；
 *   - `prepareCall` 把模型元数据与 dispatch 绑到同一代。
 *
 * 我们自己的类会覆盖其中大部分，所以替身只需要「存在且语义正确」。
 * 唯一的风险是 harness 未来给基类加了**必须**由子类实现的新抽象方法；
 * 那种情况下第 1 条路（真实的类）就会生效，因为那时一定有别的适配器。
 *
 * @returns {Function} 替身基类。
 */
function createFallbackBase() {
  return class OmniRouteFallbackAdapterBase {
    providerInfo(provider) {
      return { id: provider, name: provider }
    }
    providerRetryPolicy() {
      return undefined
    }
    imageRequestPricing() {
      return undefined
    }
    async listModels() {
      return []
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model }
    }
    async prepareCall(provider, model) {
      return {
        model: await this.resolveModel(provider, model),
        stream: options => this.stream(options),
      }
    }
    /** 抽象方法：子类必须实现。 */
    stream() {
      throw new Error('OmniRouteFallbackAdapterBase.stream 必须由子类实现')
    }
  }
}

/**
 * 在 llm 服务的适配器注册表里找一个已注册的适配器，用它的原型链取出基类。
 *
 * 为什么要翻服务的字段：`LlmAdapter` 不在服务对象自己的原型链上
 * （`LlmRuntime extends TypertRemoteService`），它只出现在**实例**的原型链上。
 * dsh-llm 把注册表放在公开的 `adapters` Map 里（值是 `{adapter, retryPolicy}`），
 * 另外两个候选字段名是给版本漂移留的退路。
 *
 * @param {object} runtime - LlmRuntime 实例。
 * @returns {Function|undefined} 适配器基类。
 */
function findAdapterBase(runtime) {
  for (const candidate of [runtime?.adapters, runtime?._adapters, runtime?.registry]) {
    if (!(candidate instanceof Map) && !(candidate instanceof Set)) continue
    for (const entry of candidate.values()) {
      const adapter = entry?.adapter ?? entry
      const proto = adapter?.constructor
      if (typeof proto !== 'function') continue
      // 沿原型链找那个名字叫 LlmAdapter 的类。
      for (let current = proto; current !== null && current !== undefined; current = Object.getPrototypeOf(current)) {
        if (current.name === 'LlmAdapter') return current
      }
    }
  }
  return undefined
}

/**
 * 处理界面回传的上游列表里的密钥占位符。
 *
 * 界面上的密钥输入框有一个无法回避的歧义：**留空**既可能是
 * 「不改动」（用户只是改了地址），也可能是「清空」（密钥失效了）。
 * 一个输入框表达不了两件事，所以约定一个显式占位符：
 *
 *   - `'__keep__'` → 沿用服务端已存的那个密钥；
 *   - 其它字符串   → 就是新密钥；
 *   - 缺失/空串    → 清空。
 *
 * 之所以不接受界面回传真实密钥以外的任何「已设置」标记：密钥本身
 * **从不**回传给浏览器（status 文档里只有 `hasApiKey` 布尔），
 * 所以浏览器根本拿不到原值，只能靠这个占位符表达「别动它」。
 *
 * @param {Array} incoming - 界面回传的上游列表。
 * @param {Array} existing - 服务端当前的上游列表。
 * @returns {Array} 处理后的列表。
 */
function keepExistingSecrets(incoming, existing) {
  const byId = new Map(existing.map(entry => [entry.id, entry]))
  return incoming.map(entry => {
    if (entry === null || typeof entry !== 'object') return entry
    if (entry.apiKey !== '__keep__') return entry
    const previous = byId.get(entry.id)
    if (previous === undefined) return { ...entry, apiKey: '' }
    return { ...entry, apiKey: previous.apiKey }
  })
}

/**
 * 自检：真的通过网关发一条消息，把结果整理成界面能显示的形状。
 *
 * 走的是**完整**的网关路径（路由 → 上游 → 回退 → 翻译），
 * 所以它的结论就是「现在能不能聊」的结论。这一点与只探测
 * `/models` 的连通性检查有本质区别：一个上游可能列得出模型，
 * 但发消息就 401。
 *
 * 永远不抛：自检失败本身就是要显示给用户的信息。
 *
 * @param {object} snapshot - 网关配置快照。
 * @param {HealthRegistry} health - 健康记录（自检结果也计入，这是真实流量）。
 * @param {string} model - 用哪个模型自检。
 * @param {(facts: object) => void} noteRoute - 记录路由结果。
 * @returns {Promise<object>} 自检结果。
 */
async function runSelfCheck(snapshot, health, model, noteRoute) {
  const started = Date.now()
  const chunks = []
  try {
    for await (const chunk of runGateway({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      options: { provider: PROVIDER_ID, model },
      snapshot,
      health,
      onRoute: noteRoute,
    })) {
      chunks.push(chunk)
    }
  } catch (error) {
    return { ok: false, model, message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }
  }

  const elapsedMs = Date.now() - started
  const finish = chunks.find(chunk => chunk.type === 'finish')
  const text = chunks
    .filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
    .map(chunk => chunk.block.text)
    .join('')
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage

  if (finish?.reason?.kind === 'error' || finish?.reason?.kind === 'aborted') {
    return {
      ok: false,
      model,
      elapsedMs,
      message: finish.reason.failure?.message ?? '请求失败',
      code: finish.reason.failure?.code,
    }
  }

  return {
    ok: true,
    model,
    elapsedMs,
    answer: text.slice(0, 200),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object|undefined} config - cordis.patch.yml 里这一行的 config。
 */
export function apply(ctx, config) {
  const { BaseClass } = resolveRuntime(ctx)
  const AdapterClass = createAdapterClass(BaseClass)
  const store = new ConfigStore(config)

  /**
   * 健康记录：**跨请求**存活，由插件（而不是适配器）持有。
   *
   * 挂在这里而不是适配器实例上，是因为一次配置热改会重建适配器实例；
   * 把健康数据放在适配器上等于「每次改配置就把好不容易积累的
   * 成功率与延迟数据清零」，断路器就永远学不到东西。
   */
  const health = new HealthRegistry()

  /**
   * 最近若干次请求的路由结果。
   *
   * 这是纯诊断数据，保留最近 20 次：卡片上能回答「网关最近都在用谁、
   * 有没有在回退」，而累积全量历史会引入一个不该由插件承担的存储问题。
   */
  const recentRoutes = []
  const noteRoute = facts => {
    recentRoutes.unshift({ at: Date.now(), ...facts })
    if (recentRoutes.length > 20) recentRoutes.length = 20
  }

  const adapter = new AdapterClass({
    resolveConfig: () => {
      const effective = store.effective()
      return {
        ...effective,
        // 空串在语义上是「不覆盖」，归一成 undefined，免得下游到处判空串。
        reasoningEffort: effective.reasoningEffort === '' ? undefined : effective.reasoningEffort,
      }
    },
    getAttachments: () => ctx.get('attachments'),
    health,
    onRoute: noteRoute,
    onLastGood: id => { store.noteLastGood(id) },
  })

  /**
   * 注册 / 注销路由。
   *
   * 用 `AdapterRegistrationHandle.replace()` 而不是反复 register/dispose：
   * `replace` 是一次同步的原子切换，请求不会看到「旧路由已摘、新路由未挂」
   * 的空窗。`enabled: false` 时传空数组 —— 这是合法的（配置界面把开关
   * 关掉时，registration 会留着但持有零个路由）。
   */
  let registration
  const syncRegistration = () => {
    const effective = store.effective()
    const routes = effective.enabled ? [PROVIDER_ID] : []
    if (registration === undefined) {
      registration = ctx.llm.registerAdapter(routes, adapter)
      ctx.effect(() => () => {
        registration?.()
        registration = undefined
      })
      return
    }
    try {
      registration.replace(routes)
    } catch (error) {
      ctx.logger?.error?.('dsh-omniroute-connect: 切换 provider 路由失败', error)
    }
  }
  syncRegistration()
  /**
   * 声明为「可配置 provider」。
   *
   * 这让模型设置页能看到 OmniRoute 一行。`settingsNs` 指向的是一份
   * harness 的 settings 表单；这个插件的配置在自己的文件里（见 store.js），
   * 所以这里只把名字填对、把 `declared: true` 标出来
   * ——「这是配置声明的外部网关，不是 harness 自带的供应商」。
   */
  try {
    const directory = ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER_ID,
      displayName: store.effective().displayName,
      settingsNs: 'omniroute',
      settingsPath: [],
      declared: true,
    }])
    ctx.effect(() => () => { directory() })
  } catch (error) {
    // 目录登记失败不该让 provider 本身不可用：适配器已经注册好了。
    ctx.logger?.warn?.('dsh-omniroute-connect: 登记可配置 provider 失败（provider 本身仍可用）', error)
  }

  /**
   * 模型目录发现。
   *
   * harness 用它给「获取可用模型」这类界面动作兜底。这里直接返回
   * 当前配置下所有上游声称服务的模型并集，不发网络请求——
   * 用户填了哪些上游、每个上游声明了哪些模型，插件本来就知道，
   * 再去问一遍上游只是慢和不确定。
   */
  try {
    const dispose = ctx.llm.registerModelDiscovery('omniroute', async () => {
      const snapshot = store.effective()
      return collectModels(snapshot.upstreams).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
      }))
    })
    ctx.effect(() => () => { dispose() })
  } catch (error) {
    ctx.logger?.warn?.('dsh-omniroute-connect: 注册模型发现失败（不影响正常请求）', error)
  }

  // 管理页的本地接口（自带回环 + 控制键两道鉴权）。
  registerManagementRoutes(ctx, {
    store,
    health,
    syncRegistration,
    getRegistration: () => registration,
    recentRoutes,
    // 自检会真发一次请求，它记录的路由结果要和正常请求记在同一张表里。
    // `noteRoute` 是 apply 的局部函数，必须显式传进来——
    // registerManagementRoutes 是另一个函数，看不见它
    // （漏传的后果是一次 500：`noteRoute is not defined`）。
    noteRoute,
    logger: ctx.logger,
  })
}

/**
 * 生成一个进程内的随机控制键。
 *
 * 每次进程启动换一个，浏览器卡片从 status 文档里拿到它、写操作时回传。
 * 这样「能读到我们的页面」和「能改我们的配置」被分开了：
 * 一个本机其它程序就算能发 HTTP，也不知道这一轮的键。
 *
 * @returns {string} 32 字节的十六进制键。
 */
function mintControlKey() {
  return randomBytes(32).toString('hex')
}

/**
 * 本机回环守卫。
 *
 * 只接受 Host 是回环地址的请求，并且在浏览器带了 Origin 时也要求它是回环。
 * 这挡住的是「浏览器里访问的其他网站偷偷发请求到 localhost」这一类
 * DNS rebinding / CSRF 场景——那种请求的 Origin 会是对外域名。
 *
 * @param {object} req - HTTP 请求。
 * @returns {boolean} 是否可信。
 */
function isLoopbackRequest(req) {
  const host = String(req.headers?.host ?? '')
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

/**
 * 网关管理页用的本地接口。
 *
 * 这些路由挂在 webServer 上。之所以不是 harness 的 Remote 命名空间：
 * Remote 需要一份生成出来的 schema 契约，而这个插件的界面数据是
 * 「上游列表 + 健康度 + 一堆开关」，用一个朴素 JSON 接口更直接、
 * 也更抗版本漂移。
 *
 * ## 两道鉴权，都是必需的
 *
 * 这些接口能**改写上游地址和密钥**，所以不能像普通静态资源那样敞开
 * （早先就是这样：任何本机进程都能无凭据 POST 改配置，指向一个
 * 会收集密钥的服务器）。两道：
 *
 *   1. {@link isLoopbackRequest}：只收本机回环来的请求；
 *   2. 进程内随机键：写操作必须带上 status 文档里发出去的那个键。
 *
 * 第 1 道挡浏览器里的第三方页面，第 2 道挡本机其它进程。
 * 两者都不够单独用，所以都要。
 */
export function registerManagementRoutes(ctx, deps) {
  const { store, health, syncRegistration, getRegistration, recentRoutes, noteRoute, logger } = deps
  /** 本进程的控制键。写操作要它。 */
  const controlKey = mintControlKey()

  ctx.inject(['webServer'], webCtx => {
    /** 统一的 JSON 应答。 */
    const json = (res, status, value) => {
      const text = JSON.stringify(value)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    /**
     * 读一个请求的 JSON 体（带上限）。
     *
     * 一律按 UTF-8 解码（见下面 `toString('utf8')`）。上游名和模型名
     * 是用户填的中文，这里**不能**按平台默认编码解。
     *
     * 一个实测踩过的坑，记下来免得再查一遍：用
     * `Invoke-WebRequest -Body '<中文字符串>'` 从 PowerShell 发请求时，
     * 它按本地代码页编码请求体，服务端拿到的字节已经不是 UTF-8，
     * 解出来就是一串 `?` 并被**原样存进配置文件**——看起来像插件把中文
     * 写坏了，其实是客户端编码不对。用 node 的 `fetch` 或浏览器发
     * 同样的请求完全没有这个问题（已验证）。
     */
    const readBody = async req => {
      const chunks = []
      let total = 0
      for await (const chunk of req) {
        total += chunk.length
        if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
        chunks.push(chunk)      }
      if (total === 0) return {}
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    }

    /**
     * 统一的守门：回环 + 控制键。
     *
     * 读接口（status）只要求回环——它不回传任何密钥，只回答「设了没有」。
     * 写接口（其余全部）额外要求控制键。
     *
     * @param {object} req - HTTP 请求。
     * @param {boolean} requireKey - 是否要求控制键。
     * @returns {string|undefined} 拒绝原因，通过时为 undefined。
     */
    const rejectRequest = (req, requireKey) => {
      if (!isLoopbackRequest(req)) return '只接受来自本机回环地址的请求'
      if (!requireKey) return undefined
      const supplied = req.headers?.['x-omniroute-key']
      if (typeof supplied !== 'string' || supplied !== controlKey) return '缺少或错误的控制键'
      return undefined
    }

    /**
     * 挂一条路由，自带守门。
     * @param {string} method - HTTP 方法。
     * @param {string} path - 路径。
     * @param {boolean} requireKey - 是否要求控制键。
     * @param {Function} handler - 业务处理。
     */
    const route = (method, path, requireKey, handler) => {
      webCtx.effect(() => webCtx.webServer.register({
        method,
        path,
        handler: async (req, res) => {
          const rejection = rejectRequest(req, requireKey)
          if (rejection !== undefined) {
            logger?.warn?.(`dsh-omniroute-connect: 拒绝了一个 ${method} ${path} 请求：${rejection}`)
            json(res, 403, { error: rejection })
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    /** 当前状态文档：管理页一屏要显示的全部东西。 */
    const statusDocument = () => {
      const effective = store.effective()
      return {
        provider: PROVIDER_ID,
        displayName: effective.displayName,
        enabled: effective.enabled,
        edited: store.edited,
        registered: getRegistration() !== undefined,
        reasoningEffort: effective.reasoningEffort,
        maxTokensOverride: effective.maxTokensOverride,
        defaultContextWindow: effective.defaultContextWindow,
        defaultMaxTokens: effective.defaultMaxTokens,
        /** 被丢弃的上游条目及原因——「我配的那条为什么没生效」的答案。 */
        rejected: effective.rejected,
        /** 全部路由策略，供界面渲染选项。 */
        strategies: STRATEGIES,
        /** 网关视图：上游 + 健康度 + 模型并集。 */
        gateway: describeGateway(effective, health),
        /** 最近若干次请求的路由结果。 */
        recentRoutes,
        /**
         * 写操作要回传的控制键。
         *
         * 它随 status 文档发出去，所以只有**真的读到过这个页面**的
         * 客户端才拿得到——这正是它作为凭据的意义。
         * 它每次进程启动都换，不落盘。
         */
        controlKey,
        apiPrefix: API_PREFIX,
      }
    }

    route('GET', `${API_PREFIX}/status`, false, (_req, res) => { json(res, 200, statusDocument()) })

    route('POST', `${API_PREFIX}/config`, true, async (req, res) => {
      const body = await readBody(req)
      const patch = {}
      // 逐字段白名单：只认这几个键，其它一律忽略。
      // 用一个显式的白名单而不是「照抄 body」，是为了让
      // 一个手滑的请求不可能往配置文件里塞进任意字段。
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (typeof body.displayName === 'string' && body.displayName.trim() !== '') patch.displayName = body.displayName.trim()
      if (typeof body.strategy === 'string' && STRATEGY_IDS.includes(body.strategy)) patch.strategy = body.strategy
      if (typeof body.raceEnabled === 'boolean') patch.raceEnabled = body.raceEnabled
      if (typeof body.raceWidth === 'number') patch.raceWidth = Math.max(2, Math.min(4, Math.floor(body.raceWidth)))
      if (typeof body.maxTokensOverride === 'number') patch.maxTokensOverride = Math.max(0, Math.floor(body.maxTokensOverride))
      if (typeof body.defaultContextWindow === 'number') patch.defaultContextWindow = Math.max(1, Math.floor(body.defaultContextWindow))
      if (typeof body.defaultMaxTokens === 'number') patch.defaultMaxTokens = Math.max(1, Math.floor(body.defaultMaxTokens))
      if (typeof body.reasoningEffort === 'string') patch.reasoningEffort = body.reasoningEffort
      // 上游列表整体替换：界面上是「增删改一条」的形式，
      // 逐字段合并会让「删掉一条」无法表达。
      if (Array.isArray(body.upstreams)) patch.upstreams = keepExistingSecrets(body.upstreams, store.effective().upstreams)
      store.patch(patch)
      syncRegistration()
      json(res, 200, statusDocument())
    })

    /**
     * 探测一个上游：它还活着吗？它有哪些模型？
     *
     * 用 `GET {baseURL}/models`。有的上游不实现它（404），那**不代表
     * 上游不可用**，所以在界面上单独分类成「无列表接口」而不是失败。
     */
    route('POST', `${API_PREFIX}/probe`, true, async (req, res) => {
      const body = await readBody(req)
      const effective = store.effective()
      const id = typeof body.id === 'string' ? body.id : ''
      const upstream = effective.upstreams.find(entry => entry.id === id)
      if (upstream === undefined) {
        json(res, 404, { error: `找不到上游 "${id}"` })
        return
      }
      const probe = await probeUpstream(upstream)
      json(res, 200, { probe, upstreamId: id, status: statusDocument() })
    })

    /**
     * 真发一条消息，验证整条链路（路由 + 上游 + 流）。
     *
     * 与「探测」的分工是明确的：探测回答「上游活着吗、有哪些模型」，
     * 自检回答「这条路走不走得通」——包括鉴权、模型 id、以及
     * 网关自己的路由与回退是否按预期工作。
     */
    route('POST', `${API_PREFIX}/self-check`, true, async (req, res) => {
      const body = await readBody(req)
      const effective = store.effective()
      const models = collectModels(effective.upstreams)

      // 挑一个自检用的模型，按可靠性排序：
      //   1. 调用方指定的；
      //   2. 模型并集里的第一个；
      //   3. **某条上游声明的第一个模型**——这一步是关键：
      //      模型并集是所有上游声明的并集视图，当只有一条上游
      //      且它声明为空（= 接受任何模型）时并集就是空的，
      //      但那时完全可以用那条上游自己声明的第一个模型去试。
      //      早先缺这一步，结果是「有一条可用的上游，自检却说
      //      没有任何可用模型」——一个自相矛盾的界面。
      let model = typeof body.model === 'string' && body.model !== '' ? body.model : ''
      if (model === '') model = models[0]?.id ?? ''
      if (model === '') {
        for (const upstream of effective.upstreams) {
          if (upstream.enabled === false) continue
          const first = upstream.models?.[0]?.id
          if (typeof first === 'string' && first !== '') { model = first; break }
        }
      }
      if (model === '') {
        json(res, 200, {
          result: {
            ok: false,
            message: '没有任何可用模型：先给上游声明至少一个模型，或在某条上游上点「探测可用模型」自动填充。',
          },
          status: statusDocument(),
        })
        return
      }
      const result = await runSelfCheck(effective, health, model, noteRoute)
      json(res, 200, { result, status: statusDocument() })
    })

    /**
     * 重置健康状态。
     *
     * 自动恢复只覆盖「上游自己好了」；如果用户刚刚改好了密钥或换了地址，
     * 他不该等冷却时间走完。
     */
    route('POST', `${API_PREFIX}/reset-health`, true, async (req, res) => {
      const body = await readBody(req)
      if (typeof body.id === 'string' && body.id !== '') health.for(body.id).reset()
      else health.resetAll()
      json(res, 200, statusDocument())
    })
  })

  logger?.info?.(
    `dsh-omniroute-connect: 网关管理接口已就绪（本机回环 + 控制键），`
    + `${String(store.effective().upstreams.length)} 个上游，策略 ${store.effective().strategy}`,
  )
}
