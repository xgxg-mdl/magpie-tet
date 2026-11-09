import assert from 'node:assert/strict'
import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../src/index.ts'
import { decodeAuth, encodeAuth } from '../../src/auth/storage.ts'
import { present, record } from '../support/assertions.ts'
import { mockFetch } from '../support/fetch.ts'
import { codePlaneAccount, codePlaneInputs, envelope, storedCodePlaneAuth } from '../fixtures/accounts.ts'
import type { HostConfig, HostInput } from '../../src/host/types.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const inputs = { ...codePlaneInputs, baseURL: '' }
const reply = (extra: Record<string, unknown> = {}) => ({
  userId: 7,
  apiKey: 'fixture-gateway-key',
  token: 'fixture-session',
  tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  codexGatewayUrl: 'https://gateway.example/v1',
  ...extra,
})

async function login(extra: Record<string, unknown> = {}, entered: Record<string, unknown> = inputs) {
  globalThis.fetch = mockFetch(async () => envelope(reply(extra)))
  const plugin = await TetPlugin()
  const flow = await plugin.auth.methods[0].authorize(entered)
  const result = await flow.callback()
  const account = decodeAuth({ ...result, type: 'oauth' })
  assert.equal(account.kind, 'codeplane')
  return { plugin, flow, result, account, auth: encodeAuth(account) }
}

test('CodePlane sign-in exposes the new fields before API Key and preserves provider identity', async () => {
  const plugin = await TetPlugin()
  expect(plugin.auth.methods.map(method => [method.type, method.label])).toEqual([
    ['oauth', 'TET CodePlane 账号登录'],
    ['api', 'API Key'],
  ])
  expect(plugin.auth.methods[0].prompts.slice(0, 3)).toEqual([
    { type: 'text', key: 'codePlaneURL', message: 'TET CodePlane 地址' },
    { type: 'text', key: 'username', message: 'TET CodePlane 账号' },
    { type: 'password', key: 'password', message: 'TET CodePlane 密码' },
  ])
  expect(plugin.auth.methods[1].prompts.map(prompt => prompt.key)).toEqual(['baseURL'])
  expect(plugin.auth.provider).toBe('tet')
  expect(plugin.provider.id).toBe('tet')
  const config: HostConfig = {}
  await plugin.config(config)
  expect(present(present(config.provider).tet).name).toBe('TET')
})

test('switching to API Key clears CodePlane metadata', async () => {
  const plugin = await TetPlugin()
  const entered = { baseURL: 'https://gateway.example', codePlane: storedCodePlaneAuth().metadata.codePlane }
  const result = await plugin.auth.methods[1].authorize(entered)
  expect(JSON.parse(JSON.stringify({ ...entered, ...result.metadata }))).toEqual({
    baseURL: 'https://gateway.example/v1',
  })
})

test('account login separates gateway access from stored CodePlane session fields', async () => {
  const { plugin, flow, result, auth } = await login()
  expect(flow.instructions).toBe('账号已验证，正在保存网关与 TET CodePlane 配置。')
  expect(result.type).toBe('success')
  expect(auth.key).toBe(reply().apiKey)
  expect(auth.metadata.baseURL).toBe('https://gateway.example/v1')
  expect(auth.metadata.codePlane.baseURL).toBe('https://console.example')
  expect(auth.access).toBe(reply().token)
  expect(auth.expires).toBeGreaterThan(Date.now())
  expect(auth.metadata).not.toHaveProperty('management')
  const requests: { url: string; token: string | null }[] = []
  globalThis.fetch = mockFetch(async (url, init) => {
    requests.push({ url: String(url), token: new Headers(init.headers).get('authorization') })
    return Response.json({ ok: true })
  })
  const loader = await plugin.auth.loader(async () => auth)
  await present(loader.fetch)('https://gateway.example/v1/responses', { method: 'POST', body: '{}' })
  expect(requests).toEqual([{ url: 'https://gateway.example/v1/responses', token: 'Bearer ' + reply().apiKey }])
})

test('account identity is scoped to the CodePlane site and user while names use the trimmed login', async () => {
  const first = await login({}, { ...inputs, username: '  synthetic-user  ' })
  const alias = await login({}, { ...inputs, username: 'alias' })
  const otherUser = await login({ userId: 8 })
  const otherSite = await login({}, { ...inputs, codePlaneURL: 'https://other.example' })
  expect(first.auth.accountId).toBe('synthetic-user')
  expect(alias.auth.accountId).toBe('alias')
  expect(first.auth.uid).toMatch(/^[a-f0-9]{64}$/)
  expect(alias.auth.uid).toBe(first.auth.uid)
  expect(otherUser.auth.uid).not.toBe(first.auth.uid)
  expect(otherSite.auth.uid).not.toBe(first.auth.uid)
  expect(first.auth.refresh).toBe(first.auth.uid)
})

test('valid stored sessions require no network work and old management formats fail before sending', async () => {
  const { plugin, auth } = await login()
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    throw new Error('must not send')
  })
  expect(await plugin.auth.refresh(auth)).toBeUndefined()
  for (const malformed of [
    { type: 'oauth', key: 'key', access: 'unrelated-token' },
    { type: 'api', key: 'key', metadata: { baseURL: 'https://gateway.example', management: {} } },
  ])
    await expect(plugin.auth.loader(async () => malformed)).rejects.toThrow()
  expect(calls).toBe(0)
})

test('explicit gateway URLs override defaults and incomplete login replies fail safely', async () => {
  expect((await login({}, { ...inputs, baseURL: 'https://override.example/proxy/v1' })).auth.metadata.baseURL).toBe(
    'https://override.example/proxy/v1',
  )
  for (const extra of [
    { token: '' },
    { apiKey: '' },
    { tokenExpiresAt: 0 },
    { tokenExpiresAt: Number.MAX_VALUE },
    { userId: null },
    { codexGatewayUrl: 'file:///tmp/invalid' },
  ])
    await expect(login(extra)).rejects.toThrow()
})

test('an explicit gateway overrides malformed server candidates during login and key discovery', async () => {
  const entered = { ...inputs, baseURL: 'https://override.example/proxy/v1' }
  for (const candidate of ['not-a-url', 'file:///private-detail', { invalid: true }]) {
    const direct = await login({ codexGatewayUrl: candidate }, entered)
    expect(direct.auth.metadata.baseURL).toBe(entered.baseURL)
    const requests: string[] = []
    globalThis.fetch = mockFetch(async url => {
      requests.push(String(url))
      return envelope(
        String(url).endsWith('/login')
          ? reply({ apiKey: undefined, codexGatewayUrl: candidate })
          : { apiKey: 'configured-key', codexGatewayUrl: candidate },
      )
    })
    const plugin = await TetPlugin()
    const stored = await (await plugin.auth.methods[0].authorize(entered)).callback()
    expect(stored.metadata.baseURL).toBe(entered.baseURL)
    expect(stored.key).toBe('configured-key')
    expect(requests).toEqual([
      'https://console.example/api/auth/login',
      'https://console.example/api/auth/profile/gateway-config',
    ])
  }
})

test('missing login keys are fetched from gateway configuration using the session token', async () => {
  const plugin = await TetPlugin()
  const visited: string[] = []
  globalThis.fetch = mockFetch(async (url, init) => {
    visited.push(String(url))
    if (String(url).endsWith('/login')) return envelope(reply({ apiKey: undefined, codexGatewayUrl: undefined }))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + reply().token)
    return envelope({ apiKey: 'configured-key', gatewayPublicBaseUrl: 'https://gateway.example' })
  })
  const result = await (await plugin.auth.methods[0].authorize(inputs)).callback()
  const account = decodeAuth({ ...result, type: 'oauth' })
  expect(account.gateway).toEqual({ baseURL: 'https://gateway.example/v1', apiKey: 'configured-key' })
  expect(visited).toEqual([
    'https://console.example/api/auth/login',
    'https://console.example/api/auth/profile/gateway-config',
  ])
})

test('host refresh returns newly encoded session data without moving the gateway', async () => {
  const { plugin, auth } = await login({ tokenExpiresAt: Math.floor(Date.now() / 1000) + 60 })
  auth.accountId = 'Custom account label'
  globalThis.fetch = mockFetch(async () =>
    envelope(reply({ token: 'renewed-session', apiKey: 'rotated-key', codexGatewayUrl: 'https://unexpected.example' })),
  )
  const stored = present(await plugin.auth.refresh(auth))
  expect(stored.accountId).toBe('Custom account label')
  const next = decodeAuth(stored)
  assert.equal(next.kind, 'codeplane')
  expect(next.session.token).toBe('renewed-session')
  expect(next.gateway).toEqual({ baseURL: auth.metadata.baseURL, apiKey: 'rotated-key' })
  expect(next.uid).toBe(auth.uid)
})

function installUsageUpstream() {
  globalThis.fetch = mockFetch(async url => {
    if (String(url).startsWith('https://gateway.example')) return Response.json({ isValid: true, balance: 12 })
    if (String(url).endsWith('/me')) return envelope({ userId: codePlaneAccount().session.userId })
    if (String(url).endsWith('/login'))
      return envelope(reply({ token: 'renewed-session', userId: codePlaneAccount().session.userId }))
    return envelope({ content: [], totalElements: 0 })
  })
}

test('usage recovery persists encoded credentials through the host account scope', async () => {
  let stored: unknown = { ...storedCodePlaneAuth({ expiresAt: Date.now() - 1000 }), accountId: 'Custom account label' }
  const writes: { path: { id: string }; body: unknown }[] = []
  const plugin = await TetPlugin({
    client: {
      auth: {
        set: async update => {
          writes.push(update)
          stored = update.body
        },
      },
    },
  })
  installUsageUpstream()
  const usage = await plugin.auth.usage(async () => stored)
  expect(usage.balance).toBe('12.00 USD')
  expect(writes).toHaveLength(1)
  expect(present(writes[0]).path).toEqual({ id: 'tet' })
  expect(record(stored).access).toBe('renewed-session')
  expect(record(stored).key).toBe(reply().apiKey)
  expect(record(stored).accountId).toBe('Custom account label')
  expect(record(record(stored).metadata)).not.toHaveProperty('management')
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
  const old = storedCodePlaneAuth({ expiresAt: Date.now() - 1000 })
  let reads = 0
  installUsageUpstream()
  await plugin.auth.usage(async () => (++reads === 1 ? old : { type: 'api', key: 'replacement-key' }))
  expect(writes).toBe(0)
})

test('unsupported or failing session persistence is reported without hiding the wallet', async () => {
  const scenarios: { input: HostInput; expected: string }[] = [
    { input: {}, expected: '宿主不支持' },
    {
      input: {
        client: {
          auth: {
            set: async () => {
              throw new Error('private-store-detail')
            },
          },
        },
      },
      expected: '保存失败',
    },
  ]
  for (const { input, expected } of scenarios) {
    const plugin = await TetPlugin(input)
    const auth = storedCodePlaneAuth({ expiresAt: Date.now() - 1000 })
    installUsageUpstream()
    const shown = await plugin.auth.usage(async () => auth)
    expect(shown.balance).toBe('12.00 USD')
    expect(present(present(shown.windows[0]).display)).toContain(expected)
    expect(JSON.stringify(shown)).not.toContain('private-')
    expect(shown.signIn).toBeUndefined()
  }
})
