import { rejected } from '../../../test/support/assertions.ts'
import { mockFetch } from '../../../test/support/fetch.ts'
import { afterEach, expect, test } from 'bun:test'
import { loadCatalog } from '../models.ts'
import { query } from '../client.ts'

const originalFetch = globalThis.fetch
const baseURL = 'https://test-relay.example/v1'
const access = { baseURL, apiKey: 'synthetic-query-key' }
const sensitive = 'synthetic-sensitive-cursor'
const path = '/models?cursor=' + sensitive
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('paginated HTTP errors hide cursor parameters and release the unread body', async () => {
  const visited: string[] = []
  let canceled = false
  globalThis.fetch = mockFetch(async url => {
    visited.push(String(url))
    if (visited.length === 1) {
      return Response.json({ data: [{ id: 'gpt-6.1-sol' }], next: '?cursor=' + sensitive })
    }
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true
        },
      }),
      { status: 503 },
    )
  })
  const error = await rejected(loadCatalog(path => query(path, access, 1000), baseURL))
  expect(visited).toEqual([baseURL + '/models', baseURL + path])
  expect(error.message).toBe('TET /models returned HTTP 503. Retry later.')
  expect(error.message).not.toContain(sensitive)
  expect(canceled).toBe(true)
})

for (const status of [401, 503]) {
  test('HTTP ' + status + ' retains its error when response cancellation fails', async () => {
    let canceled = false
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true
              throw new Error(sensitive)
            },
          }),
          { status },
        ),
    )
    const error = await rejected(query(path, access, 1000))
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
  globalThis.fetch = mockFetch(async () => {
    throw new Error(sensitive + ' ' + access.apiKey)
  })
  const error = await rejected(query(path, access, 1000))
  expect(error.message).toBe('TET /models query failed or timed out. Retry later.')
  expect(error.message).not.toContain(sensitive)
  expect(error.message).not.toContain(access.apiKey)
})

test('invalid JSON errors hide response content and pagination parameters', async () => {
  globalThis.fetch = mockFetch(async () => new Response(sensitive + ' ' + access.apiKey))
  const error = await rejected(query(path, access, 1000))
  expect(error.message).toBe('TET /models returned invalid, oversized or interrupted JSON.')
  expect(error.message).not.toContain(sensitive)
  expect(error.message).not.toContain(access.apiKey)
})

test('empty JSON errors hide pagination parameters', async () => {
  globalThis.fetch = mockFetch(async () => new Response(null))
  const error = await rejected(query(path, access, 1000))
  expect(error.message).toBe('TET /models returned an empty response.')
  expect(error.message).not.toContain(sensitive)
})
