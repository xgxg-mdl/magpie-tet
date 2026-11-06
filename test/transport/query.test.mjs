import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../index.mjs'
import { BASE, auth, catalog, wallet, createQueries } from '../helpers/plugin.mjs'
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
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
  globalThis.fetch = async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 5))
    return Response.json(wallet)
  }
  const a = query('/usage', auth, 1000),
    b = query('/usage', auth, 1000)
  expect(a).toBe(b)
  await Promise.all([a, b, query('/usage', { ...auth, key: 'test-key-B' }, 1000)])
  expect(calls).toBe(2)
  await query('/usage', auth, 1000)
  expect(calls).toBe(3)
})
