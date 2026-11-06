import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../index.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
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
  const login = await plugin.auth.methods[1].authorize({ baseURL: auth.metadata.baseURL })
  expect(login.metadata.baseURL).toBe('https://relay.example/v1')
  const models = await plugin.provider.models({ models: {} }, { auth })
  expect(models['gpt-6.1-sol'].api.url).toBe('https://relay.example/v1')
  expect((await plugin.auth.usage(async () => auth)).balance).toBe('12.35 USD')
  const loader = await plugin.auth.loader(async () => auth)
  expect(loader.baseURL).toBe('https://relay.example/v1')
  expect((await loader.fetch(loader.baseURL + '/responses')).ok).toBe(true)
  await expect(loader.fetch('https://relay.example/responses')).rejects.toThrow('outside')
  expect(visited).toEqual([
    'https://relay.example/v1/models',
    'https://relay.example/v1/models?page=2',
    'https://relay.example/v1/usage',
    'https://relay.example/v1/responses',
  ])
})

test('normalized roots do not trigger fallback requests after upstream failure', async () => {
  const visited = []
  globalThis.fetch = async url => {
    visited.push(String(url))
    return new Response('', { status: 500 })
  }
  const plugin = await TetPlugin({}, { baseURL: 'https://relay.example' })
  const auth = { type: 'api', key: 'synthetic-key' }
  await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow('HTTP 500')
  expect(visited).toEqual(['https://relay.example/v1/models'])
  const config = {}
  await plugin.config(config)
  expect(config.provider.tet.api).toBe('https://relay.example/v1')
})
