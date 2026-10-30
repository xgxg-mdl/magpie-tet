import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../index.mjs'
import { settings as readSettings } from '../src/config.mjs'
import { mapUsage } from '../src/usage.mjs'
import { discoverModels, loadCatalog as readCatalog } from '../src/models.mjs'
import { createQueries as makeQueries, credentials } from '../src/transport.mjs'
const BASE = 'https://test-relay.example/v1'
const settings = (options = {}) => readSettings({ baseURL: BASE, ...options })
const loadCatalog = (read, baseURL = BASE) => readCatalog(read, baseURL)
const createQueries = () => {
  const query = makeQueries()
  return (path, auth, timeout, baseURL = BASE) => query(path, auth, timeout, baseURL)
}
const originalFetch = globalThis.fetch
const auth = { type: 'api', key: 'test-key-A', metadata: { baseURL: BASE } }
afterEach(() => { globalThis.fetch = originalFetch })
const catalog = { data: [{ id: 'gpt-6.1-sol', display_name: 'Sol' }] }
const wallet = { isValid: true, mode: 'unrestricted', balance: 9999999443,
  usage: { today: { actual_cost: 0, requests: 0, total_tokens: 50 }, total: { cost: 555 }, rpm: 14 } }

test('wallet does not invent percentage; costs and traffic are informational', () => {
  const result = mapUsage(wallet)
  expect(result.windows[0]).toEqual({ name: 'Wallet', balance: 9999999443, unit: 'USD' })
  expect(result.windows[1]).toEqual({ name: 'Today', display: '0 USD · 0 requests · 50 tokens', aside: true })
  expect(result.windows.at(-1)).toEqual({ name: 'Traffic', display: '14 RPM', aside: true })
  expect(result.windows.every(w => w.used === undefined)).toBe(true)
  expect(mapUsage(wallet, { showTraffic: false }).windows[1].display).toBe('0 USD')
  expect(mapUsage({ isValid: true }).error).toContain('did not report')
  expect(() => mapUsage({})).toThrow()
})
test('quota enforces actual limits; missing usage stays unknown instead of becoming zero', () => {
  const result = mapUsage({ isValid: true, mode: 'quota_limited', quota: { used: 101, limit: 100 },
    rate_limits: [null, { window: '5h', limit: 10, reset_at: '2030-11-01T00:00:00Z' }], expires_at: '2030-12-01T00:00:00Z' })
  expect(result.windows[0]).toMatchObject({ amount: 101, limit: 100 })
  expect(result.windows[1]).toMatchObject({ span: 18000, resetsAt: '2030-11-01T00:00:00Z' })
  expect(result.windows[1].amount).toBeUndefined()
  expect(result.windows[1].limit).toBeUndefined()
  expect(result.windows[1].display).toContain('usage unavailable')
  expect(result.windows[1].aside).toBeUndefined()
  expect(result.until).toBe('2030-12-01T00:00:00Z')
})
test('subscription respects server resets and omits unconfigured limits and guessed month spans', () => {
  const result = mapUsage({ isValid: true, subscription: { daily_usage_usd: 4, daily_limit_usd: 10,
    daily_reset_at: '2030-11-01T00:00:00Z', weekly_limit_usd: null, monthly_usage_usd: 6, monthly_limit_usd: 100 } })
  expect(result.windows[0]).toEqual({ name: 'Daily', amount: 4, limit: 10, unit: 'USD', span: 86400, resetsAt: '2030-11-01T00:00:00Z' })
  expect(result.windows[1].span).toBeUndefined()
  expect(result.windows[1].resetsAt).toBeUndefined()
})
test('invalid sign-in and business expiry remain distinct', () => {
  expect(mapUsage({ isValid: false }).signIn).toBe('expired')
  const expired = mapUsage({ isValid: true, balance: 5, expires_at: '2000-01-01' })
  expect(expired.error).toContain('expired')
  expect(expired.signIn).toBeUndefined()
})
test('models only expose supported text families, exact IDs and known capacities', () => {
  const known = { limit: { context: 12345, output: 1000 }, cost: { input: 2 } }
  const payload = { data: [...catalog.data, { id: 'gpt-image-2' }, { id: 'gpt-6-audio' },
    { id: 'gpt-4o-audio-preview' }, { id: 'codex-auto-review' }] }
  const models = discoverModels(payload, { models: { 'gpt-6.1-sol': known } }, settings())
  expect(Object.keys(models)).toEqual(['gpt-6.1-sol'])
  expect(models['gpt-6.1-sol']).toMatchObject({ name: 'Sol', providerID: 'tet', ...known })
  expect(models['gpt-6.1-sol'].api).toEqual({ id: 'gpt-6.1-sol', url: BASE, npm: '@ai-sdk/openai' })
})
test('model overrides configure verified capabilities and exclude exact IDs', () => {
  const opts = settings({ modelOverrides: { 'gpt-6.1-sol': { name: 'Custom Sol', imageInput: true,
    limit: { context: 10000, output: 1000 }, reasoningLevels: ['low', 'high'] } } })
  const model = discoverModels(catalog, { models: {} }, opts)['gpt-6.1-sol']
  expect(model.name).toBe('Custom Sol')
  expect(model.capabilities.input.image).toBe(true)
  expect(Object.keys(model.variants)).toEqual(['low', 'high'])
  expect(discoverModels(catalog, { models: {} }, settings({ excludeModels: ['gpt-6.1-sol'] }))).toEqual({})
  expect(discoverModels(catalog, { models: {} }, settings())['gpt-6.1-sol'].limit.context).toBe(0)
})
test('configuration rejects routing overrides and impossible limits before discovery', async () => {
  for (const opts of [ { modelOverrides: { m: { api: 'https://example.com' } } },
    { modelLimits: { m: { context: 1, output: 2 } } }, { queryTimeoutMs: 0 }, { showTraffic: 'yes' },
    { modelOverrides: { m: { reasoningLevels: ['guess'] } } } ]) {
    await expect(TetPlugin({}, opts)).rejects.toThrow()
  }
  expect(settings({ modelLimits: { m: { context: 10, output: 2 } } }).modelOverrides.m.limit.context).toBe(10)
})
test('custom API base applies to config, paginated models, usage and forwarding', async () => {
  const baseURL = 'https://relay.example/proxy/openai/v1'
  const auth = { type: 'api', key: 'test-key-A' }
  const plugin = await TetPlugin({}, { baseURL: baseURL + '///' })
  const cfg = {}
  await plugin.config(cfg)
  expect(cfg.provider.tet.api).toBe(baseURL)
  const visited = []
  globalThis.fetch = async (url, init) => {
    visited.push(String(url))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + auth.key)
    if (url === baseURL + '/models') return Response.json({ ...catalog, next: baseURL + '/models?page=2' })
    if (url === baseURL + '/models?page=2') return Response.json({ data: [] })
    if (url === baseURL + '/usage') return Response.json(wallet)
    if (url === baseURL + '/responses/compact') return Response.json({ ok: true })
    throw new Error('Unexpected endpoint')
  }
  const models = await plugin.provider.models({ models: {} }, { auth })
  expect(models['gpt-6.1-sol'].api.url).toBe(baseURL)
  expect((await plugin.auth.usage(async () => auth)).windows[0].balance).toBe(9999999443)
  const loader = await plugin.auth.loader(async () => auth)
  expect(loader.baseURL).toBe(baseURL)
  expect((await loader.fetch(baseURL + '/responses/compact')).status).toBe(200)
  await expect(loader.fetch(BASE + '/responses')).rejects.toThrow('outside')
  await expect(loader.fetch('https://relay.example/v1/responses')).rejects.toThrow('outside')
  expect(visited).toEqual([baseURL + '/models', baseURL + '/models?page=2', baseURL + '/usage', baseURL + '/responses/compact'])
  await expect(loadCatalog(async () => ({ data: [], next: '/v1/models?page=2' }), baseURL)).rejects.toThrow('outside')
})
test('API base validation rejects credentials and non-HTTP endpoints', () => {
  for (const baseURL of ['', 123, 'ftp://relay.example/v1', 'https://u:p@relay.example/v1',
    'https://relay.example/v1?token=test', 'https://relay.example/v1#fragment', '/v1']) {
    expect(() => settings({ baseURL })).toThrow()
  }
  expect(settings({ baseURL: ' https://relay.example/ ' }).baseURL).toBe('https://relay.example')
})
test('unconfigured plugin loads but cannot query or forward without an explicit address', async () => {
  const plugin = await TetPlugin()
  const cfg = {}
  await plugin.config(cfg)
  expect(cfg.provider.tet.api).toBeUndefined()
  expect(readSettings().baseURL).toBeUndefined()
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch') }
  const missing = { type: 'api', key: 'synthetic-key' }
  await expect(plugin.auth.loader(async () => missing)).rejects.toThrow('Configure an API base URL')
  await expect(plugin.provider.models({ models: {} }, { auth: missing })).rejects.toThrow('Configure an API base URL')
  expect((await plugin.auth.usage(async () => missing)).error).toContain('Configure an API base URL')
  await expect(plugin.auth.methods[0].authorize({})).rejects.toThrow('Configure an API base URL')
  const login = await plugin.auth.methods[0].authorize({ baseURL: BASE + '/' })
  expect(login.metadata.baseURL).toBe(BASE)
  expect(calls).toBe(0)
})
test('account address overrides package options and changing it invalidates old loaders', async () => {
  const plugin = await TetPlugin({}, { baseURL: 'https://fallback.example/v1' })
  let current = auth
  const loader = await plugin.auth.loader(async () => current)
  expect(loader.baseURL).toBe(BASE)
  current = { ...auth, key: 'new-site-key', metadata: { baseURL: 'https://new-site.example/v1' } }
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch') }
  await expect(loader.fetch(BASE + '/responses')).rejects.toThrow('URL changed')
  expect((await plugin.auth.loader(async () => current)).baseURL).toBe('https://new-site.example/v1')
  expect(calls).toBe(0)
})
test('in-flight queries for the same key stay isolated between API bases', async () => {
  const query = createQueries()
  const urls = []
  globalThis.fetch = async url => {
    urls.push(url)
    await new Promise(resolve => setTimeout(resolve, 5))
    return Response.json({ url })
  }
  const first = query('/usage', auth, 1000, 'https://first.example/v1')
  const second = query('/usage', auth, 1000, 'https://second.example/api/v1')
  expect(first).not.toBe(second)
  expect((await first).url).toBe('https://first.example/v1/usage')
  expect((await second).url).toBe('https://second.example/api/v1/usage')
  expect(urls.length).toBe(2)
})
test('safe model pagination reads all pages and rejects other origins, endpoints and cycles', async () => {
  const paths = []
  const payload = await loadCatalog(async path => {
    paths.push(path)
    return path === '/models' ? { data: [{ id: 'a' }], next: '?page=2' } : { data: [{ id: 'b' }] }
  })
  expect(payload.data.map(m => m.id)).toEqual(['a', 'b'])
  expect(paths).toEqual(['/models', '/models?page=2'])
  for (const next of ['https://example.com/v1/models', '/v1/usage', '/v1/models']) {
    await expect(loadCatalog(async () => ({ data: [], next }))).rejects.toThrow()
  }
})
test('cursor pagination requires progress', async () => {
  let calls = 0
  const result = await loadCatalog(async () => ++calls === 1 ? { data: [{ id: 'a' }], has_more: true } : { data: [{ id: 'b' }] })
  expect(result.data.length).toBe(2)
  await expect(loadCatalog(async () => ({ data: [], has_more: true }))).rejects.toThrow('cursor')
})
test('usage shows HTTP and auth failures; errors never include upstream body', async () => {
  const plugin = await TetPlugin()
  globalThis.fetch = async () => new Response('private-upstream-content', { status: 401 })
  expect(await plugin.auth.usage(async () => auth)).toMatchObject({ signIn: 'expired', windows: [] })
  globalThis.fetch = async () => new Response('private-upstream-content', { status: 500 })
  const failure = await plugin.auth.usage(async () => auth)
  expect(failure.error).toContain('HTTP 500')
  expect(failure.error).not.toContain('private')
  expect(failure.signIn).toBeUndefined()
  expect((await plugin.auth.usage(async () => null)).signIn).toBe('expired')
})
test('catalog failure is visible to host rather than reported as successful refresh', async () => {
  const plugin = await TetPlugin()
  globalThis.fetch = async () => new Response('bad json')
  await expect(plugin.provider.models({ models: { cached: {} } }, { auth })).rejects.toThrow('JSON')
  globalThis.fetch = async () => { throw new Error('secret network text') }
  await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow('query failed')
  expect(await plugin.provider.models({ models: { cached: {} } })).toEqual({})
})
test('queries use fixed endpoints, bearer auth, timeout and reject redirects', async () => {
  const plugin = await TetPlugin()
  globalThis.fetch = async (url, init) => {
    expect(url).toBe(BASE + '/models')
    expect(init.headers.authorization).toBe('Bearer ' + auth.key)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    return Response.json(catalog)
  }
  expect(Object.keys(await plugin.provider.models({ models: {} }, { auth }))).toEqual(['gpt-6.1-sol'])
})
test('query responses have a size bound', async () => {
  const query = createQueries()
  globalThis.fetch = async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))
  await expect(query('/usage', auth, 1000)).rejects.toThrow('oversized')
})
test('concurrent queries merge within a key, never across keys, and do not retain results', async () => {
  const query = createQueries()
  let calls = 0
  globalThis.fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return Response.json(wallet) }
  const a = query('/usage', auth, 1000), b = query('/usage', auth, 1000)
  expect(a).toBe(b)
  await Promise.all([a, b, query('/usage', { ...auth, key: 'test-key-B' }, 1000)])
  expect(calls).toBe(2)
  await query('/usage', auth, 1000)
  expect(calls).toBe(3)
})
test('loader reads replacement credentials and preserves stream, body, headers and signal', async () => {
  const plugin = await TetPlugin()
  let currentAuth = auth
  const loader = await plugin.auth.loader(async () => currentAuth)
  currentAuth = { ...auth, key: 'replacement-test-key' }
  const controller = new AbortController()
  const upstream = new Response('event: response.completed', { status: 429 })
  globalThis.fetch = async (url, init) => {
    expect(init.signal).toBe(controller.signal)
    expect(init.body).toBe('test-body')
    expect(init.headers.get('authorization')).toBe('Bearer replacement-test-key')
    expect(init.headers.get('x-request-id')).toBe('request-test')
    expect(init.headers.has('cookie')).toBe(false)
    expect(init.headers.has('x-api-key')).toBe(false)
    return upstream
  }
  expect(await loader.fetch(BASE + '/responses', { method: 'POST', body: 'test-body', signal: controller.signal,
    headers: { cookie: 'test-cookie', 'x-api-key': 'foreign-test-key', 'x-request-id': 'request-test' } })).toBe(upstream)
})
test('forwarding handles Request input and canceled signals without consuming response', async () => {
  const plugin = await TetPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  const controller = new AbortController()
  const request = new Request(BASE + '/responses', { method: 'POST', body: '{}', signal: controller.signal, headers: { cookie: 'test-cookie' } })
  globalThis.fetch = async (input, init) => {
    const forwarded = new Request(input, init)
    expect(forwarded.headers.has('cookie')).toBe(false)
    expect(await forwarded.text()).toBe('{}')
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('first')); c.close() } }))
  }
  const response = await loader.fetch(request)
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe('first')
  controller.abort()
  globalThis.fetch = async (_input, init) => { init.signal.throwIfAborted() }
  await expect(loader.fetch(BASE + '/responses', { signal: controller.signal })).rejects.toThrow()
})
test('forwarder refuses arbitrary paths, credential URLs and foreign hosts before network access', async () => {
  const plugin = await TetPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  globalThis.fetch = async () => { throw new Error('must not fetch') }
  for (const url of ['https://example.com/v1/responses', BASE + '/models', BASE + '/responses/unknown', 'https://u:p@test-relay.example/v1/responses']) {
    await expect(loader.fetch(url)).rejects.toThrow('outside')
  }
  expect(() => credentials({ type: 'api', key: 'a\nb' })).toThrow()
})
test('showTraffic toggle reads live host state without dropping structured model options', async () => {
  let visible = false
  const plugin = await TetPlugin({ magpie: { option: (id, key) => {
    expect(id).toBe('tet'); expect(key).toBe('show-traffic'); return visible
  } } }, { modelOverrides: { 'gpt-6.1-sol': { name: 'Configured Sol' } } })
  globalThis.fetch = async url => Response.json(url.endsWith('/usage') ? wallet : catalog)
  expect((await plugin.auth.usage(async () => auth)).windows[1].display).toBe('0 USD')
  visible = true
  expect((await plugin.auth.usage(async () => auth)).windows[1].display).toContain('50 tokens')
  expect((await plugin.provider.models({ models: {} }, { auth }))['gpt-6.1-sol'].name).toBe('Configured Sol')
})
test('identity and icon agree and user provider settings survive', async () => {
  const plugin = await TetPlugin()
  const cfg = { provider: { tet: { name: 'Custom' } } }
  await plugin.config(cfg)
  expect(cfg.provider.tet.name).toBe('Custom')
  expect(plugin.auth.icon).toStartWith('data:image/svg+xml;base64,')
  expect(plugin.auth.provider).toBe('tet')
  expect(plugin.provider.id).toBe('tet')
  expect(Object.keys(await import('../index.mjs'))).toEqual(['TetPlugin'])
})
