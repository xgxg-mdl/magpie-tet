import { afterEach, expect, spyOn, test } from 'bun:test'
import { TetPlugin } from '../index.mjs'
import { createManagement as createClient, managementBase } from '../src/management.mjs'
import { presentManagementUsage } from '../src/management-usage.mjs'

function createManagement() {
  const client = createClient()
  return {
    ...client,
    async windows(auth, timeout) {
      return presentManagementUsage({ windows: [] }, await client.read(auth, timeout)).windows
    },
  }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const inputs = {
  baseURL: 'https://gateway.example',
  managementURL: 'https://console.example',
  managementUsername: 'synthetic-user',
  managementPassword: 'synthetic-password',
  managementGroup: '7:5',
}
const envelope = data => Response.json({ success: true, data })
const future = () => new Date(Date.now() + 86400000).toISOString()
const group = { id: 7, name: 'Shared', accounts: [{ id: 5 }], capacity: { used: 2, max: 10 } }
const sessionToken = 'test-session'
function upstream(log = []) {
  return async (url, init) => {
    log.push({ url: String(url), init })
    if (String(url).endsWith('/api/auth/login')) {
      expect(JSON.parse(init.body)).toEqual({
        loginName: inputs.managementUsername,
        password: inputs.managementPassword,
      })
      expect(init.headers.authorization).toBeUndefined()
      return envelope({ token: sessionToken, tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 })
    }
    expect(init.headers.authorization).toBe('Bearer ' + sessionToken)
    if (String(url).includes('?pageNum=')) return envelope({ content: [group], totalElements: 1 })
    if (String(url).endsWith('/5/usage?active=false'))
      return envelope({
        fiveHour: { utilization: 0, resetsAt: future() },
        sevenDay: { utilization: 55, resetsAt: future() },
        updatedAt: new Date().toISOString(),
      })
    if (String(url).endsWith('/5/credits')) return envelope({ availableResetCount: 0 })
    throw new Error('Unexpected endpoint')
  }
}

test('management sign-in uses masked password without fixed group selection', async () => {
  const client = createManagement()
  globalThis.fetch = upstream()
  const entered = {}
  for (const key of ['baseURL', 'managementURL', 'managementUsername', 'managementPassword']) {
    const prompt = await client.ask(entered, 1000)
    expect(prompt.key).toBe(key)
    if (key === 'managementPassword') expect(prompt.type).toBe('password')
    entered[key] = inputs[key]
  }
  expect(await client.ask(entered, 1000)).toBeNull()
  const result = await client.authorize(entered, 1000)
  // 模拟宿主将全部输入与返回元数据合并后写入认证文件。
  const saved = JSON.parse(JSON.stringify({ ...entered, ...result.metadata }))
  expect(saved.baseURL).toBe('https://gateway.example/v1')
  expect(saved.management.groupId).toBeUndefined()
  expect(saved.management.accountId).toBeUndefined()
  expect(saved.management.token).toBe(sessionToken)
  expect(JSON.stringify(saved)).not.toContain('synthetic-password')
  expect(saved.managementUsername).toBeUndefined()
})

test('obsolete group choices are ignored and removed from stored metadata', async () => {
  globalThis.fetch = upstream()
  const result = await createManagement().authorize({ ...inputs, managementGroup: '7:999' }, 1000)
  expect(result.metadata.managementGroup).toBeUndefined()
  expect(result.metadata.management.accountId).toBeUndefined()
})

test('management and API credentials stay isolated and traffic toggles do not hide group quotas', async () => {
  const log = []
  const managementFetch = upstream(log)
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://gateway.example/')) {
      expect(init.headers.authorization).toBe('Bearer synthetic-api-key')
      return Response.json({ isValid: true, balance: 12, usage: { today: { actual_cost: 1, requests: 2 } } })
    }
    return managementFetch(url, init)
  }
  const plugin = await TetPlugin({}, { showTraffic: false })
  const configured = await plugin.auth.methods[1].authorize(inputs)
  const auth = { type: 'api', key: 'synthetic-api-key', metadata: configured.metadata }
  const result = await plugin.auth.usage(async () => auth)
  expect(result.balance).toBe('12.00 USD')
  expect(result.windows.find(window => window.name === 'Today').display).toBe('$1.00')
  const windows = ['5h', '7d', '可用重置'].map(name => result.windows.find(window => window.name === name))
  expect(windows[0].used).toBe(0)
  expect(windows[1].used).toBe(55)
  expect(windows[2].display).toBe('0 次')
  expect(result.plan).toContain('管理台 · Shared')
  expect(result.plan).not.toContain('上游')
  expect(result.windows.find(window => window.name === '并发')).toEqual({
    name: '并发',
    amount: 2,
    limit: 10,
    used: 20,
    aside: true,
  })
  expect(windows.every(window => window.aside)).toBe(true)
  expect(log.some(call => call.url.includes('/7/usage'))).toBe(false)
  expect(log.some(call => call.url.includes('/reset'))).toBe(false)
})

test('expired management sessions never mark a valid API key expired or hide its wallet', async () => {
  globalThis.fetch = upstream()
  const plugin = await TetPlugin()
  const result = await plugin.auth.methods[1].authorize(inputs)
  const auth = { type: 'api', key: 'synthetic-api-key', metadata: result.metadata }
  globalThis.fetch = async url =>
    String(url).startsWith('https://gateway.example/')
      ? Response.json({ isValid: true, balance: 12 })
      : new Response('private-server-detail', { status: 401 })
  const usage = await plugin.auth.usage(async () => auth)
  expect(usage.balance).toBe('12.00 USD')
  expect(usage.signIn).toBeUndefined()
  expect(usage.error).toBeUndefined()
  expect(usage.windows.every(window => window.display === '管理台登录已过期')).toBe(true)
  expect(JSON.stringify(usage)).not.toContain('private-server-detail')
})

test('slow management queries use a short independent budget and preserve a completed wallet', async () => {
  const plugin = await TetPlugin({}, { queryTimeoutMs: 60000 })
  globalThis.fetch = upstream()
  const configured = await plugin.auth.methods[1].authorize(inputs)
  const auth = { type: 'api', key: 'synthetic-api-key', metadata: configured.metadata }
  const deadlines = []
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    deadlines.push({ ms, controller })
    return controller.signal
  })
  let ready
  const managementStarted = new Promise(resolve => {
    ready = resolve
  })
  const slowSignals = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://gateway.example/')) {
      return Response.json({ isValid: true, balance: 12, usage: { today: { actual_cost: 1, requests: 2 } } })
    }
    return new Promise((resolve, reject) => {
      slowSignals.push(init.signal)
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      if (slowSignals.length === 1) ready()
    })
  }
  let work
  try {
    work = plugin.auth.usage(async () => auth)
    await managementStarted
    for (const deadline of deadlines.filter(item => item.ms !== 60000)) {
      expect(deadline.ms).toBeLessThanOrEqual(5000)
      deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'))
    }
    const result = await work
    expect(result.balance).toBe('12.00 USD')
    expect(result.windows.find(window => window.name === 'Today').display).toBe('$1.00 · req 2')
    expect(
      result.windows
        .filter(window => window.name === '管理台分组')
        .every(window => window.display === '管理台查询超时或连接失败'),
    ).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.signIn).toBeUndefined()
    expect(deadlines.some(item => item.ms === 60000)).toBe(true)
  } finally {
    for (const deadline of deadlines) deadline.controller.abort()
    if (work) await work
    timeout.mockRestore()
  }
})

test('parallel requests for one quota account share only in-flight management calls', async () => {
  const client = createManagement()
  globalThis.fetch = upstream()
  const result = await client.authorize(inputs, 1000)
  const auth = { type: 'api', key: 'key-a', metadata: result.metadata }
  const log = []
  const read = upstream(log)
  globalThis.fetch = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return read(...args)
  }
  const [a, b] = await Promise.all([client.windows(auth, 1000), client.windows({ ...auth, key: 'key-b' }, 1000)])
  expect(log).toHaveLength(3)
  expect(a[0].name).toBe(b[0].name)
  await client.windows(auth, 1000)
  expect(log).toHaveLength(6)
})

test('group list failure displays a single state without stale group readings', async () => {
  const client = createManagement()
  globalThis.fetch = upstream()
  const result = await client.authorize(inputs, 1000)
  const read = upstream()
  globalThis.fetch = (url, init) =>
    String(url).includes('?pageNum=')
      ? Promise.resolve(new Response('private-detail', { status: 503 }))
      : read(url, init)
  const windows = await client.windows({ metadata: result.metadata }, 1000)
  expect(windows).toEqual([{ name: '管理台分组', display: '管理台服务异常（HTTP 503）', aside: true }])
  expect(JSON.stringify(windows)).not.toContain('private-detail')
})

test('different quota accounts share the in-flight group list but refresh its snapshot on the next read', async () => {
  const client = createManagement()
  globalThis.fetch = upstream()
  const result = await client.authorize(inputs, 1000)
  const auth = { metadata: result.metadata }
  const other = { metadata: { ...result.metadata, management: { ...result.metadata.management, accountId: 6 } } }
  const log = []
  const read = upstream(log)
  globalThis.fetch = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return read(...args)
  }
  await Promise.all([client.windows(auth, 1000), client.windows(other, 1000)])
  expect(log.filter(call => call.url.includes('?pageNum='))).toHaveLength(1)
  globalThis.fetch = async (url, init) =>
    String(url).includes('?pageNum=')
      ? envelope({ content: [{ ...group, capacity: { used: 8, max: 10 } }], totalElements: 1 })
      : read(url, init)
  const windows = await client.windows(auth, 1000)
  expect(windows.find(window => window.name === '并发').amount).toBe(8)
})

test('changing the API address or invalidating a binding prevents management network access', async () => {
  const client = createManagement()
  globalThis.fetch = upstream()
  const result = await client.authorize(inputs, 1000)
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  const bad = { type: 'api', key: 'key-a', metadata: { ...result.metadata, baseURL: 'https://another.example/v1' } }
  expect((await client.windows(bad, 1000))[0].display).toContain('配置已变更')
  const expired = { type: 'api', key: 'key-a', metadata: result.metadata }
  expired.metadata.management.expiresAt = Date.now() - 1
  expect((await client.windows(expired, 1000))[0].display).toBe('管理台登录已过期')
  expect(calls).toBe(0)
})

test('management URLs reject credential URLs, query strings, fragments and non-HTTP protocols', () => {
  expect(managementBase(' https://console.example/prefix/// ')).toBe('https://console.example/prefix')
  for (const url of [
    'https://user@console.example',
    'https://console.example?key=x',
    'https://console.example#x',
    'file:///tmp/x',
    123,
  ]) {
    expect(() => managementBase(url)).toThrow('管理台地址')
  }
})

test('management responses and transport failures never expose upstream secrets', async () => {
  for (const fail of [
    async () => {
      throw new Error('private-network-secret')
    },
    async () => new Response('private-body-secret'),
    async () => Response.json({ success: false, message: 'private-body-secret' }),
    async () => new Response('private-body-secret', { status: 403 }),
    async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
  ]) {
    globalThis.fetch = fail
    try {
      await createManagement().authorize(inputs, 1000)
      throw new Error('expected failure')
    } catch (error) {
      expect(error.message).not.toContain('private-')
      expect(error.message).not.toBe('expected failure')
    }
  }
})

test('repeated quota pagination is bounded instead of silently binding incomplete data', async () => {
  globalThis.fetch = async url =>
    String(url).endsWith('/api/auth/login')
      ? envelope({ token: sessionToken })
      : envelope({ content: [group], totalElements: 2 })
  const client = createManagement()
  const configured = await client.authorize(inputs, 1000)
  expect((await client.read({ metadata: configured.metadata }, 1000)).error).toContain('分页重复')
})
