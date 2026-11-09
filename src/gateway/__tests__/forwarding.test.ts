import { present } from '../../../test/support/assertions.ts'
import { mockFetch } from '../../../test/support/fetch.ts'
import { afterEach, expect, test } from 'bun:test'
import { forward } from '../forwarding.ts'
import { BASE } from '../../../test/fixtures/gateway.ts'
import type { GatewayAccess } from '../../auth/types.ts'
const access: GatewayAccess = { baseURL: BASE, apiKey: '{{SECRET_cgqciwue}}' }
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('forwarding reads replacement credentials and preserves stream, body, headers and signal', async () => {
  let currentAccess = access
  const send = (input: string | URL | Request, init?: RequestInit) => forward(input, init, () => currentAccess, BASE)
  currentAccess = { ...access, apiKey: 'replacement-test-key' }
  const controller = new AbortController()
  const upstream = new Response('event: response.completed', { status: 429 })
  globalThis.fetch = mockFetch(async (url, init) => {
    expect(init.signal).toBe(controller.signal)
    expect(init.body).toBe('test-body')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer replacement-test-key')
    expect(new Headers(init.headers).get('x-request-id')).toBe('request-test')
    expect(new Headers(init.headers).has('cookie')).toBe(false)
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
    return upstream
  })
  expect(
    await send(BASE + '/responses', {
      method: 'POST',
      body: 'test-body',
      signal: controller.signal,
      headers: { cookie: 'test-cookie', 'x-api-key': 'foreign-test-key', 'x-request-id': 'request-test' },
    }),
  ).toBe(upstream)
})

test('forwarding handles Request input and canceled signals without consuming response', async () => {
  const send = (input: string | URL | Request, init?: RequestInit) => forward(input, init, () => access, BASE)
  const controller = new AbortController()
  const request = new Request(BASE + '/responses', {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
    headers: { cookie: 'test-cookie' },
  })
  globalThis.fetch = mockFetch(async (input, init) => {
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
  })
  const response = await send(request)
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe('first')
  controller.abort()
  globalThis.fetch = mockFetch(async (_input, init) => {
    present(init.signal).throwIfAborted()
    throw new Error('Expected the forwarded signal to be aborted')
  })
  await expect(send(BASE + '/responses', { signal: controller.signal })).rejects.toThrow()
})

test('forwarder refuses arbitrary paths, credential URLs and foreign hosts before network access', async () => {
  globalThis.fetch = mockFetch(async () => {
    throw new Error('must not fetch')
  })
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
    await expect(forward(url, undefined, () => access, BASE)).rejects.toThrow('outside')
  }
})

test('protocol forwarding uses current credentials with native headers and preserves the response without retries', async () => {
  let currentAccess = access
  const send = (input: string | URL | Request, init?: RequestInit) => forward(input, init, () => currentAccess, BASE)
  currentAccess = { ...access, apiKey: 'replacement-test-key' }
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
    globalThis.fetch = mockFetch(async (url, init) => {
      calls++
      expect(url).toBe(BASE + path)
      expect(init.body).toBe('original-body')
      expect(init.signal).toBe(controller.signal)
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01')
      expect(new Headers(init.headers).has('cookie')).toBe(false)
      for (const candidate of ['authorization', 'x-api-key', 'x-goog-api-key'])
        expect(new Headers(init.headers).get(candidate)).toBe(
          candidate === header ? (header === 'authorization' ? 'Bearer ' : '') + currentAccess.apiKey : null,
        )
      return upstream
    })
    const response = await send(BASE + path, {
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

test('a retained forwarder refuses an access whose gateway has changed', async () => {
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    return new Response('must not send credentials')
  })
  await expect(
    forward(BASE + '/responses', undefined, () => ({ ...access, baseURL: 'https://other.example/v1' }), BASE),
  ).rejects.toThrow('URL changed')
  expect(calls).toBe(0)
})
