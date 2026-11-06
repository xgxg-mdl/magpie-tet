import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../index.mjs'
import { credentials } from '../../src/transport.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const inputs = {
  managementURL: 'https://console.example',
  managementUsername: 'synthetic-user',
  managementPassword: 'synthetic-password',
  baseURL: '',
}
const envelope = data => Response.json({ success: true, data })
const session = (extra = {}) => ({
  userId: 7,
  companyId: 3,
  userName: 'Example',
  apiKey: 'synthetic-gateway-key',
  token: 'codeplane-token',
  tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  codexGatewayUrl: 'https://gateway.example/v1',
  ...extra,
})
async function login(extra = {}, entered = inputs) {
  globalThis.fetch = async () => envelope(session(extra))
  const plugin = await TetPlugin()
  const flow = await plugin.auth.methods[0].authorize(entered)
  return { plugin, flow, result: await flow.callback() }
}
function stored(result) {
  const { type, ...fields } = result
  return { ...fields, type: 'oauth' }
}

test('TET CodePlane account sign-in is shown before API Key while the provider remains TET', async () => {
  const plugin = await TetPlugin()
  expect(plugin.auth.methods.map(method => [method.type, method.label])).toEqual([
    ['oauth', 'TET CodePlane 账号登录'],
    ['api', 'API Key'],
  ])
  expect(plugin.auth.methods[0].prompts.slice(0, 3)).toEqual([
    { type: 'text', key: 'managementURL', message: 'TET CodePlane 地址' },
    { type: 'text', key: 'managementUsername', message: 'TET CodePlane 账号' },
    { type: 'password', key: 'managementPassword', message: 'TET CodePlane 密码' },
  ])
  expect(plugin.auth.methods[1].prompts.map(prompt => prompt.key)).toEqual(['baseURL'])
  expect(plugin.auth.provider).toBe('tet')
  expect(plugin.provider.id).toBe('tet')
  const config = {}
  await plugin.config(config)
  expect(config.provider.tet.name).toBe('TET')
})

test('plain Key metadata clears legacy management fields after switching from TET CodePlane', async () => {
  const plugin = await TetPlugin()
  const entered = {
    baseURL: 'https://gateway.example',
    management: { token: 'old-session', password: 'synthetic-password' },
    managementURL: 'https://console.example',
    managementUsername: 'synthetic-user',
    managementPassword: 'synthetic-password',
    managementGroup: '7:5',
  }
  const result = await plugin.auth.methods[1].authorize(entered)
  expect(JSON.parse(JSON.stringify({ ...entered, ...result.metadata }))).toEqual({
    baseURL: 'https://gateway.example/v1',
  })
})

test('account login derives a gateway key and separate URLs with no copied Key input', async () => {
  const { plugin, flow, result } = await login()
  expect(flow.instructions).toBe('账号已验证，正在保存网关与 TET CodePlane 配置。')
  expect(result.type).toBe('success')
  const auth = stored(result)
  expect(auth.key).toBe('synthetic-gateway-key')
  expect(auth.metadata.baseURL).toBe('https://gateway.example/v1')
  expect(auth.metadata.management.url).toBe('https://console.example')
  expect(auth.access).toBe('codeplane-token')
  expect(auth.expires).toBeGreaterThan(Date.now())
  expect(credentials(auth)).toBe(auth.key)
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), token: new Headers(init.headers).get('authorization') })
    return Response.json({ ok: true })
  }
  const loader = await plugin.auth.loader(async () => auth)
  await loader.fetch('https://gateway.example/v1/responses', { method: 'POST', body: '{}' })
  expect(requests).toEqual([{ url: 'https://gateway.example/v1/responses', token: 'Bearer synthetic-gateway-key' }])
})

test('an explicit gateway URL overrides server defaults and invalid login responses fail safely', async () => {
  const { result } = await login({}, { ...inputs, baseURL: 'https://override.example/proxy/v1' })
  expect(result.metadata.baseURL).toBe('https://override.example/proxy/v1')
  for (const extra of [
    { token: '' },
    { apiKey: '' },
    { tokenExpiresAt: 0 },
    { codexGatewayUrl: 'file:///tmp/invalid' },
  ]) {
    // gateway-config 查询同样返回此无效数据，避免补全配置掩盖异常。
    await expect(login(extra)).rejects.toThrow()
  }
})

test('a confirmed me renewal takes priority over password login and updates the host expiry', async () => {
  const { plugin, result } = await login({ tokenExpiresAt: Math.floor(Date.now() / 1000) + 60 })
  const auth = stored(result)
  const paths = []
  globalThis.fetch = async url => {
    paths.push(String(url))
    return envelope(session({ token: 'renewed-token' }))
  }
  const next = await plugin.auth.refresh(auth)
  expect(paths).toEqual(['https://console.example/api/auth/me'])
  expect(next.access).toBe('renewed-token')
  expect(next.expires).toBeGreaterThan(auth.expires)
  expect(next.key).toBe(auth.key)
})

test('an unchanged me snapshot falls back to re-login and can adopt a rotated account Key', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 60
  const { plugin, result } = await login({ tokenExpiresAt: expiry })
  const paths = []
  globalThis.fetch = async url => {
    paths.push(String(url))
    return envelope(
      String(url).endsWith('/me')
        ? session({ tokenExpiresAt: expiry })
        : session({
            token: 'replacement-token',
            apiKey: 'rotated-gateway-key',
            codexGatewayUrl: 'https://unexpected.example/v1',
          }),
    )
  }
  const next = await plugin.auth.refresh(stored(result))
  expect(paths).toEqual(['https://console.example/api/auth/me', 'https://console.example/api/auth/login'])
  expect(next.key).toBe('rotated-gateway-key')
  expect(next.metadata.baseURL).toBe('https://gateway.example/v1')
})

test('ordinary OAuth credentials cannot be accidentally used as a gateway Key', () => {
  expect(() => credentials({ type: 'oauth', key: 'not-a-tet-account', access: 'codeplane-token' })).toThrow()
})

test('missing login Key is loaded from gateway configuration with the TET CodePlane token', async () => {
  const plugin = await TetPlugin()
  const visited = []
  globalThis.fetch = async (url, init) => {
    visited.push(String(url))
    if (String(url).endsWith('/login')) return envelope(session({ apiKey: undefined, codexGatewayUrl: undefined }))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + session().token)
    return envelope({ apiKey: 'configured-gateway-key', gatewayPublicBaseUrl: 'https://gateway.example' })
  }
  const flow = await plugin.auth.methods[0].authorize(inputs)
  const result = await flow.callback()
  expect(result.key).toBe('configured-gateway-key')
  expect(result.metadata.baseURL).toBe('https://gateway.example/v1')
  expect(visited).toEqual([
    'https://console.example/api/auth/login',
    'https://console.example/api/auth/profile/gateway-config',
  ])
})

test('a renewal cannot adopt another user identity or a returned expired token', async () => {
  for (const changed of [session({ userId: 99 }), session({ token: 'expired-replacement', tokenExpiresAt: 1 })]) {
    const { plugin, result } = await login({ tokenExpiresAt: Math.floor(Date.now() / 1000) + 60 })
    const paths = []
    globalThis.fetch = async url => {
      paths.push(String(url))
      return envelope(String(url).endsWith('/me') ? changed : session({ token: 'relogin-token' }))
    }
    if (changed.userId === 99) {
      await expect(plugin.auth.refresh(stored(result))).rejects.toThrow('账号已变更')
      expect(paths).toHaveLength(1)
    } else {
      expect((await plugin.auth.refresh(stored(result))).access).toBe('relogin-token')
      expect(paths).toHaveLength(2)
    }
  }
})
