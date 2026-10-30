import { afterEach, expect, test } from 'bun:test'
import { httpDetails, safeDetails } from '../src/errors.mjs'
import { query } from '../src/transport.mjs'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('HTTP classification preserves only constrained retry information', () => {
  for (const [status, category] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limit'], [503, 'upstream'], [400, 'request']]) {
    expect(httpDetails(new Response(null, { status, headers: { 'retry-after': '30' } }))).toEqual({ status, category, retryAfter: '30' })
  }
  for (const retryAfter of ['private-value', '-1', '1.5', '999999999', '30\r\nprivate-value']) {
    expect(safeDetails({ retryAfter })).toEqual({})
  }
  const retryAfter = 'Wed, 21 Oct 2099 07:28:00 GMT'
  expect(safeDetails({ retryAfter, category: 'upstream', status: 502, message: 'private', code: 'private' }))
    .toEqual({ retryAfter, category: 'upstream', status: 502 })
})

test('response body failures preserve timeout, network and protocol categories', async () => {
  for (const [name, category] of [['TimeoutError', 'timeout'], ['AbortError', 'timeout'], ['TypeError', 'network'], ['Error', 'network']]) {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error('private'), { name }))
    } }))
    const error = await query('/models', { type: 'api', key: 'synthetic-key' }, 1000, 'https://relay.example').catch(error => error)
    expect(error.category).toBe(category)
    expect(error.message).not.toContain('private')
  }
  for (const body of ['invalid JSON', 'x'.repeat(4 * 1024 * 1024 + 1), null]) {
    globalThis.fetch = async () => new Response(body)
    const error = await query('/models', { type: 'api', key: 'synthetic-key' }, 1000, 'https://relay.example').catch(error => error)
    expect(error.category).toBe('protocol')
  }
})

test('query timeout and network categories do not copy exceptions', async () => {
  for (const [name, category] of [['TimeoutError', 'timeout'], ['AbortError', 'timeout'], ['TypeError', 'network']]) {
    globalThis.fetch = async () => { throw Object.assign(new Error('private'), { name }) }
    const error = await query('/models', { type: 'api', key: 'synthetic-key' }, 1000, 'https://relay.example').catch(error => error)
    expect(error.category).toBe(category)
    expect(error.message).not.toContain('private')
  }
})
