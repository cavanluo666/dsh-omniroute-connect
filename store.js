/**
 * 配置存储——网关自己的配置（上游列表、策略、开关）。
 *
 * 为什么不用 harness 的 settings 服务：DSH 的 settings 表单一次写入会走
 * profile patch → 整棵 Loader 树 reconcile → 插件 fiber 热重载（约 1 秒，
 * 外加一波客户端镜像刷新）。而这个插件的配置项（上游、策略、开关）
 * 都是「改完立刻用下一次请求生效」的东西，走 profile 重载既慢又没必要。
 *
 * 所以配置存在插件自己的文件里：
 *
 *   $DSH_HOME/omniroute-connect/config.json
 *
 * 分层的规则只有一条，但必须写清楚：
 *   - **入口配置（cordis.patch.yml 的 config）是默认层**，随插件升级一起走；
 *   - **本地文件是用户层**，只有写过的字段在里面出现；
 *   - 读取时用户层覆盖默认层。
 * 这样「升级插件顺带改了默认值」和「用户在界面上改过的东西」不会互相打架。
 *
 * @module omniroute/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeUpstreams, STRATEGY_IDS, DEFAULT_STRATEGY } from './gateway-model.js'

/** 本插件在 DSH 主目录下的数据目录名。 */
const DATA_DIR_NAME = 'omniroute-connect'

/** 配置文件名。 */
const CONFIG_FILE_NAME = 'config.json'

/** 内置上游的免费通道基础地址（opencode.ai 的 zen 网关）。 */
export const BUILTIN_LANE_URL = 'https://opencode.ai/zen/v1'

/**
 * 全新的默认配置。
 *
 * 这个插件**自己就是网关**：它维护一份上游列表，按策略挑一个发请求，
 * 失败了换下一个，坏的临时拉闸。所以默认配置的核心是 `upstreams`。
 *
 * 默认只放**内置的免密钥上游**一条：装上就能用，不需要用户填任何东西。
 * 用户配了自己的上游之后，内置那条自动退居回退链末尾——这是
 * `priority` 策略下「先列表里第一个」的自然结果，不需要特殊逻辑。
 *
 * @returns {object} 默认配置。
 */
export function defaultConfig() {
  return {
    /** 选择器里显示的名字。 */
    displayName: 'OmniRoute',
    /** 是否启用该 provider（关掉后 route 会注销）。 */
    enabled: true,
    /** 上游列表。空列表时 normalizeUpstreams 会补上内置那条。 */
    upstreams: [],
    /** 路由策略（见 gateway-model.js 的 STRATEGIES）。 */
    strategy: DEFAULT_STRATEGY,
    /**
     * 并行竞速：同一个请求同时发给前 N 家，取最快开始答的。
     *
     * **默认关闭**，因为它会真实计费 N 份：只有 1 个答案被采用，
     * 另外 N-1 个已经在上游那边产生了 token。它划算的场景是
     * 「首字节延迟比钱重要」，不是日常使用。
     */
    raceEnabled: false,
    /** 竞速宽度（同时发给几家）。2 已经能明显压低首字节延迟。 */
    raceWidth: 2,
    /** 输出上限覆盖；0 表示沿用 harness/模型自己的值。 */
    maxTokensOverride: 0,
    /** 未知模型的上下文容量兜底。 */
    defaultContextWindow: 262144,
    /** 每次请求的默认输出上限。 */
    defaultMaxTokens: 32768,
    /** 思考强度（发给上游的 reasoning_effort）；空串 = 不覆盖。 */
    reasoningEffort: '',
    /** 上次成功的上游 id（lkgp 策略用，由网关自动维护）。 */
    lastGoodId: '',
  }
}

/** 解析 DSH 主目录，与其它插件保持一致。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 插件数据目录（不存在则创建）。 */
export function dataDir() {
  const dir = path.join(resolveDshHome(), DATA_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 配置文件路径。 */
export function configFilePath() {
  return path.join(dataDir(), CONFIG_FILE_NAME)
}

/**
 * 原子写一个 JSON 文件：先写 `.tmp` 再 rename。
 *
 * rename 在同一分区上是原子的，所以读者要么看到旧的完整文件，
 * 要么看到新的完整文件，不会读到写了一半的 JSON——
 * 这一点在「配置坏掉会导致插件装不起来」的场景里是必须的。
 *
 * @param {string} file - 目标路径。
 * @param {unknown} value - 要序列化的值。
 */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 读一个 JSON 对象文件；不存在或坏掉都返回 undefined。
 *
 * 「坏掉时返回 undefined 而不是抛」是刻意的：配置读失败应该退回到默认值
 * 让插件还能用，而不是让整个 profile 起不来。真正需要报错的地方
 * （写入时）会自己校验。
 *
 * @param {string} file - 文件路径。
 * @returns {object|undefined} 解析后的对象。
 */
export function readJson(file) {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把入口配置与用户文件合成一份有效配置。
 *
 * 合并策略是「浅合并 + 逐字段校验」：入口配置提供默认值，用户文件里
 * **存在且类型正确**的字段覆盖它。类型校验在这里做而不是只在写入时做，
 * 因为用户可能直接手改那个 JSON 文件，而一个 `strategy: 42` 必须被挡住，
 * 不能让它在路由时才炸。
 *
 * @param {object|undefined} entryConfig - cordis.patch.yml 的 config。
 * @param {object|undefined} userConfig - 用户文件的内容。
 * @returns {object} 有效配置。
 */
export function mergeConfig(entryConfig, userConfig) {
  const base = defaultConfig()
  const merged = { ...base }

  /** 一个字段若类型正确就覆盖。 */
  const take = (source, key, predicate) => {
    if (source === undefined || source === null) return
    const value = source[key]
    if (value === undefined || value === null) return
    if (predicate(value)) merged[key] = value
  }

  const isString = value => typeof value === 'string'
  const isNonEmptyString = value => typeof value === 'string' && value.trim() !== ''
  const isBoolean = value => typeof value === 'boolean'
  const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const isStrategy = value => typeof value === 'string' && STRATEGY_IDS.includes(value)

  for (const source of [entryConfig, userConfig]) {
    take(source, 'displayName', isNonEmptyString)
    take(source, 'enabled', isBoolean)
    take(source, 'strategy', isStrategy)
    take(source, 'raceEnabled', isBoolean)
    take(source, 'raceWidth', isCount)
    take(source, 'maxTokensOverride', isCount)
    take(source, 'defaultContextWindow', isCount)
    take(source, 'defaultMaxTokens', isCount)
    take(source, 'reasoningEffort', isString)
    take(source, 'lastGoodId', isString)
    // upstreams 允许来自入口配置（部署时预置）和用户文件（界面上改的）。
    if (source?.upstreams !== undefined) merged.upstreams = source.upstreams
  }

  const normalized = normalizeUpstreams(merged.upstreams)
  merged.upstreams = normalized.upstreams
  /** 被丢掉的条目及原因；界面要能显示「你写的那条为什么没生效」。 */
  merged.rejected = normalized.rejected
  // 竞速宽度至少 2——宽度 1 的「竞速」没有意义，只是多一层开销。
  merged.raceWidth = Math.max(2, Math.min(4, merged.raceWidth))
  return merged
}

/**
 * 插件配置的读写门面。
 *
 * 一个实例持有：入口配置（默认层）、用户文件（用户层）、以及合成后的
 * 有效配置。`patch()` 写文件并就地更新内存里的有效配置——
 * 不重建实例，因为适配器捕获的是 `resolveConfig()` 的返回值，
 * 换实例会让在飞的请求看到一半新一半旧的状态。
 */
export class ConfigStore {
  /** 当前有效的合成配置。 */
  #effective

  /**
   * @param {object|undefined} entryConfig - 入口配置。
   */
  constructor(entryConfig) {
    /** 入口配置（来自 cordis.patch.yml），作为默认层。 */
    this.entryConfig = entryConfig
    /** 用户层，与文件内容保持同步（就地更新，不换引用）。 */
    this.user = readJson(configFilePath()) ?? {}
    this.#effective = mergeConfig(this.entryConfig, this.user)
  }

  /** 当前有效配置（适配器每次操作读它）。 */
  effective() {
    return this.#effective
  }

  /** 用户是否改过任何东西（决定界面显示「已改」还是「默认」）。 */
  get edited() {
    return Object.keys(this.user).length > 0
  }

  /**
   * 打一个补丁：写文件 + 就地更新有效配置。
   *
   * @param {object} patch - 字段 → 值；`null` 表示清空该字段（回落到默认层）。
   * @returns {object} 新的有效配置。
   */
  patch(patch) {
    const next = { ...this.user }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = value
    }
    writeJson(configFilePath(), next)
    for (const key of Object.keys(this.user)) delete this.user[key]
    Object.assign(this.user, next)
    this.#effective = mergeConfig(this.entryConfig, this.user)
    return this.#effective
  }

  /**
   * 记录「上次成功的上游」，供 lkgp 策略下次优先用它。
   *
   * 这个值刻意**不写进用户配置文件**：它不是用户设置，而是运行状态，
   * 混进去会让「用户在界面上改过什么」变得说不清（edited 判断会误报）。
   * 它保存在内存里，重启后从默认策略重新学习——那正是我们希望的行为。
   *
   * @param {string} id - 上游 id。
   */
  noteLastGood(id) {
    this.#effective = { ...this.#effective, lastGoodId: id }
  }
}
