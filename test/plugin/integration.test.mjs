import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../index.mjs'
import { settings as readSettings } from '../../src/config.mjs'
import { BASE, auth, catalog, wallet, loadCatalog } from '../helpers/plugin.mjs'
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
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
  expect((await plugin.auth.usage(async () => auth)).balance).toBe('9,999,999,443.00 USD')
  const loader = await plugin.auth.loader(async () => auth)
  expect(loader.baseURL).toBe(baseURL)
  expect((await loader.fetch(baseURL + '/responses/compact')).status).toBe(200)
  await expect(loader.fetch(BASE + '/responses')).rejects.toThrow('outside')
  await expect(loader.fetch('https://relay.example/v1/responses')).rejects.toThrow('outside')
  expect(visited).toEqual([
    baseURL + '/models',
    baseURL + '/models?page=2',
    baseURL + '/usage',
    baseURL + '/responses/compact',
  ])
  await expect(loadCatalog(async () => ({ data: [], next: '/v1/models?page=2' }), baseURL)).rejects.toThrow('outside')
})

test('unconfigured plugin loads but cannot query or forward without an explicit address', async () => {
  const plugin = await TetPlugin()
  const cfg = {}
  await plugin.config(cfg)
  expect(cfg.provider.tet.api).toBeUndefined()
  expect(readSettings().baseURL).toBeUndefined()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  const missing = { type: 'api', key: 'synthetic-key' }
  await expect(plugin.auth.loader(async () => missing)).rejects.toThrow('Configure an API base URL')
  await expect(plugin.provider.models({ models: {} }, { auth: missing })).rejects.toThrow('Configure an API base URL')
  expect((await plugin.auth.usage(async () => missing)).error).toContain('Configure an API base URL')
  await expect(plugin.auth.methods[1].authorize({})).rejects.toThrow('Configure an API base URL')
  const login = await plugin.auth.methods[1].authorize({ baseURL: BASE + '/' })
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
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  await expect(loader.fetch(BASE + '/responses')).rejects.toThrow('URL changed')
  expect((await plugin.auth.loader(async () => current)).baseURL).toBe('https://new-site.example/v1')
  expect(calls).toBe(0)
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
  globalThis.fetch = async () => {
    throw new Error('secret network text')
  }
  await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow('query failed')
  expect(await plugin.provider.models({ models: { cached: {} } })).toEqual({})
})

test('showTraffic toggle reads live host state without dropping structured model options', async () => {
  let visible = false
  const plugin = await TetPlugin(
    {
      magpie: {
        option: (id, key) => {
          expect(id).toBe('tet')
          expect(key).toBe('show-traffic')
          return visible
        },
      },
    },
    { modelOverrides: { 'gpt-6.1-sol': { name: 'Configured Sol' } } },
  )
  globalThis.fetch = async url => Response.json(url.endsWith('/usage') ? wallet : catalog)
  expect((await plugin.auth.usage(async () => auth)).windows[0].display).toBe('$0.00')
  visible = true
  expect((await plugin.auth.usage(async () => auth)).windows[0].display).toContain('50 tok')
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
  expect(Object.keys(await import('../../index.mjs'))).toEqual(['TetPlugin'])
})
