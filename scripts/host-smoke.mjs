import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

if (!process.argv[2]) throw new Error('Usage: bun scripts/host-smoke.mjs /absolute/path/to/host.js')
const sandbox = await mkdtemp(join(tmpdir(), 'tet-host-'))
const root = fileURLToPath(new URL('../', import.meta.url))
const wrapper = join(sandbox, 'wrapper.mjs')
/** 合成凭据和模拟上游仅存在隔离目录，不触碰用户的 Magpie 配置或真实中转。 */
await writeFile(wrapper, [
  'globalThis.fetch = async (input, init) => {',
  ' const url = String(input);',
  ' const key = new Headers(init?.headers).get("authorization");',
  ' const slot = key === "Bearer synthetic-key-A" ? "A" : key === "Bearer synthetic-key-B" ? "B" : key === "Bearer synthetic-key-C" ? "C" : key === "Bearer synthetic-key-D" ? "D" : null;',
  ' if (!slot) throw new Error("Unexpected test credential");',
  ' await new Promise(resolve => setTimeout(resolve, slot === "A" ? 20 : 5));',
  ' if (url.endsWith("/models")) return Response.json({data:[{id:slot === "B" ? "gpt-6-luna" : "gpt-6.1-sol"}]});',
  ' if (url.endsWith("/usage") && slot === "C") return Response.json({isValid:true,mode:"quota_limited",balance:0.0001,quota:{used:12.3456,limit:100},rate_limits:[{window:"1d",limit:10}]});',
  ' if (url.endsWith("/usage") && slot === "D") return Response.json({isValid:true,planName:"Pro",balance:5.6789,subscription:{daily_usage_usd:0.012345,daily_limit_usd:10,expires_at:"2099-01-01T00:00:00Z"}});',
  ' if (url.endsWith("/usage")) return Response.json({isValid:true,mode:"unrestricted",balance:slot === "B" ? 56.78 : 12.34,usage:{today:{actual_cost:slot === "B" ? 2 : 1,requests:2,total_tokens:50},rpm:3}});',
  ' if (url.endsWith("/responses")) return Response.json({accountMarker:slot,received:JSON.parse(init.body || "{}")});',
  ' throw new Error("Unexpected test endpoint");',
  '};',
  'await import(' + JSON.stringify(pathToFileURL(resolve(process.argv[2])).href) + ');',
].join('\n'))
const child = spawn('bun', [wrapper], {
  env: { PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: sandbox, XDG_CACHE_HOME: sandbox },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const waiting = new Map()
let serial = 0
createInterface({ input: child.stdout }).on('line', line => {
  const reply = JSON.parse(line)
  const task = waiting.get(reply.id)
  if (!task) return
  if (reply.event) {
    task.events.push(reply)
    return
  }
  clearTimeout(task.timer)
  waiting.delete(reply.id)
  reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(task.events.length ? { result: reply.result, events: task.events } : reply.result)
})
child.stderr.on('data', () => {})
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => reject(new Error('Host RPC timeout: ' + method)), 15000)
    waiting.set(id, { resolve, reject, timer, events: [] })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
try {
  const init = await rpc('init', { authPath: join(sandbox, 'synthetic-auth.json'), directory: sandbox,
    plugins: [{ spec: 'tet', target: root }] })
  assert.equal(init.plugins[0].error, undefined)
  const prompt = await rpc('prompt', { provider: 'tet', method: 0 })
  assert.equal(prompt.prompt.key, 'baseURL')
  const first = await rpc('apiKey', { provider: 'tet', method: 0, key: 'synthetic-key-A', inputs: { baseURL: 'https://first.example' } })
  const second = await rpc('apiKey', { provider: 'tet', method: 0, key: 'synthetic-key-B', account: 'new', inputs: { baseURL: 'https://second.example/api/v1' } })
  assert.notEqual(first.account, second.account)
  const providers = await rpc('providers', {})
  assert.equal(providers[0].id, 'tet')
  assert.equal(providers[0].name, 'TET')
  assert.equal(providers[0].single, false)
  assert.equal(providers[0].accounts.length, 2)
  assert.deepEqual(providers[0].accounts.find(a => a.key === first.account).models, ['gpt-6.1-sol'])
  assert.deepEqual(providers[0].accounts.find(a => a.key === second.account).models, ['gpt-6-luna'])
  assert.deepEqual(providers[0].models.map(m => m.id).sort(), ['gpt-6-luna', 'gpt-6.1-sol'])
  assert(providers[0].icon.startsWith('data:image/svg+xml;base64,'))
  assert.equal(providers[0].options[0].key, 'show-traffic')
  const [usage, secondUsage] = await Promise.all([first, second].map(({ account }) => rpc('usage', { provider: 'tet', account })))
  assert.equal(usage.balance, '$12.34')
  assert.equal(secondUsage.balance, '$56.78')
  assert(secondUsage.windows[0].display.startsWith('$2.00'))
  assert.equal(usage.windows.some(w => w.balance != null), false)
  assert.equal(usage.windows[0].used, null)
  assert.equal(usage.windows[0].aside, true)
  assert(usage.windows[0].display.includes('50 tok'))
  await rpc('setProviderOptions', { options: { tet: { 'show-traffic': false } } })
  const compactUsage = await rpc('usage', { provider: 'tet' })
  assert.equal(compactUsage.windows[0].display, '$1.00')
  assert.equal(compactUsage.windows.some(w => w.name === 'Usage'), false)
  assert.equal((await rpc('load', { provider: 'tet' })).fetch, true)
  async function forwarded(account) {
    const response = await rpc('fetch', { provider: 'tet', account, npm: '@ai-sdk/openai',
      model: 'gpt-6.1-sol', url: (account === first.account ? 'https://first.example/v1' : 'https://second.example/api/v1') + '/responses', body: '{}' })
    assert.equal(response.events.find(e => e.event === 'head').status, 200)
    return JSON.parse(Buffer.concat(response.events.filter(e => e.event === 'chunk').map(e => Buffer.from(e.data, 'base64'))).toString()).accountMarker
  }
  assert.deepEqual(await Promise.all([first, second].map(({ account }) => forwarded(account))), ['A', 'B'])
  /** 验证宿主边界不丢显式历史或工具结果；不冒充上层 SDK 的请求构造测试。 */
  const history = [
    { role: 'user', content: 'Remember number 7.' },
    { role: 'assistant', content: 'OK' },
    { role: 'user', content: 'Report the number.' },
    { type: 'function_call', name: 'report_number', arguments: '{"value":7}', call_id: 'synthetic-call' },
    { type: 'function_call_output', call_id: 'synthetic-call', output: '{"accepted":true}' },
  ]
  const multiTurn = { model: 'gpt-6.1-sol', store: false, input: history }
  const multiResponse = await rpc('fetch', { provider: 'tet', account: first.account, npm: '@ai-sdk/openai',
    model: multiTurn.model, url: 'https://first.example/v1/responses', body: Buffer.from(JSON.stringify(multiTurn)).toString('base64') })
  const received = JSON.parse(Buffer.concat(multiResponse.events.filter(e => e.event === 'chunk').map(e => Buffer.from(e.data, 'base64'))).toString()).received
  assert.deepEqual(received, multiTurn)
  assert.equal(received.previous_response_id, undefined)
  await rpc('apiKey', { provider: 'tet', method: 0, account: first.account, key: 'synthetic-key-C', inputs: { baseURL: 'https://first.example/v1' } })
  assert.deepEqual(await Promise.all([first, second].map(({ account }) => forwarded(account))), ['C', 'B'])
  const quotaUsage = await rpc('usage', { provider: 'tet', account: first.account })
  assert.equal(quotaUsage.balance, '<$0.01')
  assert.equal(quotaUsage.windows[0].amount, 12.3456)
  assert.equal(quotaUsage.windows[0].limit, 100)
  assert.equal(quotaUsage.windows[0].aside, false)
  assert.equal(quotaUsage.windows[1].name, '1 day')
  assert.equal(quotaUsage.windows[1].used, null)
  assert.equal(quotaUsage.windows[1].limit, 0)
  assert(quotaUsage.windows[1].display.includes('usage unavailable'))
  assert.equal((await rpc('providers', {}))[0].accounts.length, 2)
  const subscribed = await rpc('apiKey', { provider: 'tet', method: 0, key: 'synthetic-key-D', account: 'new', inputs: { baseURL: 'https://first.example' } })
  const subscriptionUsage = await rpc('usage', { provider: 'tet', account: subscribed.account })
  assert.equal(subscriptionUsage.balance, '$5.68')
  assert.equal(subscriptionUsage.plan, 'Pro')
  assert.equal(subscriptionUsage.windows.length, 1)
  assert.equal(subscriptionUsage.windows[0].amount, 0.012345)
  assert.equal(subscriptionUsage.windows[0].limit, 10)
  assert.equal(subscriptionUsage.windows[0].aside, false)
  console.log('Official host smoke passed: root URL, account isolation, wallets with key/subscription limits, full-precision quota fields, unknown usage, concurrent forwarding, key replacement, identity, icon and live options.')
} finally {
  child.kill()
  for (const task of waiting.values()) clearTimeout(task.timer)
  await rm(sandbox, { recursive: true, force: true })
}
