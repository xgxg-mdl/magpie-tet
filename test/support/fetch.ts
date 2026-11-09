const originalFetch = globalThis.fetch

export type FetchHandler = (input: RequestInfo | URL, init: RequestInit) => Response | Promise<Response>

export function mockFetch(handler: FetchHandler): typeof globalThis.fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(input, init ?? {})), {
    preconnect: originalFetch.preconnect,
  })
}
import assert from 'node:assert/strict'
import { record } from './assertions.ts'

export function requestBody(init: RequestInit): Record<string, unknown> {
  assert.equal(typeof init.body, 'string', 'Expected a JSON request body')
  assert.ok(typeof init.body === 'string')
  return record(JSON.parse(init.body))
}
