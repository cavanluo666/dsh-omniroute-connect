/**
 * transport.js 的自检：不联网，用假的 SSE 流验证转换是否正确。
 *
 * 覆盖四件事，每件都是「错了会静默出错」的那类：
 *   1. 跨 chunk 断行 —— 半个 data: 行落在两个 TCP 包里；
 *   2. 文本 / 思维链交错 —— block 索引与开闭必须连贯；
 *   3. 工具调用分片 —— id 与 name 只在第一帧，arguments 断续拼；
 *   4. usage 口径 —— prompt_tokens 含缓存，必须减出去。
 *
 * 运行：node transport.test.mjs
 */

import assert from 'node:assert/strict'
import {
  buildRequestBody,
  classifyStatus,
  createTranslator,
  describeErrorBody,
  parseSse,
  projectUsage,
  readChunk,
  readRouteFacts,
  splitRoute,
} from './transport.js'

let failures = 0
/** 跑一个用例，失败不中断其余用例。 */
async function test(name, body) {
  try {
    await body()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

/** 把若干字符串片段包成一个 ReadableStream（模拟分包的响应体）。 */
function streamOf(...pieces) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

/** 把流跑完，收集所有事件。 */
async function collect(stream) {
  const out = []
  for await (const event of parseSse(stream, undefined)) out.push(event)
  return out
}

console.log('transport.js 自检')

await test('SSE：分帧、心跳、CRLF、[DONE]', async () => {
  const events = await collect(streamOf(
    ': keep-alive\n',
    'data: {"a":1}\n\ndata: {"b"',
    ':2}\r\n',
    '\n: another comment\n',
    'data: [DONE]\n',
    'data: {"never":true}\n',
  ))
  assert.deepEqual(events, [
    { payload: '{"a":1}' },
    { payload: '{"b":2}' },
    { done: true },
  ])
})

await test('SSE：末尾没有换行的残行也要处理', async () => {
  const events = await collect(streamOf('data: {"tail":1}'))
  assert.deepEqual(events, [{ payload: '{"tail":1}' }])
})

await test('readChunk：标准文本增量', () => {
  const event = readChunk('{"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}')
  assert.equal(event.text, '你好')
  assert.equal(event.reasoning, '')
  assert.equal(event.finishReason, undefined)
})

await test('readChunk：思维链字段的多种叫法', () => {
  assert.equal(readChunk('{"choices":[{"delta":{"reasoning_content":"a"}}]}').reasoning, 'a')
  assert.equal(readChunk('{"choices":[{"delta":{"reasoning":"b"}}]}').reasoning, 'b')
  assert.equal(readChunk('{"choices":[{"delta":{}}],"reasoning":"c"}').reasoning, 'c')
})

await test('readChunk：usage-only 帧（choices 为空数组）不炸', () => {
  const event = readChunk('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}')
  assert.equal(event.text, '')
  assert.equal(event.usage.prompt_tokens, 10)
})

await test('readChunk：非 JSON 的 data 载荷被忽略而不是抛错', () => {
  assert.equal(readChunk('not json at all'), undefined)
  assert.equal(readChunk('null'), undefined)
})

await test('readChunk：上游错误帧被识别', () => {
  const event = readChunk('{"error":{"message":"upstream exploded","code":"boom"}}')
  assert.equal(event.error.message, 'upstream exploded')
})

await test('翻译器：文本与思维链交错的 block 索引连贯', () => {
  const translator = createTranslator()
  const chunks = [
    ...translator.push(readChunk('{"choices":[{"delta":{"reasoning_content":"想"}}]}')),
    ...translator.push(readChunk('{"choices":[{"delta":{"content":"答"}}]}')),
    ...translator.push(readChunk('{"choices":[{"delta":{"content":"案"}}]}')),
    ...translator.finish(undefined),
  ]
  assert.deepEqual(chunks.map(c => c.type), [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'text-delta', 'block-end',
    'finish',
  ])
  assert.equal(chunks[0].index, 0)
  assert.equal(chunks[0].blockType, 'reasoning')
  assert.equal(chunks[1].index, 0)
  assert.equal(chunks[2].block.text, '想')
  assert.equal(chunks[3].index, 1)
  assert.equal(chunks[3].blockType, 'text')
  assert.equal(chunks[6].block.text, '答案')
})

await test('翻译器：工具调用分片（id/name 只在第一帧）', () => {
  const translator = createTranslator()
  const chunks = [
    ...translator.push(readChunk(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"web_search","arguments":"{\\"q\\":"}}]}}]}',
    )),
    ...translator.push(readChunk(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"dsh\\"}"}}]}}]}',
    )),
    ...translator.push(readChunk('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}')),
    ...translator.finish(undefined),
  ]
  assert.deepEqual(chunks.map(c => c.type), [
    'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks[0].blockType, 'tool-call')
  assert.equal(chunks[1].id, 'call_abc')
  assert.equal(chunks[1].name, 'web_search')
  // name 只在第一帧出现，但我们每帧都重发：harness 的 BlockAssembler 认的是
  // 「最后一个非空 name」（lib/index.js 的 `if (chunk.name) partial.toolCallName = chunk.name`），
  // 重发是合法的，而漏发才会让名字丢掉。这条断言把那个契约钉住。
  assert.equal(chunks[2].name, 'web_search', '每一帧都要带 name，装配器只记最后一个非空值')
  assert.equal(chunks[2].argumentsDelta, '"dsh"}')
  assert.equal(chunks[3].block.arguments, '{"q":"dsh"}')
  assert.deepEqual(chunks[4].reason, { kind: 'tool-calls' })
})

await test('翻译器：文本之后再来的工具调用会先关掉文本块', () => {
  const translator = createTranslator()
  const chunks = [
    ...translator.push(readChunk('{"choices":[{"delta":{"content":"让我查一下"}}]}')),
    ...translator.push(readChunk(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"grep","arguments":"{}"}}]}}]}',
    )),
    ...translator.finish(undefined),
  ]
  assert.deepEqual(chunks.map(c => c.type), [
    'block-start', 'text-delta', 'block-end',
    'block-start', 'tool-call-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks[2].block.text, '让我查一下')
  assert.equal(chunks[3].index, 1)
})

await test('翻译器：usage 在 finish 之前，且带上网关事实', () => {
  const translator = createTranslator()
  translator.push(readChunk('{"choices":[{"delta":{"content":"hi"}}]}'))
  const chunks = translator.finish({ provider: 'opencode-free', cache: 'MISS' })
  assert.deepEqual(chunks.map(c => c.type), ['block-end', 'finish'])
  assert.equal(chunks[1].replayState.response.omniroute.provider, 'opencode-free')

  const withUsage = createTranslator()
  withUsage.push(readChunk('{"choices":[{"delta":{"content":"hi"}}]}'))
  withUsage.push(readChunk('{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}'))
  const tail = withUsage.finish(undefined)
  assert.deepEqual(tail.map(c => c.type), ['block-end', 'usage', 'finish'])
})

await test('usage：prompt_tokens 含缓存，必须减出去', () => {
  const usage = projectUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_tokens_details: { cached_tokens: 800 },
  })
  assert.equal(usage.inputTokens, 200)
  assert.equal(usage.cacheReadTokens, 800)
  assert.equal(usage.outputTokens, 50)
  // 三者相加必须还原成 prompt_tokens，否则 token 表就是错的。
  assert.equal(usage.inputTokens + usage.cacheReadTokens, 1000)
})

await test('usage：缓存数超过 prompt 总数时不产生负数', () => {
  const usage = projectUsage({
    prompt_tokens: 10,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 999 },
  })
  assert.equal(usage.inputTokens, 0)
  assert.equal(usage.cacheReadTokens, 10)
})

await test('usage：缺失时全为 0 而不是 NaN', () => {
  assert.deepEqual(projectUsage(undefined), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
})

await test('buildRequestBody：角色与 block 的投影', () => {
  const body = buildRequestBody({
    model: 'auto',
    system: '你是助手',
    messages: [
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '思考' },
          { type: 'text', text: '我查一下' },
          { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{"pattern":"a"}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '结果' }] },
    ],
    tools: [{ name: 'grep', description: '搜索', parameters: { type: 'object' } }],
    temperature: 0.2,
    maxTokens: 100,
  })
  assert.equal(body.model, 'auto')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.messages, [
    { role: 'system', content: '你是助手' },
    // developer 只有 tool-addition：整条丢弃，不发空消息
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: '我查一下',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
  ])
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].function.name, 'grep')
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 100)
})

await test('buildRequestBody：developer 的文本并进 system', () => {
  const body = buildRequestBody({
    model: 'auto',
    messages: [{ role: 'developer', content: [{ type: 'text', text: '追加指令' }] }],
  })
  assert.deepEqual(body.messages, [{ role: 'system', content: '追加指令' }])
})

await test('buildRequestBody：图片走 image_url，缺 dataUrl 退化成占位文本', () => {
  const body = buildRequestBody({
    model: 'auto',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看这个' },
        { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
        { type: 'image' },
      ],
    }],
  })
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: '看这个' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: '[image omitted]' },
  ])
})

await test('buildRequestBody：没有工具时不发 tools 字段', () => {
  const body = buildRequestBody({ model: 'auto', messages: [] })
  assert.equal('tools' in body, false)
  assert.equal('tool_choice' in body, false)
})

await test('splitRoute：pin 前缀的两种写法', () => {
  assert.deepEqual(splitRoute('auto'), { model: 'auto', pinnedProvider: undefined })
  assert.deepEqual(splitRoute('auto/coding'), { model: 'auto/coding', pinnedProvider: 'auto' })
  assert.deepEqual(splitRoute('openrouter::gpt-5'), { model: 'openrouter::gpt-5', pinnedProvider: 'openrouter' })
  // 结尾的斜杠不是 pin 前缀
  assert.deepEqual(splitRoute('auto/'), { model: 'auto/', pinnedProvider: undefined })
})

await test('classifyStatus：可重试与不可重试的分界', () => {
  assert.deepEqual(classifyStatus(401), { retryable: false, code: 'AUTH' })
  assert.deepEqual(classifyStatus(402), { retryable: false, code: 'QUOTA' })
  assert.deepEqual(classifyStatus(404), { retryable: false, code: 'NO_MODEL' })
  assert.deepEqual(classifyStatus(413), { retryable: false, code: 'CONTEXT_WINDOW_EXCEEDED' })
  assert.deepEqual(classifyStatus(429), { retryable: true, code: 'RATE_LIMIT' })
  assert.deepEqual(classifyStatus(500), { retryable: true, code: 'SERVER' })
  assert.deepEqual(classifyStatus(503), { retryable: true, code: 'SERVER' })
})

await test('describeErrorBody：三种错误体都能读懂', () => {
  assert.equal(
    describeErrorBody('{"error":{"message":"no route","type":"routing_error","code":"no_route"}}'),
    'no route | type=routing_error | code=no_route',
  )
  assert.equal(describeErrorBody('{"error":"plain string"}'), 'plain string')
  assert.equal(describeErrorBody('<html>502</html>'), '<html>502</html>')
  assert.equal(describeErrorBody(''), '')
  assert.equal(describeErrorBody('x'.repeat(1000)).length, 601)
})

await test('readRouteFacts：只取确有的头，空串视为缺席', () => {
  const headers = new Headers({
    'x-omniroute-provider': 'openrouter',
    'x-omniroute-cache': 'HIT',
    'x-omniroute-decision': 'strategy=auto; provider=openrouter; latency_ms=42',
    'x-omniroute-response-cost': '0.0000000000',
    'x-omniroute-cost-saved': '',
  })
  const facts = readRouteFacts(headers)
  assert.equal(facts.provider, 'openrouter')
  assert.equal(facts.cache, 'HIT')
  assert.equal(facts.responseCost, '0.0000000000')
  assert.equal(facts.costSaved, undefined)
  assert.equal(facts.model, undefined)
})

await test('readRouteFacts：一个头都没有时返回 undefined', () => {
  assert.equal(readRouteFacts(new Headers()), undefined)
  assert.equal(readRouteFacts(undefined), undefined)
})

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 个用例失败`)
process.exitCode = failures === 0 ? 0 : 1
