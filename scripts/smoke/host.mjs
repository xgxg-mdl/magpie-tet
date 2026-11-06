import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

if (!process.argv[2]) throw new Error('Usage: bun scripts/smoke/host.mjs /absolute/path/to/host.js')
const sandbox = await mkdtemp(join(tmpdir(), 'tet-host-'))
const root = fileURLToPath(new URL('../../', import.meta.url))
const wrapper = join(sandbox, 'wrapper.mjs')
/** 宿主配置与认证文件仅写入隔离目录，合成上游在子进程中安装。 */
await writeFile(
  wrapper,
  [
    'const { installHostUpstream } = await import(' +
      JSON.stringify(new URL('./host-upstream.mjs', import.meta.url).href) +
      ');',
    'installHostUpstream();',
    'await import(' + JSON.stringify(pathToFileURL(resolve(process.argv[2])).href) + ');',
  ].join('\n'),
)
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
  reply.error
    ? task.reject(new Error(reply.error.message))
    : task.resolve(task.events.length ? { result: reply.result, events: task.events } : reply.result)
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
  const init = await rpc('init', {
    authPath: join(sandbox, 'synthetic-auth.json'),
    directory: sandbox,
    plugins: [{ spec: 'tet', target: root }],
  })
  assert.equal(init.plugins[0].error, undefined)
  const prompt = await rpc('prompt', { provider: 'tet', method: 1 })
  assert.equal(prompt.prompt.key, 'baseURL')
  const first = await rpc('apiKey', {
    provider: 'tet',
    method: 1,
    key: 'synthetic-key-A',
    inputs: { baseURL: 'https://first.example' },
  })
  const second = await rpc('apiKey', {
    provider: 'tet',
    method: 1,
    key: 'synthetic-key-B',
    account: 'new',
    inputs: { baseURL: 'https://second.example/api/v1' },
  })
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
  const [usage, secondUsage] = await Promise.all(
    [first, second].map(({ account }) => rpc('usage', { provider: 'tet', account })),
  )
  assert.equal(usage.balance, '12.34 USD')
  assert.equal(secondUsage.balance, '56.78 USD')
  assert(secondUsage.windows[0].display.startsWith('$2.00'))
  assert.equal(
    usage.windows.some(w => w.balance != null),
    false,
  )
  assert.equal(usage.windows[0].used, null)
  assert.equal(usage.windows[0].aside, true)
  assert(usage.windows[0].display.includes('50 tok'))
  await rpc('setProviderOptions', { options: { tet: { 'show-traffic': false } } })
  const compactUsage = await rpc('usage', { provider: 'tet' })
  assert.equal(compactUsage.windows[0].display, '$1.00')
  assert.equal(
    compactUsage.windows.some(w => w.name === 'Usage'),
    false,
  )
  assert.equal((await rpc('load', { provider: 'tet' })).fetch, true)
  async function forwarded(account) {
    const response = await rpc('fetch', {
      provider: 'tet',
      account,
      npm: '@ai-sdk/openai',
      model: 'gpt-6.1-sol',
      url: (account === first.account ? 'https://first.example/v1' : 'https://second.example/api/v1') + '/responses',
      body: '{}',
    })
    assert.equal(response.events.find(e => e.event === 'head').status, 200)
    return JSON.parse(
      Buffer.concat(
        response.events.filter(e => e.event === 'chunk').map(e => Buffer.from(e.data, 'base64')),
      ).toString(),
    ).accountMarker
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
  const multiResponse = await rpc('fetch', {
    provider: 'tet',
    account: first.account,
    npm: '@ai-sdk/openai',
    model: multiTurn.model,
    url: 'https://first.example/v1/responses',
    body: Buffer.from(JSON.stringify(multiTurn)).toString('base64'),
  })
  const received = JSON.parse(
    Buffer.concat(
      multiResponse.events.filter(e => e.event === 'chunk').map(e => Buffer.from(e.data, 'base64')),
    ).toString(),
  ).received
  assert.deepEqual(received, multiTurn)
  assert.equal(received.previous_response_id, undefined)
  await rpc('apiKey', {
    provider: 'tet',
    method: 1,
    account: first.account,
    key: 'synthetic-key-C',
    inputs: { baseURL: 'https://first.example/v1' },
  })
  assert.deepEqual(await Promise.all([first, second].map(({ account }) => forwarded(account))), ['C', 'B'])
  const quotaUsage = await rpc('usage', { provider: 'tet', account: first.account })
  assert.equal(quotaUsage.balance, '<0.01 USD')
  assert.equal(quotaUsage.windows[0].amount, 12.3456)
  assert.equal(quotaUsage.windows[0].limit, 100)
  assert.equal(quotaUsage.windows[0].aside, false)
  assert.equal(quotaUsage.windows[1].name, '1 day')
  assert.equal(quotaUsage.windows[1].used, null)
  assert.equal(quotaUsage.windows[1].limit, 0)
  assert(quotaUsage.windows[1].display.includes('usage unavailable'))
  assert.equal((await rpc('providers', {}))[0].accounts.length, 2)
  const subscribed = await rpc('apiKey', {
    provider: 'tet',
    method: 1,
    key: 'synthetic-key-D',
    account: 'new',
    inputs: { baseURL: 'https://first.example' },
  })
  const subscriptionUsage = await rpc('usage', { provider: 'tet', account: subscribed.account })
  assert.equal(subscriptionUsage.balance, '5.68 USD')
  assert.equal(subscriptionUsage.plan, 'Pro')
  assert.equal(subscriptionUsage.windows.length, 1)
  assert.equal(subscriptionUsage.windows[0].amount, 0.012345)
  assert.equal(subscriptionUsage.windows[0].limit, 10)
  assert.equal(subscriptionUsage.windows[0].aside, false)
  for (const key of ['synthetic-key-E', 'synthetic-key-F']) {
    const account = await rpc('apiKey', {
      provider: 'tet',
      method: 1,
      key,
      account: 'new',
      inputs: { baseURL: 'https://first.example' },
    })
    const zeroUsage = await rpc('usage', { provider: 'tet', account: account.account })
    assert(zeroUsage.windows.length > 0)
    for (const window of zeroUsage.windows) {
      assert.equal(window.amount, 0)
      assert.equal(window.used, 0)
      assert.equal(window.aside, false)
      assert(window.limit > 0)
    }
  }
  const codePlaneInputs = {
    baseURL: 'https://first.example',
    managementURL: 'https://console.example',
    managementUsername: 'test-user',
    managementPassword: 'test-password',
  }
  const codePlanePrompt = await rpc('prompt', { provider: 'tet', method: 0, inputs: codePlaneInputs })
  assert.equal(codePlanePrompt.prompt, null)
  const passwordPrompt = await rpc('prompt', {
    provider: 'tet',
    method: 0,
    inputs: {
      baseURL: codePlaneInputs.baseURL,
      managementURL: codePlaneInputs.managementURL,
      managementUsername: codePlaneInputs.managementUsername,
    },
  })
  assert.equal(passwordPrompt.prompt.type, 'password')
  const codePlaneFlow = await rpc('authorize', {
    provider: 'tet',
    method: 0,
    account: first.account,
    inputs: codePlaneInputs,
  })
  await rpc('callback', { session: codePlaneFlow.session })
  const codePlaneUsage = await rpc('usage', { provider: 'tet', account: first.account })
  assert.equal(codePlaneUsage.balance, '12.34 USD')
  const groupWindows = ['5h', '7d', '可用重置'].map(name =>
    codePlaneUsage.windows.find(w => w.name === 'Shared · ' + name),
  )
  assert.deepEqual(
    groupWindows.slice(0, 2).map(w => w.used),
    [0, 55],
  )
  assert(groupWindows.every(w => w.aside))
  assert.equal(groupWindows[0].resetsAt, '')
  assert.equal(groupWindows[0].span, 0)
  assert.equal(groupWindows[2].display, '0 次')
  assert.equal(codePlaneUsage.plan, 'TET')
  assert(!codePlaneUsage.plan.includes('上游'))
  const concurrency = codePlaneUsage.windows.find(w => w.name === 'Shared · 并发')
  assert.equal(concurrency.display, '2 / 10')
  assert.equal(concurrency.used, null)
  assert.equal(concurrency.aside, true)
  const savedAuth = await readFile(join(sandbox, 'synthetic-auth.json'), 'utf8')
  const codePlaneAuth = JSON.parse(savedAuth)[first.account]
  assert.equal(codePlaneAuth.key, 'synthetic-key-A')
  assert.equal(codePlaneAuth.metadata.management.token, 'test-session-2')
  assert.equal(codePlaneAuth.metadata.management.password, 'test-password')
  assert(!savedAuth.includes('managementPassword'))
  assert(!savedAuth.includes('groupId'))
  const accountFlow = await rpc('authorize', {
    provider: 'tet',
    method: 0,
    account: 'new',
    inputs: { ...codePlaneInputs, managementUsername: 'account-user', baseURL: '' },
  })
  const signed = await rpc('callback', { session: accountFlow.session })
  assert(signed.account)
  const accountUsage = await rpc('usage', { provider: 'tet', account: signed.account })
  assert.equal(accountUsage.balance, '56.78 USD')
  const accountSaved = JSON.parse(await readFile(join(sandbox, 'synthetic-auth.json'), 'utf8'))[signed.account]
  assert.equal(accountSaved.type, 'oauth')
  assert.equal(accountSaved.access, 'account-renewed')
  assert.equal(accountSaved.key, 'synthetic-key-B')
  assert.equal(accountSaved.metadata.baseURL, 'https://second.example/api/v1')
  const accountLoader = await rpc('load', { provider: 'tet', account: signed.account })
  assert.equal(accountLoader.fetch, true)
  const switched = await rpc('apiKey', {
    provider: 'tet',
    method: 1,
    account: signed.account,
    key: 'synthetic-key-B',
    inputs: { baseURL: 'https://second.example/api/v1' },
  })
  const plain = JSON.parse(await readFile(join(sandbox, 'synthetic-auth.json'), 'utf8'))[switched.account]
  assert.equal(plain.type, 'api')
  assert.deepEqual(plain.metadata, { baseURL: 'https://second.example/api/v1' })
  assert.equal(plain.access, undefined)
  assert.equal(plain.refresh, undefined)
  assert.equal(plain.expires, undefined)
  const plainUsage = await rpc('usage', { provider: 'tet', account: switched.account })
  assert.equal(plainUsage.balance, '56.78 USD')
  assert(!plainUsage.windows.some(w => w.name.includes('Shared')))
  console.log(
    'Official host smoke passed: account isolation, forwarding, limits, TET CodePlane presentation and persisted automatic re-login.',
  )
} finally {
  child.kill()
  for (const task of waiting.values()) clearTimeout(task.timer)
  await rm(sandbox, { recursive: true, force: true })
}
