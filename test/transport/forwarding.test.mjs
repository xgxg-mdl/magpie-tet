import { afterEach, expect, test } from 'bun:test'
import { TetPlugin } from '../../index.mjs'
import { credentials } from '../../src/transport.mjs'
import { BASE, auth } from '../helpers/plugin.mjs'
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
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
  expect(
    await loader.fetch(BASE + '/responses', {
      method: 'POST',
      body: 'test-body',
      signal: controller.signal,
      headers: { cookie: 'test-cookie', 'x-api-key': 'foreign-test-key', 'x-request-id': 'request-test' },
    }),
  ).toBe(upstream)
})

test('forwarding handles Request input and canceled signals without consuming response', async () => {
  const plugin = await TetPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  const controller = new AbortController()
  const request = new Request(BASE + '/responses', {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
    headers: { cookie: 'test-cookie' },
  })
  globalThis.fetch = async (input, init) => {
    const forwarded = new Request(input, init)
    expect(forwarded.headers.has('cookie')).toBe(false)
    expect(await forwarded.text()).toBe('{}')
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('first'))
          c.close()
        },
      }),
    )
  }
  const response = await loader.fetch(request)
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe('first')
  controller.abort()
  globalThis.fetch = async (_input, init) => {
    init.signal.throwIfAborted()
  }
  await expect(loader.fetch(BASE + '/responses', { signal: controller.signal })).rejects.toThrow()
})

test('forwarder refuses arbitrary paths, credential URLs and foreign hosts before network access', async () => {
  const plugin = await TetPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  globalThis.fetch = async () => {
    throw new Error('must not fetch')
  }
  for (const url of [
    'https://example.com/v1/responses',
    BASE + '/models',
    BASE + '/responses/unknown',
    BASE + '/messages/count_tokens',
    BASE + '/images/generations',
    BASE + '/models/custom:delete',
    BASE + '/models/nested/custom:generateContent',
    BASE + '-other/chat/completions',
    'https://u:p@test-relay.example/v1/responses',
  ]) {
    await expect(loader.fetch(url)).rejects.toThrow('outside')
  }
  expect(() => credentials({ type: 'api', key: 'a\nb' })).toThrow()
})

test('protocol forwarding uses current credentials with native headers and preserves the response without retries', async () => {
  const plugin = await TetPlugin()
  let currentAuth = auth
  const loader = await plugin.auth.loader(async () => currentAuth)
  currentAuth = { ...auth, key: 'replacement-test-key' }
  for (const [path, header] of [
    ['/responses/compact', 'authorization'],
    ['/chat/completions', 'authorization'],
    ['/messages', 'x-api-key'],
    ['/models/custom:generateContent', 'x-goog-api-key'],
    ['/models/custom:streamGenerateContent?alt=sse', 'x-goog-api-key'],
  ]) {
    let calls = 0
    const controller = new AbortController()
    const upstream = new Response('synthetic-stream', { status: 403 })
    globalThis.fetch = async (url, init) => {
      calls++
      expect(url).toBe(BASE + path)
      expect(init.body).toBe('original-body')
      expect(init.signal).toBe(controller.signal)
      expect(init.redirect).toBe('error')
      expect(init.headers.get('anthropic-version')).toBe('2023-06-01')
      expect(init.headers.has('cookie')).toBe(false)
      for (const candidate of ['authorization', 'x-api-key', 'x-goog-api-key'])
        expect(init.headers.get(candidate)).toBe(
          candidate === header ? (header === 'authorization' ? 'Bearer ' : '') + currentAuth.key : null,
        )
      return upstream
    }
    const response = await loader.fetch(BASE + path, {
      method: 'POST',
      body: 'original-body',
      signal: controller.signal,
      headers: {
        authorization: 'old',
        'x-api-key': 'old',
        'x-goog-api-key': 'old',
        cookie: 'old',
        'anthropic-version': '2023-06-01',
      },
    })
    expect(response).toBe(upstream)
    expect(response.bodyUsed).toBe(false)
    expect(calls).toBe(1)
  }
})
