import { afterEach, expect, test } from 'bun:test'
import { probeRelay, runCLI } from '../scripts/relay-smoke.mjs'

const originalFetch = globalThis.fetch
const baseURL = 'https://test-relay.example/v1'
const key = 'synthetic-relay-test-key'
const model = 'gpt-6.1-sol'
const response = { id: 'resp_synthetic', object: 'response', status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
const options = { baseURL, key }
afterEach(() => { globalThis.fetch = originalFetch })

function upstream(generate) {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + key)
    if (url === baseURL + '/models') return Response.json({ data: [{ id: model }, { id: 'gpt-image-2' }] })
    if (url === baseURL + '/usage') return Response.json({ isValid: true, balance: 10 })
    if (url === baseURL + '/responses' && generate) return generate(JSON.parse(init.body), init)
    throw new Error('Unexpected synthetic endpoint')
  }
  return requests
}

const event = payload => 'event: ' + payload.type + '\ndata: ' + JSON.stringify(payload) + '\n\n'
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } })

test('read-only probe exercises plugin hooks and never sends generation requests', async () => {
  const requests = upstream()
  const result = await probeRelay(options)
  expect(result).toEqual({ pluginModels: [model], usage: { ok: true, windows: 0 }, generation: 'skipped' })
  expect(requests.map(request => request.url)).toEqual([baseURL + '/models', baseURL + '/usage'])
})

test('missing authentication, implicit generation and unapproved HTTP fail before network access', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error(key) }
  await expect(probeRelay({ baseURL })).rejects.toThrow('TET_API_KEY')
  await expect(probeRelay({ ...options, baseURL: 'http://test-relay.example/v1' })).rejects.toThrow('--allow-http')
  await expect(probeRelay({ ...options, generate: true })).rejects.toThrow('explicit model')
  await expect(probeRelay({ ...options, generate: 'false' })).rejects.toThrow('boolean')
  expect(calls).toBe(0)
})

test('HTTP requires a separate explicit opt-in', async () => {
  const requests = []
  globalThis.fetch = async url => {
    requests.push(url)
    return Response.json(url.endsWith('/models') ? { data: [{ id: model }] } : { isValid: true, balance: 10 })
  }
  await probeRelay({ ...options, baseURL: 'http://test-relay.example/v1', allowHTTP: true })
  expect(requests.length).toBe(2)
})

test('model discovery and usage failures never count as a successful read-only probe', async () => {
  globalThis.fetch = async () => new Response(key, { status: 401 })
  await expect(probeRelay(options)).rejects.toThrow('model discovery failed')
  upstream()
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => url.endsWith('/usage') ? Response.json({ isValid: false }) : fetch(url, init)
  await expect(probeRelay(options)).rejects.toThrow('usage probe failed')
})

test('empty or fully filtered model catalogs cannot pass the read-only probe', async () => {
  for (const data of [[], [{ id: 'gpt-image-2' }]]) {
    const requests = []
    globalThis.fetch = async url => { requests.push(url); return Response.json({ data }) }
    await expect(probeRelay(options)).rejects.toThrow('no plugin-supported models')
    expect(requests).toEqual([baseURL + '/models'])
  }
})

test('explicit generation sends at most two requests and verifies JSON and chunked SSE completion', async () => {
  let calls = 0, canceled = false
  const requests = upstream((body, init) => {
    calls++
    expect(body).toEqual({ model, input: 'Reply only with OK.', max_output_tokens: 128, stream: calls === 2 })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    if (!body.stream) return Response.json(response)
    const text = ': keepalive\r\n\r\n' + event({ type: 'response.completed', response }).replaceAll('\n', '\r\n')
    const bytes = new TextEncoder().encode(text)
    return new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])) },
      cancel() { canceled = true },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  })
  expect((await probeRelay({ ...options, generate: true, model })).generation).toEqual({ responses: 'passed', sse: 'passed' })
  expect(requests.filter(request => request.url.endsWith('/responses')).length).toBe(2)
  expect(canceled).toBe(true)
})

test('unknown explicit models cannot trigger generation', async () => {
  const requests = upstream(() => { throw new Error('Generation must not run') })
  await expect(probeRelay({ ...options, generate: true, model: 'gpt-6-missing' })).rejects.toThrow('plugin-supported catalog')
  expect(requests.length).toBe(2)
})

test('HTTP 200 with a non-Responses body does not pass or trigger a second request', async () => {
  let calls = 0
  upstream(() => { calls++; return Response.json({ text: key }) })
  await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow('completed response')
  expect(calls).toBe(1)
})

for (const [name, output] of [
  ['empty output', []],
  ['reasoning-only output', [{ type: 'reasoning', summary: [] }]],
  ['blank output text', [{ type: 'message', content: [{ type: 'output_text', text: '  \n' }] }]],
]) {
  test('JSON and SSE reject completed responses with ' + name, async () => {
    const empty = { ...response, output }
    for (const stream of [false, true]) {
      let calls = 0
      upstream(body => {
        calls++
        return body.stream ? sse(event({ type: 'response.completed', response: empty })) : Response.json(stream ? response : empty)
      })
      await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow(stream ? 'invalid completed response' : 'did not return a completed response')
      expect(calls).toBe(stream ? 2 : 1)
    }
  })
}

test('non-streaming incomplete status is distinct from an invalid protocol and is never retried', async () => {
  let calls = 0
  upstream(() => { calls++; return Response.json({ ...response, status: 'incomplete' }) })
  await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow('Responses reported incomplete')
  expect(calls).toBe(1)
})

test('failed HTTP generation hides the upstream body and releases it', async () => {
  let canceled = false
  upstream(() => new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 503 }))
  const error = await probeRelay({ ...options, generate: true, model }).catch(error => error)
  expect(error.message).toBe('TET Responses returned [upstream] HTTP 503.')
  expect(canceled).toBe(true)
})

test('SSE rejects JSON substitutes and releases their bodies', async () => {
  let canceled = false
  upstream(body => body.stream ? new Response(new ReadableStream({ cancel() { canceled = true } }), {
    headers: { 'content-type': 'application/json' },
  }) : Response.json(response))
  await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow('did not return an event stream')
  expect(canceled).toBe(true)
})

for (const type of ['response.failed', 'response.incomplete', 'error']) {
  test('SSE recognizes ' + type + ' without exposing upstream error data', async () => {
    upstream(body => body.stream ? sse(event({ type, error: { message: key } })) : Response.json(response))
    const error = await probeRelay({ ...options, generate: true, model }).catch(error => error)
    expect(error.message).toBe('TET SSE reported ' + type + '.')
    expect(error.message).not.toContain(key)
  })
}

test('SSE without a complete successful terminal event fails', async () => {
  for (const text of ['data: [DONE]\n\n', event({ type: 'response.created' }), event({ type: 'response.completed', response }).trimEnd()]) {
    upstream(body => body.stream ? sse(text) : Response.json(response))
    await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow('without response.completed')
  }
})

test('a completed SSE label must contain a valid completed Responses object', async () => {
  upstream(body => body.stream ? sse(event({ type: 'response.completed', response: { ...response, status: 'in_progress' } })) : Response.json(response))
  await expect(probeRelay({ ...options, generate: true, model })).rejects.toThrow('invalid completed response')
})

test('generation reads have a size limit and do not expose oversized content', async () => {
  upstream(() => new Response(key + 'x'.repeat(4 * 1024 * 1024)))
  const error = await probeRelay({ ...options, generate: true, model }).catch(error => error)
  expect(error.message).toBe('TET generation response exceeds 4 MiB.')
  expect(error.message).not.toContain(key)
})

test('a stalled SSE read times out, aborts the request and cancels the body', async () => {
  let aborted = false, canceled = false
  upstream((body, init) => {
    if (!body.stream) return Response.json(response)
    init.signal.addEventListener('abort', () => { aborted = true })
    return new Response(new ReadableStream({ cancel() { canceled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  await expect(probeRelay({ ...options, generate: true, model, timeoutMs: 1000 })).rejects.toThrow('timed out')
  expect(aborted).toBe(true)
  expect(canceled).toBe(true)
})

test('CLI help does not read environment credentials or make requests', async () => {
  const output = []
  const env = new Proxy({}, { get() { throw new Error('Must not read environment') } })
  globalThis.fetch = async () => { throw new Error('Must not fetch') }
  expect(await runCLI(['--help'], env, { log: text => output.push(text), error: text => output.push(text) })).toBe(0)
  expect(output.join('\n')).toContain('Read-only by default')
})

test('CLI rejects unknown arguments without echoing values or reading credentials', async () => {
  const output = []
  const env = new Proxy({}, { get() { throw new Error('Must not read environment') } })
  expect(await runCLI(['--key', key], env, { log: text => output.push(text), error: text => output.push(text) })).toBe(1)
  expect(output.join('\n')).not.toContain(key)
  expect(output.join('\n')).toContain('Invalid command-line arguments')
  expect(await runCLI(['toString'], env, { log: text => output.push(text), error: text => output.push(text) })).toBe(1)
})

test('CLI requires both generation flags before reading credentials', async () => {
  const output = []
  const env = new Proxy({}, { get() { throw new Error('Must not read environment') } })
  for (const args of [['--generate'], ['--model', key]]) {
    expect(await runCLI(args, env, { log: text => output.push(text), error: text => output.push(text) })).toBe(1)
  }
  expect(output.join('\n')).toContain('explicit --model ID')
  expect(output.join('\n')).not.toContain(key)
})

test('CLI uses environment credentials and reports only safe probe results', async () => {
  const output = []
  upstream()
  expect(await runCLI([], { TET_BASE_URL: baseURL, TET_API_KEY: key }, { log: text => output.push(text), error: text => output.push(text) })).toBe(0)
  expect(output.join('\n')).toContain('pluginModels')
  expect(output.join('\n')).not.toContain(key)
  expect(output.join('\n')).not.toContain('balance')
  expect(output.join('\n')).not.toContain(baseURL)
})

test('CLI generation warns about cost and never prints generated text or credentials', async () => {
  const output = []
  const completed = { ...response, output: [{ type: 'message', content: [{ type: 'output_text', text: 'synthetic-generated-text' }] }] }
  upstream(body => body.stream ? sse(event({ type: 'response.completed', response: completed })) : Response.json(completed))
  expect(await runCLI(['--base-url', baseURL, '--generate', '--model', model], { TET_API_KEY: key }, {
    log: text => output.push(text), error: text => output.push(text),
  })).toBe(0)
  expect(output.join('\n')).toContain('billable requests')
  expect(output.join('\n')).not.toContain('synthetic-generated-text')
  expect(output.join('\n')).not.toContain(key)
})
