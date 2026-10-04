/**
 * 浏览器半身的自检。
 *
 * 一个客户端插件的失败模式特别难查：组件抛错只会让槽位静默空白
 * （控制台里一句 `slot entry crashed in '<slot>'`），页面看起来
 * 就像插件根本没装上。所以在安装之前先把组件真的渲染一遍，
 * 把「空白槽位」变成一条明确的测试失败。
 *
 * 做法是给 client.js 造一个最小的 `window.__ModuleLoader__` 环境：
 * 一个 load() 收集器 + 一个只提供 react 的 require + 一个把
 * React 元素树摊平成文本的渲染器（不引入 react-dom，
 * 因为那会把宿主版本和这里的版本搅在一起）。
 *
 * 运行：node client.test.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

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
 * react 与 react-test-renderer：本测试要用它们把组件真正渲染一遍。
 *
 * 它们是**测试期依赖**，不属于插件运行时（浏览器半身由宿主提供 React）。
 * 装法：在本目录执行 `npm install`（见 package.json 的 devDependencies）。
 *
 * 查找顺序：
 *   1. 本目录 / 上级目录的 node_modules（npm install 后就命中这里）；
 *   2. DSH_CLIENT_TEST_MODULES —— 显式指定，给复用宿主依赖的场景留出口。
 * 找不到时给出可操作的提示，而不是一句 "找不到"。
 */
function loadReact() {
  const bases = [here, path.join(here, '..')]
  if (process.env.DSH_CLIENT_TEST_MODULES) bases.unshift(process.env.DSH_CLIENT_TEST_MODULES)
  const tried = []
  for (const base of bases) {
    try {
      const localRequire = createRequire(path.join(base, 'noop.js'))
      return { React: localRequire('react'), TestRenderer: localRequire('react-test-renderer') }
    } catch {
      tried.push(base)
    }
  }
  throw new Error(
    '找不到 react / react-test-renderer，无法做渲染测试。\n' +
      `  已尝试：${tried.join(', ')}\n` +
      '  请在本目录执行 npm install，或设置 DSH_CLIENT_TEST_MODULES 指向含有它们的 node_modules。',
  )
}

const { React, TestRenderer } = loadReact()

/**
 * 造一个假的模块加载环境，加载 client.js，返回它的插件对象。
 *
 * @param {object} options - 覆盖项。
 * @returns {{plugin: object, registered: Array, styles: Array}} 加载结果。
 */
function loadClient(options = {}) {
  const registered = []
  const styles = []
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { appendChild: tag => { styles.push(tag) } },
  }

  let plugin
  const window = {
    __ModuleLoader__: {
      load: definition => {
        plugin = definition.factory(name => {
          if (name === 'react') return React
          throw new Error(`客户端插件不该 require "${name}"`)
        })
        plugin.__id = definition.id
      },
    },
    document: fakeDocument,
    fetch: options.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
  }

  const source = readFileSync(path.join(here, 'client.js'), 'utf8')
  // 用 Function 而不是 eval：作用域显式，且不需要 import 任何东西。
  const run = new Function('window', 'document', 'fetch', 'console', `${source}\n`)
  run(window, fakeDocument, window.fetch, console)
  assert.ok(plugin !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')

  // 假装宿主已经声明了那个槽位，然后 apply 一次。
  const slots = {
    inject: (slotName, factory) => { factory() },
    register: (registration, Component) => { registered.push({ registration, Component }); return () => {} },
  }
  plugin.apply({
    effect: callback => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    slots,
  })
  return { plugin, registered, styles }
}

/** 造一份管理页会收到的 status 文档。 */
function sampleStatus(overrides = {}) {
  return {
    provider: 'omniroute',
    displayName: 'OmniRoute',
    enabled: true,
    edited: false,
    registered: true,
    reasoningEffort: '',
    maxTokensOverride: 0,
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    rejected: [],
    strategies: [
      { id: 'priority', name: '按顺序', description: '永远用列表里第一个可用的上游。' },
      { id: 'lkgp', name: '记住上次好的', description: '优先用最近一次成功的那个。' },
    ],
    gateway: {
      strategy: 'priority',
      raceEnabled: false,
      raceWidth: 2,
      upstreams: [
        {
          id: 'builtin-free', name: '内置免费额度', baseURL: 'https://opencode.ai/zen/v1',
          kind: 'opencode-free', builtin: true, enabled: true, hasApiKey: false,
          modelCount: 0, models: [], weight: 1,
          health: { state: 'closed', successRate: undefined, sampleCount: 0, totals: { success: 0, failure: 0 }, averageLatencyMs: 0, consecutiveFailures: 0 },
        },
        {
          id: 'mine', name: '我的 Groq', baseURL: 'https://api.groq.com/openai/v1',
          kind: 'openai', builtin: false, enabled: true, hasApiKey: true,
          modelCount: 2, models: ['llama-3.3-70b', 'mixtral'], weight: 3,
          inputPricePerMTok: 0.59, outputPricePerMTok: 0.79,
          health: {
            state: 'open', successRate: 0.25, sampleCount: 8,
            totals: { success: 2, failure: 6 }, averageLatencyMs: 840, consecutiveFailures: 3,
            lastSuccessAt: Date.now() - 60000,
            lastFailure: { code: 'RATE_LIMIT', message: 'Groq 返回 HTTP 429', at: Date.now() - 1000 },
            openedAt: Date.now() - 5000,
          },
          cooldownRemainingMs: 55000,
        },
      ],
      models: [
        { id: 'llama-3.3-70b', name: 'llama-3.3-70b', servedBy: ['mine'] },
        { id: 'mixtral', name: 'mixtral', servedBy: ['mine'] },
      ],
    },
    recentRoutes: [
      {
        at: Date.now(), model: 'llama-3.3-70b', upstreamName: 'mine', strategy: 'priority',
        routeNote: '前 1 个上游失败（内置免费额度(SERVER)），已改用 我的 Groq',
        attempts: [{ upstream: '内置免费额度', ok: false, code: 'SERVER', elapsedMs: 300 }, { upstream: '我的 Groq', ok: true, elapsedMs: 200 }],
      },
      {
        at: Date.now() - 30000, model: 'mixtral', upstreamName: 'mine', strategy: 'race(priority)',
        raced: true, racers: [{ upstream: '我的 Groq', won: true, elapsedMs: 150 }, { upstream: '内置免费额度', won: false, elapsedMs: 400 }],
      },
    ],
    apiPrefix: '/api/omniroute-connect',
    ...overrides,
  }
}

console.log('client.js 自检')

await test('模块契约：load 的 id 与包的包名一致，且只 require react', () => {
  const { plugin, registered, styles } = loadClient()
  assert.equal(plugin.__id, 'dsh-omniroute-connect')
  assert.equal(plugin.name, 'dsh-omniroute-connect-client')
  assert.deepEqual(plugin.inject, ['slots'])
  // 键必须是包名，否则宿主的「这个 bundle 有没有配置界面」判断会落空
  assert.equal(registered.length, 1)
  assert.equal(registered[0].registration.name, 'plugins.bundle.config')
  assert.equal(registered[0].registration.key, 'dsh-omniroute-connect')
  assert.equal(typeof registered[0].Component, 'function')
  assert.equal(styles.length, 1, '样式表必须插入一次')
})

await test('样式只用主题令牌，且类名有本插件前缀', () => {
  const { styles } = loadClient()
  const css = styles[0].textContent
  // 本插件自己的选择器一律 dshor- 前缀，避免和别的插件撞车
  const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1])
  const foreign = classes.filter(name => !name.startsWith('dshor-'))
  assert.deepEqual(foreign, [], `出现了非 dshor- 前缀的类名：${foreign.join(', ')}`)
  // 颜色一律走令牌
  const colors = [...css.matchAll(/(?:^|[\s:(])(#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\()/g)]
  assert.deepEqual(colors, [], '样式里出现了写死的颜色，必须用 --dsw-alias-* 令牌')
  assert.match(css, /--dsw-alias-label-primary/)
})

await test('组件能渲染：加载中状态不炸', async () => {
  const { registered } = loadClient({ fetch: () => new Promise(() => {}) })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /OmniRoute 网关/)
  assert.match(text, /正在读取/)
})

await test('管理页显示上游、健康度、策略与最近请求', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => sampleStatus() }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())

  assert.match(text, /内置免费额度/)
  assert.match(text, /我的 Groq/)
  assert.match(text, /https:\/\/api\.groq\.com\/openai\/v1/, '上游地址要显示出来')
  assert.match(text, /2 个上游/)
  assert.match(text, /按顺序/, '策略选项要渲染出来')
  assert.match(text, /已改用 我的 Groq/, '最近请求的回退说明要显示出来')
  assert.match(text, /我的 Groq✓|我的 Groq✓/, '竞速结果要标出谁赢了')
})

await test('健康度：没有样本时显示「还不知道」而不是 0%', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => sampleStatus() }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())
  // 内置那条 sampleCount=0，必须显示「还不知道」——显示 0% 会让人以为它坏了
  assert.match(text, /还不知道/)
  // 有样本的显示真实百分比
  assert.match(text, /25%/)
})

await test('竞速开关默认关闭，且把「会多花钱」写在界面上', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => sampleStatus() }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /并行竞速/)
  assert.match(text, /真实计费/, '必须明确提示竞速的真实代价')
})

await test('展开上游后，模型文本框要带出现有的模型 id', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => sampleStatus() }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const find = (node, predicate) => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, predicate)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (predicate(node)) return node
    for (const child of (Array.isArray(node.children) ? node.children : [])) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const header = find(renderer.toJSON(), node =>
    node.type === 'button' && Array.isArray(node.children)
    && JSON.stringify(node.children).includes('我的 Groq'))
  assert.ok(header !== undefined, '必须能找到「我的 Groq」的卡片头')
  await TestRenderer.act(async () => { header.props.onClick() })

  // 这一条来自一次真实的翻车：卡片被挂上时塞了个 `modelsText: ''`，
  // 把文本框初值强行置空——用户看到的是「模型列表是空的」，
  // 一按保存就把服务端已有的模型全清掉了。
  // 所以文本框的初值必须来自 status 里的 models。
  const textarea = find(renderer.toJSON(), node =>
    node.type === 'textarea' && node.props?.className === 'dshor-input')
  assert.ok(textarea !== undefined, '必须能找到模型文本框')
  const value = String(textarea.props.value ?? '')
  assert.match(value, /llama-3\.3-70b/, '文本框必须带出已有的模型 id')
  assert.match(value, /mixtral/)
})

await test('展开一个上游后能看到它的失败原因与拉闸提示', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => sampleStatus() }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  // 点开第二条（我的 Groq）
  const find = (node, predicate) => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, predicate)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    if (predicate(node)) return node
    for (const child of (Array.isArray(node.children) ? node.children : [])) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const header = find(renderer.toJSON(), node =>
    node.type === 'button' && Array.isArray(node.children)
    && JSON.stringify(node.children).includes('我的 Groq'))
  assert.ok(header !== undefined, '必须能找到「我的 Groq」的卡片头')
  await TestRenderer.act(async () => { header.props.onClick() })

  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /RATE_LIMIT/, '断路器记录的失败原因要显示出来')
  assert.match(text, /已拉闸/, '拉闸状态要显示出来')
  assert.match(text, /后自动重试/, '要告诉用户还有多久恢复')
  assert.match(text, /探测可用模型/, '要有探测按钮')
  assert.match(text, /恢复健康状态/, '要有手动恢复的出口')
})

await test('组件能渲染：接口报错时显示错误而不是崩溃', async () => {
  const { registered } = loadClient({
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /boom/)
})

await test('被忽略的上游配置要在界面上说明为什么', async () => {
  const { registered } = loadClient({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => sampleStatus({
        rejected: [{ index: 1, reason: '缺少有效的 http(s) baseURL，或 id 含有非法字符' }],
      }),
    }),
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /被忽略/)
  assert.match(text, /缺少有效的 http\(s\) baseURL/)
})

await test('自检失败时显示失败原因', async () => {
  const { registered } = loadClient({
    fetch: async (url) => {
      if (String(url).endsWith('/self-check')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: { ok: false, model: 'm', message: '所有上游都失败了：我的 Groq(SERVER)', elapsedMs: 900 },
            status: sampleStatus(),
          }),
        }
      }
      return { ok: true, status: 200, json: async () => sampleStatus() }
    },
  })
  const Component = registered[0].Component
  let renderer
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Component, {}))
  })
  const find = (node, label) => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, label)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    const children = Array.isArray(node.children) ? node.children : []
    if (node.type === 'button' && children.includes(label)) return node
    for (const child of children) {
      const hit = find(child, label)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const button = find(renderer.toJSON(), '发一条自检消息')
  assert.ok(button !== undefined, '必须能找到自检按钮')
  await TestRenderer.act(async () => { await button.props.onClick() })
  const text = JSON.stringify(renderer.toJSON())
  assert.match(text, /自检失败/)
  assert.match(text, /所有上游都失败了/)
})

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 个用例失败`)
process.exitCode = failures === 0 ? 0 : 1
