import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../index.mjs'
import { apiBase } from '../src/config.mjs'
import { mapUsage } from '../src/usage.mjs'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('API roots gain v1 while explicit prefixes are preserved', () => {
  for (const input of ['https://relay.example', ' https://relay.example/// ', 'https://relay.example/v1/']) {
    expect(apiBase(input)).toBe('https://relay.example/v1')
    expect(apiBase(apiBase(input))).toBe(apiBase(input))
  }
  for (const path of ['/proxy/openai', '/proxy/v1', '/v2', '/v1beta']) {
    expect(apiBase('https://relay.example' + path + '/')).toBe('https://relay.example' + path)
  }
})

test('saved account roots normalize across catalog, pagination, usage and forwarding', async () => {
  const visited = []
  globalThis.fetch = async input => {
    const url = String(input)
    visited.push(url)
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gpt-6.1-sol' }], next: '/v1/models?page=2' })
    if (url.endsWith('/v1/models?page=2')) return Response.json({ data: [] })
    if (url.endsWith('/v1/usage')) return Response.json({ isValid: true, balance: 12.345 })
    if (url.endsWith('/v1/responses')) return Response.json({ ok: true })
    return new Response('', { status: 500 })
  }
  const plugin = await TetPlugin()
  const auth = { type: 'api', key: 'synthetic-key', metadata: { baseURL: 'https://relay.example' } }
  const login = await plugin.auth.methods[0].authorize({ baseURL: auth.metadata.baseURL })
  expect(login.metadata.baseURL).toBe('https://relay.example/v1')
  const models = await plugin.provider.models({ models: {} }, { auth })
  expect(models['gpt-6.1-sol'].api.url).toBe('https://relay.example/v1')
  expect((await plugin.auth.usage(async () => auth)).balance).toBe('$12.35')
  const loader = await plugin.auth.loader(async () => auth)
  expect(loader.baseURL).toBe('https://relay.example/v1')
  expect((await loader.fetch(loader.baseURL + '/responses')).ok).toBe(true)
  await expect(loader.fetch('https://relay.example/responses')).rejects.toThrow('outside')
  expect(visited).toEqual(['https://relay.example/v1/models', 'https://relay.example/v1/models?page=2',
    'https://relay.example/v1/usage', 'https://relay.example/v1/responses'])
})

test('wallets use one native balance without fabricating progress', () => {
  for (const balance of [0, -1.234, 12.345, 9999999385.337]) {
    const usage = mapUsage({ isValid: true, balance })
    expect(usage.balance).toBe(balance.toLocaleString('en-US', { style: 'currency', currency: 'USD' }))
    expect(usage.windows).toEqual([])
  }
  expect(mapUsage({ isValid: true, balance: 12.3456, unit: 'EUR' }).balance).toBe('12.35 EUR')
})

test('costs display two decimals without presenting small nonzero charges as zero', () => {
  const data = { isValid: true, balance: 10, usage: {
    today: { cost: 0.0001, requests: 12, total_tokens: 345 }, total: { actual_cost: 1.2345 }, rpm: 2, tpm: 1000,
  } }
  const usage = mapUsage(data)
  expect(usage.windows).toEqual([
    { name: 'Today', display: '<$0.01 · 12 req · 345 tok', aside: true },
    { name: 'Total', display: '$1.23', aside: true },
    { name: 'Usage', display: '2 RPM · 1,000 TPM', aside: true },
  ])
  expect(mapUsage(data, { showTraffic: false }).windows).toEqual([
    { name: 'Today', display: '<$0.01', aside: true },
    { name: 'Total', display: '$1.23', aside: true },
  ])
})

test('real limits retain native progress and unknown usage remains unknown', () => {
  const usage = mapUsage({ isValid: true, subscription: {
    daily_limit_usd: 10, daily_usage_usd: 2, weekly_limit_usd: 100, monthly_limit_usd: 1000, monthly_usage_usd: 1200,
  } })
  expect(usage.windows[0]).toEqual({ name: '1 day', amount: 2, limit: 10, unit: 'USD', span: 86400 })
  expect(usage.windows[1]).toEqual({ name: 'Weekly', display: 'Limit $100.00 · usage unavailable', span: 604800 })
  expect(usage.windows[2]).toMatchObject({ amount: 1200, limit: 1000, unit: 'USD' })
  expect(usage.windows.every(window => window.aside === undefined)).toBe(true)
})

test('known period labels translate without interpreting arbitrary server names as object keys', () => {
  const windows = ['5h', '1d', '7d', '__proto__', 'constructor']
  const usage = mapUsage({ isValid: true, mode: 'quota_limited',
    rate_limits: windows.map(window => ({ window, used: 1, limit: 10 })) })
  expect(usage.windows.map(window => window.name)).toEqual(['5 hours', '1 day', '7 days', '__proto__', 'constructor'])
  expect(usage.windows.slice(3).every(window => window.span === undefined)).toBe(true)
})

test('normalized roots do not trigger fallback requests after upstream failure', async () => {
  const visited = []
  globalThis.fetch = async url => { visited.push(String(url)); return new Response('', { status: 500 }) }
  const plugin = await TetPlugin({}, { baseURL: 'https://relay.example' })
  const auth = { type: 'api', key: 'synthetic-key' }
  await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow('HTTP 500')
  expect(visited).toEqual(['https://relay.example/v1/models'])
  const config = {}
  await plugin.config(config)
  expect(config.provider.tet.api).toBe('https://relay.example/v1')
})
