/**
 * 跑完这个插件的四套自检。
 *
 * 顺序是刻意的，从最纯的到最像真的：
 *   - transport：协议翻译（无 IO）
 *   - gateway：路由 / 回退 / 断路器 / 竞速（真 HTTP 假上游）
 *   - host：真的跑一遍 apply() 与适配器（最小 cordis 上下文）
 *   - client：真的渲染一遍管理页（把「空白槽位」变成明确失败）
 *
 * 先跑纯的能让后面几套的失败更容易定位：如果协议层就错了，
 * 上层那些失败只是它的回声。
 *
 * 运行：node run-tests.mjs
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = ['transport.test.mjs', 'gateway.test.mjs', 'host.test.mjs', 'client.test.mjs']

/** 跑一个测试文件，继承 stdio 以便实时看到输出。 */
function run(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file], { cwd: here, stdio: 'inherit' })
    child.on('close', code => { resolve(code ?? 1) })
  })
}

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const code = await run(suite)
  if (code !== 0) failed += 1
}

console.log(failed === 0 ? '\n所有自检通过' : `\n${String(failed)} 套自检失败`)
process.exitCode = failed === 0 ? 0 : 1
