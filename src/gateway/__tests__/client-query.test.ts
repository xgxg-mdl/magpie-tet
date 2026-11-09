import { mockFetch } from '../../../test/support/fetch.ts'
import { afterEach, expect, test } from 'bun:test'
import { query, createQueries } from '../client.ts'
import { BASE, catalog, wallet } from '../../../test/fixtures/gateway.ts'
const access = { baseURL: BASE, apiKey: 'test-key-A' }
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('in-flight queries for the same key stay isolated between API bases', async () => {
  const query = createQueries()
  const urls: string[] = []
  globalThis.fetch = mockFetch(async url => {
    urls.push(String(url))
    await new Promise(resolve => setTimeout(resolve, 5))
    return Response.json({ url })
  })
  const first = query('/usage', { ...access, baseURL: 'https://first.example/v1' }, 1000)
  const second = query('/usage', { ...access, baseURL: 'https://second.example/api/v1' }, 1000)
  expect(first).not.toBe(second)
  expect(await first).toEqual({ url: 'https://first.example/v1/usage' })
  expect(await second).toEqual({ url: 'https://second.example/api/v1/usage' })
  expect(urls.length).toBe(2)
})

test('queries use fixed endpoints, bearer auth, timeout and reject redirects', async () => {
  globalThis.fetch = mockFetch(async (url, init) => {
    expect(url).toBe(BASE + '/models')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + access.apiKey)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    return Response.json(catalog)
  })
  expect(await query('/models', access, 1000)).toEqual(catalog)
})

test('query responses have a size bound', async () => {
  const query = createQueries()
  globalThis.fetch = mockFetch(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)))
  await expect(query('/usage', access, 1000)).rejects.toThrow('oversized')
})

test('concurrent queries merge within a key, never across keys, and do not retain results', async () => {
  const query = createQueries()
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 5))
    return Response.json(wallet)
  })
  const a = query('/usage', access, 1000),
    b = query('/usage', access, 1000)
  expect(a).toBe(b)
  await Promise.all([a, b, query('/usage', { ...access, apiKey: 'test-key-B' }, 1000)])
  expect(calls).toBe(2)
  await query('/usage', access, 1000)
  expect(calls).toBe(3)
})
