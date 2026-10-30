import { afterEach, expect, test } from 'bun:test'
import { loadCatalog } from '../src/models.mjs'
import { query } from '../src/transport.mjs'

const originalFetch = globalThis.fetch
const baseURL = 'https://test-relay.example/v1'
const auth = { type: 'api', key: 'synthetic-query-key' }
const sensitive = 'synthetic-sensitive-cursor'
const path = '/models?cursor=' + sensitive
afterEach(() => { globalThis.fetch = originalFetch })

test('paginated HTTP errors hide cursor parameters and release the unread body', async () => {
  const visited = []
  let canceled = false
  globalThis.fetch = async url => {
    visited.push(url)
    if (visited.length === 1) {
      return Response.json({ data: [{ id: 'gpt-6.1-sol' }], next: '?cursor=' + sensitive })
    }
    return new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 503 })
  }
  const error = await loadCatalog(path => query(path, auth, 1000, baseURL), baseURL).catch(error => error)
  expect(visited).toEqual([baseURL + '/models', baseURL + path])
  expect(error.message).toBe('TET /models returned HTTP 503. Retry later.')
  expect(error.message).not.toContain(sensitive)
  expect(canceled).toBe(true)
})

for (const status of [401, 503]) {
  test('HTTP ' + status + ' retains its error when response cancellation fails', async () => {
    let canceled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      cancel() {
        canceled = true
        throw new Error(sensitive)
      },
    }), { status })
    const error = await query(path, auth, 1000, baseURL).catch(error => error)
    expect(canceled).toBe(true)
    expect(error.message).not.toContain(sensitive)
    if (status === 401) {
      expect(error.message).toBe('TET rejected the API key. Sign in again.')
      expect(error.signIn).toBe('expired')
    } else {
      expect(error.message).toBe('TET /models returned HTTP 503. Retry later.')
      expect(error.signIn).toBeUndefined()
    }
  })
}

test('network errors hide both raw exception details and pagination parameters', async () => {
  globalThis.fetch = async () => { throw new Error(sensitive + ' ' + auth.key) }
  const error = await query(path, auth, 1000, baseURL).catch(error => error)
  expect(error.message).toBe('TET /models query failed or timed out. Retry later.')
  expect(error.message).not.toContain(sensitive)
  expect(error.message).not.toContain(auth.key)
})

test('invalid JSON errors hide response content and pagination parameters', async () => {
  globalThis.fetch = async () => new Response(sensitive + ' ' + auth.key)
  const error = await query(path, auth, 1000, baseURL).catch(error => error)
  expect(error.message).toBe('TET /models returned invalid, oversized or interrupted JSON.')
  expect(error.message).not.toContain(sensitive)
  expect(error.message).not.toContain(auth.key)
})

test('empty JSON errors hide pagination parameters', async () => {
  globalThis.fetch = async () => new Response(null)
  const error = await query(path, auth, 1000, baseURL).catch(error => error)
  expect(error.message).toBe('TET /models returned an empty response.')
  expect(error.message).not.toContain(sensitive)
})
