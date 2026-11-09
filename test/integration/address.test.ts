import type { HostConfig } from '../../src/host/types.ts'
import { present } from '../support/assertions.ts'
import { mockFetch } from '../support/fetch.ts'
import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../src/index.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('saved account roots normalize across catalog, pagination, usage and forwarding', async () => {
  const visited: string[] = []
  globalThis.fetch = mockFetch(async input => {
    const url = String(input)
    visited.push(url)
    if (String(url).endsWith('/v1/models'))
      return Response.json({ data: [{ id: 'gpt-6.1-sol' }], next: '/v1/models?page=2' })
    if (String(url).endsWith('/v1/models?page=2')) return Response.json({ data: [] })
    if (String(url).endsWith('/v1/usage')) return Response.json({ isValid: true, balance: 12.345 })
    if (String(url).endsWith('/v1/responses')) return Response.json({ ok: true })
    return new Response('', { status: 500 })
  })
  const plugin = await TetPlugin()
  const auth = { type: 'api', key: 'synthetic-key', metadata: { baseURL: 'https://relay.example' } }
  const login = await plugin.auth.methods[1].authorize({ baseURL: auth.metadata.baseURL })
  expect(login.metadata.baseURL).toBe('https://relay.example/v1')
  const models = await plugin.provider.models({ models: {} }, { auth })
  expect(present(present(models['gpt-6.1-sol']).api).url).toBe('https://relay.example/v1')
  expect((await plugin.auth.usage(async () => auth)).balance).toBe('12.35 USD')
  const loader = await plugin.auth.loader(async () => auth)
  expect(loader.baseURL).toBe('https://relay.example/v1')
  expect((await present(loader.fetch)(loader.baseURL + '/responses')).ok).toBe(true)
  await expect(present(loader.fetch)('https://relay.example/responses')).rejects.toThrow('outside')
  expect(visited).toEqual([
    'https://relay.example/v1/models',
    'https://relay.example/v1/models?page=2',
    'https://relay.example/v1/usage',
    'https://relay.example/v1/responses',
  ])
})

test('normalized roots do not trigger fallback requests after upstream failure', async () => {
  const visited: string[] = []
  globalThis.fetch = mockFetch(async url => {
    visited.push(String(url))
    return new Response('', { status: 500 })
  })
  const plugin = await TetPlugin({}, { baseURL: 'https://relay.example' })
  const auth = { type: 'api', key: 'synthetic-key' }
  await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow('HTTP 500')
  expect(visited).toEqual(['https://relay.example/v1/models'])
  const config: HostConfig = {}
  await plugin.config(config)
  expect(present(present(config.provider).tet).api).toBe('https://relay.example/v1')
})
