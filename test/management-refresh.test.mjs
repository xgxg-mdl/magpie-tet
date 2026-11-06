import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../index.mjs'
import { createManagement } from '../src/management.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const envelope = data => Response.json({ success: true, data })
const inputs = {
  baseURL: 'https://gateway.example',
  managementURL: 'https://console.example',
  managementUsername: 'synthetic-user',
  managementPassword: 'synthetic-password',
}
async function fixture() {
  const client = createManagement()
  globalThis.fetch = async () => envelope({ token: 'old-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
  const { metadata } = await client.authorize(inputs, 1000)
  return { client, auth: { type: 'api', key: 'synthetic-key', metadata } }
}

test('near-expiry and expired sessions re-login once across concurrent reads and save each account', async () => {
  for (const expiresAt of [Date.now() + 60000, Date.now() - 60000]) {
    const { client, auth } = await fixture()
    auth.metadata.management.expiresAt = expiresAt
    let logins = 0
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/login')) {
        logins++
        expect(JSON.parse(init.body)).toEqual({
          loginName: inputs.managementUsername,
          password: inputs.managementPassword,
        })
        return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
      }
      expect(init.headers.authorization).toBe('Bearer new-token')
      return envelope({ content: [], totalElements: 0 })
    }
    const saved = []
    const results = await Promise.all([1, 2].map(() => client.read(auth, 1000, async next => saved.push(next))))
    expect(results.every(result => result.groups.length === 0)).toBe(true)
    expect(logins).toBe(1)
    expect(saved).toHaveLength(2)
    expect(saved.every(next => next.key === auth.key && next.metadata.management.token === 'new-token')).toBe(true)
  }
})

test('a server 401 recovers before the recorded expiry and retries only once', async () => {
  const { client, auth } = await fixture()
  let logins = 0
  let queries = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/login')) {
      logins++
      return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    }
    queries++
    return init.headers.authorization === 'Bearer old-token'
      ? new Response('', { status: 401 })
      : envelope({ content: [], totalElements: 0 })
  }
  const saved = []
  expect((await client.read(auth, 1000, async next => saved.push(next))).groups).toEqual([])
  expect(logins).toBe(1)
  expect(queries).toBe(3) // 首次查询、/me 续期尝试、查询重试。
  expect(saved).toHaveLength(1)
})

test('failed re-login backs off without exposing response text or retrying indefinitely', async () => {
  const { client, auth } = await fixture()
  auth.metadata.management.expiresAt = Date.now() - 1
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('private-password-detail', { status: 401 })
  }
  const first = await client.read(auth, 1000)
  expect(first.error).toBe('管理台账号或密码有误')
  expect(await client.read(auth, 1000)).toEqual(first)
  expect(calls).toBe(2) // /me 被拒绝后仅重登一次，后续读取退避。
  expect(JSON.stringify(first)).not.toContain('private-')
})

test('simultaneous upstream 401 responses share recovery and both metrics retry with the new token', async () => {
  const { client, auth } = await fixture()
  let logins = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/login')) {
      logins++
      await new Promise(resolve => setTimeout(resolve, 5))
      return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    }
    if (String(url).includes('?pageNum='))
      return envelope({ content: [{ id: 7, name: 'Shared', accounts: [{ id: 5 }] }], totalElements: 1 })
    if (init.headers.authorization === 'Bearer old-token') return new Response('', { status: 401 })
    return envelope(String(url).endsWith('/credits') ? { availableResetCount: 2 } : { fiveHour: { utilization: 0 } })
  }
  const result = await client.read(auth, 1000)
  expect(logins).toBe(1)
  expect(result.groups[0].accounts[0].usage.fiveHour.utilization).toBe(0)
  expect(result.groups[0].accounts[0].credits.availableResetCount).toBe(2)
})

test('a persistently rejected replacement token stops after one recovery', async () => {
  const { client, auth } = await fixture()
  let logins = 0
  let reads = 0
  globalThis.fetch = async url => {
    if (String(url).endsWith('/login')) {
      logins++
      return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    }
    reads++
    return new Response('', { status: 401 })
  }
  expect((await client.read(auth, 1000)).error).toBe('管理台登录已过期')
  expect(logins).toBe(1)
  expect(reads).toBe(3)
})

test('renewed sessions are saved through the host account scope without changing the API key', async () => {
  let stored
  const writes = []
  const plugin = await TetPlugin({
    client: {
      auth: {
        set: async request => {
          writes.push(request)
          stored = request.body
        },
      },
    },
  })
  globalThis.fetch = async () => envelope({ token: 'old-token', tokenExpiresAt: Date.now() / 1000 - 1 })
  const { metadata } = await plugin.auth.methods[1].authorize(inputs)
  stored = { type: 'api', key: 'synthetic-key', metadata }
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://gateway.example')) return Response.json({ isValid: true, balance: 12 })
    if (String(url).endsWith('/login'))
      return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    return envelope({ content: [], totalElements: 0 })
  }
  const shown = await plugin.auth.usage(async () => stored)
  expect(shown.balance).toBe('12.00 USD')
  expect(writes).toHaveLength(1)
  expect(writes[0].path).toEqual({ id: 'tet' })
  expect(stored.key).toBe('synthetic-key')
  expect(stored.metadata.management.token).toBe('new-token')
})

test('an old usage refresh cannot overwrite a replacement sign-in', async () => {
  let writes = 0
  const plugin = await TetPlugin({
    client: {
      auth: {
        set: async () => {
          writes++
        },
      },
    },
  })
  globalThis.fetch = async () => envelope({ token: 'old-token', tokenExpiresAt: Date.now() / 1000 - 1 })
  const { metadata } = await plugin.auth.methods[1].authorize(inputs)
  const old = { type: 'api', key: 'old-key', metadata }
  let reads = 0
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://gateway.example')) return Response.json({ isValid: true, balance: 12 })
    if (String(url).endsWith('/login'))
      return envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    return envelope({ content: [], totalElements: 0 })
  }
  await plugin.auth.usage(async () => (++reads === 1 ? old : { type: 'api', key: 'replacement-key' }))
  expect(writes).toBe(0)
})

test('unsupported or failing session persistence is reported without hiding the wallet', async () => {
  for (const input of [
    {},
    {
      client: {
        auth: {
          set: async () => {
            throw new Error('private-store-detail')
          },
        },
      },
    },
  ]) {
    const plugin = await TetPlugin(input)
    globalThis.fetch = async () => envelope({ token: 'old-token', tokenExpiresAt: Date.now() / 1000 - 1 })
    const { metadata } = await plugin.auth.methods[1].authorize(inputs)
    const auth = { type: 'api', key: 'synthetic-key', metadata }
    globalThis.fetch = async url =>
      String(url).startsWith('https://gateway.example')
        ? Response.json({ isValid: true, balance: 12 })
        : envelope({ token: 'new-token', tokenExpiresAt: Date.now() / 1000 + 3600 })
    const shown = await plugin.auth.usage(async () => auth)
    expect(shown.balance).toBe('12.00 USD')
    expect(shown.windows[0].display).toContain(input.client ? '保存失败' : '宿主不支持')
    expect(JSON.stringify(shown)).not.toContain('private-')
    expect(shown.signIn).toBeUndefined()
  }
})
