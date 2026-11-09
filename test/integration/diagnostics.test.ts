import { rejected } from '../support/assertions.ts'
import { mockFetch, requestBody } from '../support/fetch.ts'
import { record } from '../support/assertions.ts'
import { record as isRecord } from '../../src/validation.ts'
import { afterEach, expect, test } from 'bun:test'
import { probeRelay } from '../../scripts/diagnostics/relay-probe.mjs'
import { runCLI } from '../../scripts/diagnostics/relay.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const model = 'gpt-6-luna'
const options = { baseURL: 'https://relay.example', key: 'synthetic-test-key' }
const message = {
  id: 'synthetic',
  object: 'response',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
}
const sse = (payload: unknown) =>
  new Response(
    'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: payload }) + '\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

function upstream(generate?: (body: Record<string, unknown>, calls: number) => Response) {
  let calls = 0
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: model }] })
    if (String(url).endsWith('/usage')) return Response.json({ isValid: true, balance: 1 })
    calls++
    const body = requestBody(init)
    if (!generate) throw new Error('Unexpected generation request')
    return generate(body, calls)
  })
  return () => calls
}

test('discovery distinguishes rate limiting from an incorrect key without leaking headers', async () => {
  globalThis.fetch = mockFetch(async () => new Response(options.key, { status: 429, headers: { 'retry-after': '30' } }))
  const error = await rejected(probeRelay(options))
  expect(error.category).toBe('rate_limit')
  expect(error.status).toBe(429)
  expect(error.retryAfter).toBe('30')
  expect(error.message).not.toContain('Check the API address and key')
  expect(error.message).not.toContain(options.key)
})

test('usage failures retain safe structured diagnostics', async () => {
  upstream()
  const fetch = globalThis.fetch
  globalThis.fetch = mockFetch((url, init) =>
    String(url).endsWith('/usage') ? Promise.resolve(new Response('', { status: 503 })) : fetch(url, init),
  )
  const error = await rejected(probeRelay(options))
  expect(error.category).toBe('upstream')
  expect(error.status).toBe(503)
})

test('unavailable models stop generation and retain only an allowlisted error code', async () => {
  const calls = upstream(() =>
    Response.json({ error: { code: 'model_not_found', message: options.key } }, { status: 400 }),
  )
  const error = await rejected(probeRelay({ ...options, generate: true, model }))
  expect(error.category).toBe('model_unavailable')
  expect(error.code).toBe('model_not_found')
  expect(error.message).not.toContain(options.key)
  expect(calls()).toBe(1)
})

test('429 stops the complete probe sequence without automatic retries', async () => {
  const calls = upstream(() => new Response('', { status: 429 }))
  await expect(probeRelay({ ...options, generate: true, model, tools: true, structured: true })).rejects.toMatchObject({
    category: 'rate_limit',
  })
  expect(calls()).toBe(1)
})

test('tool and schema probes require separate opt-in and validate function results and schema semantics', async () => {
  const calls = upstream(body => {
    if (body.stream) return sse(message)
    if (isRecord(body.tool_choice) && body.tool_choice.type === 'function')
      return Response.json({
        ...message,
        output: [{ type: 'function_call', name: 'report_number', arguments: '{"value":7}', call_id: 'synthetic-call' }],
      })
    if (body.tool_choice === 'none') {
      expect(
        Array.isArray(body.input) &&
          body.input.some(
            (item: unknown) =>
              record(item).type === 'function_call_output' && record(item).call_id === 'synthetic-call',
          ),
      ).toBe(true)
      expect(body.previous_response_id).toBeUndefined()
      return Response.json(message)
    }
    if (isRecord(body.text) && body.text.format)
      return Response.json({
        ...message,
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      })
    return Response.json(message)
  })
  const result = await probeRelay({ ...options, generate: true, model, tools: true, structured: true })
  expect(result.generation).toEqual({ responses: 'passed', sse: 'passed', tools: 'passed', structured: 'passed' })
  expect(calls()).toBe(5)
})

test('HTTP 200 is insufficient when schema or function behavior is wrong', async () => {
  for (const flag of ['tools', 'structured']) {
    const calls = upstream(body => (body.stream ? sse(message) : Response.json(message)))
    await expect(probeRelay({ ...options, generate: true, model, [flag]: true })).rejects.toThrow('verification failed')
    expect(calls()).toBe(3)
  }
})

test('capability flags cannot silently enable paid requests', async () => {
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    throw new Error('Must not fetch')
  })
  await expect(probeRelay({ ...options, tools: true })).rejects.toThrow('--generate')
  await expect(probeRelay({ ...options, structured: true })).rejects.toThrow('--generate')
  expect(calls).toBe(0)
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error('Must not read credentials')
      },
    },
  )
  expect(await runCLI(['--tools'], env, { log() {}, error() {} })).toBe(1)
})

test('CLI reports a bounded error classification without printing upstream content', async () => {
  const output: string[] = []
  globalThis.fetch = mockFetch(
    async () => new Response(options.key, { status: 429, headers: { 'retry-after': options.key } }),
  )
  expect(
    await runCLI(
      [],
      { TET_BASE_URL: options.baseURL, TET_API_KEY: options.key },
      {
        log: text => output.push(text),
        error: text => output.push(text),
      },
    ),
  ).toBe(1)
  expect(output.join('\n')).toContain('[rate_limit] HTTP 429')
  expect(output.join('\n')).not.toContain(options.key)
  expect(output.join('\n')).not.toContain('Retry-After')
})

test('function verification refuses malformed or mismatched calls without a follow-up request', async () => {
  for (const call of [
    { name: 'report_number', arguments: '{"value":8}', call_id: 'synthetic' },
    { name: 'wrong', arguments: '{"value":7}', call_id: 'synthetic' },
    { name: 'report_number', arguments: 'invalid', call_id: 'synthetic' },
    { name: 'report_number', arguments: '{"value":7,"unexpected":true}', call_id: 'synthetic' },
    { name: 'report_number', arguments: '{"value":"7"}', call_id: 'synthetic' },
    { name: 'report_number', arguments: 'null', call_id: 'synthetic' },
    { name: 'report_number', arguments: '[]', call_id: 'synthetic' },
    { name: 'report_number', arguments: '{"value":7}' },
  ]) {
    const calls = upstream(body =>
      body.stream
        ? sse(message)
        : Response.json(body.tools ? { ...message, output: [{ type: 'function_call', ...call }] } : message),
    )
    await expect(probeRelay({ ...options, generate: true, model, tools: true })).rejects.toThrow('verification failed')
    expect(calls()).toBe(3)
  }
})

test('usage body timeouts retain their category through the CLI without leaking exceptions', async () => {
  upstream()
  const fetch = globalThis.fetch
  globalThis.fetch = mockFetch((url, init) =>
    String(url).endsWith('/usage')
      ? Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException(options.key, 'TimeoutError'))
              },
            }),
          ),
        )
      : fetch(url, init),
  )
  const output: string[] = []
  expect(
    await runCLI(
      [],
      { TET_BASE_URL: options.baseURL, TET_API_KEY: options.key },
      {
        log: text => output.push(text),
        error: text => output.push(text),
      },
    ),
  ).toBe(1)
  expect(output.join('\n')).toContain('[timeout]')
  expect(output.join('\n')).not.toContain(options.key)
})
