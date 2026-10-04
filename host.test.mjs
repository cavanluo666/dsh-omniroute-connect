/**
 * Host 半身的装载自检。
 *
 * 为什么必须有这一套：这个插件在真实 profile 里失败过一次，而失败信息
 * （`cannot get property "llm" without inject` / 基类解析不出来）只在
 * 装载路径上出现——普通的单元测试全绿，插件却整行不激活。
 * 这里用一个最小的 cordis 上下文把 `apply()` 真的跑一遍。
 *
 * 覆盖四件事：
 *   1. `inject` 导出了 `llm`（cordis 只把 inject 里列的服务挂到 ctx 上）；
 *   2. 没有别的适配器时也能拿到可用的基类（加载顺序不该决定插件死活）；
 *   3. `apply()` 之后 provider 路由、可配置目录、模型发现三样都注册上了；
 *   4. 适配器的契约面完整，且真的能通过网关发出一条流；
 *   5. 管理接口的鉴权（回环 + 控制键）——这是安全属性，单独一组。
 *
 * 运行：node host.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as plugin from './index.js'

// cordis 由宿主 dsh 提供，位置随安装方式而定，这里按候选顺序解析，
// 不把任何一台开发机的绝对路径写死进来。
const require = createRequire(import.meta.url)

function cordisCandidates() {
  const out = []
  // 1) 本插件自己装过 cordis（或宿主把它提升到了可解析位置）
  for (const specifier of ['@deepseek-ai/cordis', '@deepseek-ai/cordis/lib/index.js']) {
    try {
      out.push(require.resolve(specifier))
    } catch {
      // 换下一个
    }
  }
  // 2) 显式指定，给特殊部署留出口
  if (process.env.DSH_CORDIS_PATH) out.push(process.env.DSH_CORDIS_PATH)
  // 3) 从 dsh 包内部解析（dsh 自带一份 cordis）
  const rel = ['lib', 'index.js']
  try {
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
    out.push(path.join(path.dirname(dshPkg), 'node_modules', '@deepseek-ai', 'cordis', ...rel))
  } catch {
    // dsh 不在本插件的解析路径上，继续
  }
  // 4) 常见全局安装位置
  for (const base of [process.env.APPDATA, process.env.DSH_HOME].filter(Boolean)) {
    out.push(path.join(base, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', ...rel))
  }
  return out
}

function loadCordis() {
  for (const candidate of cordisCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(
    '找不到 @deepseek-ai/cordis。请在装有 dsh 的环境里运行本测试，' +
      '或设置 DSH_CORDIS_PATH 指向 cordis 的 lib/index.js。',
  )
}

const { Context } = await import(pathToFileURL(loadCordis()).href)

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

/** 一个最小的 llm 服务替身，只实现 apply() 真正会碰到的三个方法。 */
function fakeLlm(seedAdapters = new Map()) {
  const calls = { adapters: [], directory: [], discovery: [] }
  return {
    calls,
    adapters: seedAdapters,
    registerAdapter(routes, adapter) {
      calls.adapters.push({ routes, adapter })
      const handle = () => {}
      handle.replace = next => { calls.adapters.at(-1).routes = next }
      return handle
    },
    registerConfigurableProviders(entries) {
      calls.directory.push(entries)
      const h = () => {}
      h.replace = () => {}
      return h
    },
    registerModelDiscovery(ns, fn) {
      calls.discovery.push({ ns, fn })
      return () => {}
    },
  }
}

/**
 * 造一个带 llm 服务的上下文。
 *
 * 用 DSH_HOME 指向一个临时目录，避免测试写到真实的插件配置里。
 * @param {object} llm - llm 服务替身。
 * @param {string} home - 临时 DSH 主目录。
 * @returns {object} cordis 上下文。
 */
function makeContext(llm, home) {
  process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.provide?.('llm', llm)
  ctx.logger = { info() {}, warn() {}, error() {} }
  return ctx
}

/** 起一个假上游，回一条固定的流。 */
async function fakeUpstream(text = '好') {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${String(server.address().port)}/v1`,
    close: () => new Promise(resolve => { server.close(resolve) }),
  }
}

/** 每个用例一个独立的临时主目录，避免用例之间互相污染配置。 */
const testHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omniroute-test-'))
let homeCounter = 0
const tempHome = () => path.join(testHomeRoot, String((homeCounter += 1)))

/** 往一个临时主目录里写插件配置。 */
function seedConfig(home, config) {
  fs.mkdirSync(`${home}/omniroute-connect`, { recursive: true })
  fs.writeFileSync(`${home}/omniroute-connect/config.json`, JSON.stringify(config))
}

console.log('index.js 装载自检')

await test('导出了 inject = ["llm"]（否则 cordis 不会挂上 ctx.llm）', () => {
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(plugin.name, 'omniroute')
  assert.equal(typeof plugin.apply, 'function')
})

await test('没有任何已注册适配器时，apply 仍然成功（不依赖加载顺序）', () => {
  const llm = fakeLlm(new Map())
  plugin.apply(makeContext(llm, tempHome()), undefined)
  assert.equal(llm.calls.adapters.length, 1)
})

await test('apply 注册了 provider 路由、可配置目录与模型发现', () => {
  const llm = fakeLlm()
  plugin.apply(makeContext(llm, tempHome()), undefined)

  assert.deepEqual(llm.calls.adapters[0].routes, ['omniroute'])
  assert.equal(llm.calls.directory[0][0].provider, 'omniroute')
  assert.equal(llm.calls.directory[0][0].declared, true, '自己就是网关，要标成 declared')
  assert.equal(llm.calls.discovery[0].ns, 'omniroute')
})

await test('适配器满足 harness 的契约面', async () => {
  const llm = fakeLlm()
  plugin.apply(makeContext(llm, tempHome()), undefined)
  const adapter = llm.calls.adapters[0].adapter

  for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter[method], 'function', `缺少方法 ${method}`)
  }
  // providerInfo 的 id 必须等于注册的 route，否则 harness 会拒收
  assert.equal(adapter.providerInfo('omniroute').id, 'omniroute')
  // 返回 undefined 表示用 harness 的默认重试策略——回退是我们自己的事
  assert.equal(adapter.providerRetryPolicy(), undefined)

  const resolved = await adapter.resolveModel('omniroute', 'whatever')
  assert.equal(resolved.provider, 'omniroute')
  assert.ok(resolved.context.contextWindow > 0, '必须给出上下文容量，否则压缩会算错')
})

await test('全新安装：上游列表被补上内置那条，而不是空着', async () => {
  const llm = fakeLlm()
  plugin.apply(makeContext(llm, tempHome()), undefined)
  const discovered = await llm.calls.discovery[0].fn()
  assert.ok(Array.isArray(discovered), '模型发现必须返回数组')
  // 内置上游声明了验证过可用的模型，所以并集应当非空
  assert.ok(discovered.length > 0, '全新安装就该有可用模型')
})

await test('enabled: false 时注册零个路由（而不是整行不激活）', () => {
  const llm = fakeLlm()
  plugin.apply(makeContext(llm, tempHome()), { enabled: false })
  assert.deepEqual(llm.calls.adapters[0].routes, [])
  // 但目录与发现仍然登记，这样界面上还能把它重新打开
  assert.equal(llm.calls.directory[0][0].provider, 'omniroute')
})

await test('端到端：通过插件实例的适配器真的发出一条流', async () => {
  const upstream = await fakeUpstream('从上游来的答案')
  const home = tempHome()
  try {
    const llm = fakeLlm()
    const ctx = makeContext(llm, home)
    // 先写上游配置，再 apply —— 模拟「用户已经配好了一家」。
    seedConfig(home, {
      upstreams: [{
        id: 'only',
        name: '唯一上游',
        baseURL: upstream.origin,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm' }],
      }],
    })
    plugin.apply(ctx, undefined)
    const adapter = llm.calls.adapters[0].adapter

    const models = await adapter.listModels('omniroute')
    assert.deepEqual(models.map(model => model.id), ['m'])

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'omniroute',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    })) chunks.push(chunk)

    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, '从上游来的答案')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    // 网关自己的路由事实必须落进 replayState
    assert.equal(chunks.at(-1).replayState.response.omniroute.upstreamName, '唯一上游')
  } finally {
    await upstream.close()
  }
})

// ─────────────────────────── 管理接口的鉴权 ───────────────────────────

/**
 * 这些接口能**改写上游地址和密钥**，所以「谁能调用它们」是一条安全属性，
 * 值得单独钉住：早先它们是敞开的——任何本机进程都能无凭据 POST 改配置，
 * 把一个上游指向会收集密钥的服务器。
 */
console.log('\n管理接口鉴权自检')

/**
 * 注册管理接口并返回路由表。
 *
 * **必须 await**：`ctx.inject(...)` 走的是 `ctx.plugin(...)`，也就是
 * 创建一个 fiber，而 fiber 是**异步**启动的。同步返回后立刻读路由表
 * 会得到空表——这是测试自身的一个坑，不是插件的问题。
 *
 * @param {object} llm - llm 服务替身。
 * @param {string} home - 临时主目录。
 * @returns {Promise<Map<string, Function>>} `"METHOD /path"` → handler。
 */
async function collectRoutes(llm, home) {
  const routes = new Map()
  const ctx = makeContext(llm, home)
  // 把 webServer 提供出来，让 ctx.inject(['webServer'], …) 的回调能启动。
  ctx.provide?.('webServer', {
    register: route => {
      routes.set(`${route.method} ${route.path}`, route.handler)
      return () => {}
    },
  })
  plugin.apply(ctx, undefined)
  // 给注入的 fiber 一点时间启动。
  await new Promise(resolve => { setTimeout(resolve, 50) })
  return routes
}

/** 造一个最小的请求/响应替身。 */
function fakeExchange({ host = '127.0.0.1:3080', origin, key, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    headers: {
      host,
      ...(origin === undefined ? {} : { origin }),
      ...(key === undefined ? {} : { 'x-omniroute-key': key }),
    },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const captured = { status: 0, payload: undefined }
  const res = {
    writeHead(status) { captured.status = status },
    end(text) { captured.payload = JSON.parse(text) },
  }
  return { req, res, captured }
}

/** 读一次 status，拿回本进程的控制键。 */
async function readControlKey(routes) {
  const exchange = fakeExchange({})
  await routes.get('GET /api/omniroute-connect/status')(exchange.req, exchange.res)
  return exchange.captured.payload?.controlKey
}

await test('写接口拒绝无控制键的请求', async () => {
  const routes = await collectRoutes(fakeLlm(), tempHome())
  const handler = routes.get('POST /api/omniroute-connect/config')
  assert.ok(handler !== undefined, 'config 路由必须注册')

  const { req, res, captured } = fakeExchange({ body: { displayName: 'HACKED' } })
  await handler(req, res)

  assert.equal(captured.status, 403, '没有控制键的写请求必须被拒绝')
  assert.match(String(captured.payload?.error), /控制键/)
})

await test('写接口接受带正确控制键的请求', async () => {
  const home = tempHome()
  const routes = await collectRoutes(fakeLlm(), home)

  const key = await readControlKey(routes)
  assert.equal(typeof key, 'string', 'status 必须发出控制键')
  assert.ok(key.length >= 32, '键要有足够长度')

  const write = fakeExchange({ key, body: { displayName: '我的网关' } })
  await routes.get('POST /api/omniroute-connect/config')(write.req, write.res)

  assert.equal(write.captured.status, 200)
  assert.equal(write.captured.payload?.displayName, '我的网关')
})

await test('写接口拒绝错误的控制键', async () => {
  const routes = await collectRoutes(fakeLlm(), tempHome())
  const { req, res, captured } = fakeExchange({ key: 'wrong-key', body: { enabled: false } })
  await routes.get('POST /api/omniroute-connect/config')(req, res)
  assert.equal(captured.status, 403)
})

await test('非回环的 Host 一律拒绝（挡 DNS rebinding）', async () => {
  const routes = await collectRoutes(fakeLlm(), tempHome())
  const key = await readControlKey(routes)

  // 即使带着正确的键，外部域名的 Host 也不该被接受
  const write = fakeExchange({ host: 'evil.example.com', key, body: {} })
  await routes.get('POST /api/omniroute-connect/config')(write.req, write.res)
  assert.equal(write.captured.status, 403, '非回环 Host 必须被拒绝')

  const read = fakeExchange({ host: 'evil.example.com' })
  await routes.get('GET /api/omniroute-connect/status')(read.req, read.res)
  assert.equal(read.captured.status, 403, '读接口也不接受非回环 Host')
})

await test('外部 Origin 的请求被拒绝（挡第三方页面）', async () => {
  const routes = await collectRoutes(fakeLlm(), tempHome())
  const key = await readControlKey(routes)

  const evil = fakeExchange({ origin: 'https://evil.example.com', key, body: {} })
  await routes.get('POST /api/omniroute-connect/config')(evil.req, evil.res)
  assert.equal(evil.captured.status, 403, '来自外部 Origin 的请求必须被拒绝')

  // 同源（回环 Origin）必须放行
  const ok = fakeExchange({ origin: 'http://127.0.0.1:8080', key, body: { enabled: true } })
  await routes.get('POST /api/omniroute-connect/config')(ok.req, ok.res)
  assert.equal(ok.captured.status, 200)
})

await test('status 绝不回传密钥本身', async () => {
  const home = tempHome()
  seedConfig(home, {
    upstreams: [{
      id: 'mine', name: '我的', baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-super-secret-value', models: [{ id: 'm' }],
    }],
  })
  const routes = await collectRoutes(fakeLlm(), home)
  const { req, res, captured } = fakeExchange({})
  await routes.get('GET /api/omniroute-connect/status')(req, res)

  const serialized = JSON.stringify(captured.payload)
  assert.equal(serialized.includes('sk-super-secret-value'), false, '密钥绝不能出现在 status 响应里')
  assert.equal(captured.payload?.gateway?.upstreams?.[0]?.hasApiKey, true, '只回答「设了没有」')
})

await test('每条写路由都能真的被调用，不抛「未定义」类错误', async () => {
  // 这一条来自一次真实的 500：把管理接口抽成独立函数时，自检那条路由
  // 还在用 apply() 里的局部函数 `noteRoute`，而新函数看不见它。
  // 只有在**真的调用**那条路由时才会炸，光注册是看不出来的——
  // 所以这里逐条调用，把作用域/拼写这类错误变成一条明确的失败。
  const routes = await collectRoutes(fakeLlm(), tempHome())
  const key = await readControlKey(routes)

  /** 每条写路由的最小可用入参。 */
  const payloads = {
    '/api/omniroute-connect/config': {},
    '/api/omniroute-connect/probe': { id: 'builtin-free' },
    '/api/omniroute-connect/self-check': { model: 'does-not-exist' },
    '/api/omniroute-connect/reset-health': {},
  }
  for (const [path, body] of Object.entries(payloads)) {
    const handler = routes.get(`POST ${path}`)
    assert.ok(handler !== undefined, `${path} 必须注册`)
    const { req, res } = fakeExchange({ key, body })
    let threw
    try {
      await handler(req, res)
    } catch (error) {
      threw = error
    }
    // 网络请求失败（没有真上游）是被捕获成结果的正常情形；
    // 这里只关心「因为代码写错而当场抛错」。
    assert.equal(threw, undefined, `${path} 不该抛错，实际抛了：${threw?.message}`)
  }
})

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 个用例失败`)
process.exitCode = failures === 0 ? 0 : 1
