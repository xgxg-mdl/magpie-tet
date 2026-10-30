import { pathToFileURL } from 'node:url'
import { TetPlugin } from '../index.mjs'
import { apiBase, PROVIDER } from '../src/config.mjs'
import { httpDetails, safeDetails } from '../src/errors.mjs'

const MAX_BYTES = 4 * 1024 * 1024
const HELP = `Usage: bun run test:relay -- [options]

Read-only by default: verify the TET plugin model catalog and usage hooks.
TET_API_KEY supplies the credential; TET_BASE_URL supplies the API base URL.

  --base-url URL   Override TET_BASE_URL, including the API path prefix
  --allow-http     Permit sending credentials over unencrypted HTTP
  --generate      Send up to two billable Responses requests
  --tools         Add two billable function-call/result checks (requires --generate)
  --structured    Add one billable JSON schema check (requires --generate)
  --model ID      Explicit plugin model ID required with --generate
  --help          Show this help without reading credentials or making requests

Only plugin-supported model IDs and probe status are printed.
`

class ProbeError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, safeDetails(details)) }
}

function failure(stage, error) {
  const details = safeDetails(error)
  return new ProbeError(stage + (details.category ? ' [' + details.category + ']' : '') +
    (details.status ? ' HTTP ' + details.status : '') +
    (details.retryAfter ? '; Retry-After: ' + details.retryAfter : '') + '.', details)
}

/** 错误体只限量读取 JSON，且仅允许模型不可用这一固定代码。 */
async function responseFailure(response, signal) {
  const details = httpDetails(response)
  const size = response.headers.get('content-length')
  if (response.status === 400 || response.status === 404) {
    if ((size === null || (/^\d+$/.test(size) && Number(size) <= 8192)) && response.headers.get('content-type')?.includes('application/json')) {
      const reader = response.body?.getReader()
      if (reader) {
        try {
          const chunks = []
          let bytes = 0
          for (;;) {
            const { value, done } = await abortable(reader.read(), signal)
            if (done) break
            bytes += value.byteLength
            if (bytes > 8192) break
            chunks.push(value)
          }
          if (bytes <= 8192 && JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code === 'model_not_found') {
            details.category = 'model_unavailable'
            details.code = 'model_not_found'
          }
        } catch {} finally { try { void reader.cancel().catch(() => {}) } catch {}; reader.releaseLock() }
      }
    }
  }
  try { void response.body?.cancel().catch(() => {}) } catch {}
  return failure('TET Responses returned', details)
}

/** 即使合成响应没有实现 fetch 的取消约定，也不能让诊断无限等待。 */
async function abortable(task, signal) {
  let abort
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      abort = () => reject(new ProbeError('TET generation probe timed out.', { category: 'timeout' }))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

function completed(response) {
  return response?.object === 'response' && typeof response.id === 'string' && response.id.length > 0 &&
    response.status === 'completed' && !response.error && Array.isArray(response.output) &&
    response.output.some(item => item?.type === 'message' && Array.isArray(item.content) &&
      item.content.some(part => part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim().length > 0))
}

function completedEvent(frame) {
  const lines = frame.split(/\r\n|\r|\n/)
  const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
  const failed = new Set(['error', 'response.failed', 'response.incomplete'])
  if (failed.has(event)) throw new ProbeError('TET SSE reported ' + event + '.')
  if (!data || data === '[DONE]') return false
  let payload
  try { payload = JSON.parse(data) } catch { throw new ProbeError('TET SSE returned invalid event data.') }
  if (failed.has(payload?.type)) throw new ProbeError('TET SSE reported ' + payload.type + '.')
  if (event && event !== 'message' && event !== payload?.type) throw new ProbeError('TET SSE returned inconsistent event types.')
  if (payload?.type !== 'response.completed') return false
  if (!completed(payload.response)) throw new ProbeError('TET SSE returned an invalid completed response.')
  return true
}

async function generationProbe(loader, model, stream, timeoutMs, extra = {}, verify) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    const response = await abortable(loader.fetch(loader.baseURL + '/responses', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify({ model, input: 'Reply only with OK.', max_output_tokens: 128, stream, ...extra }),
    }), controller.signal)
    if (!response.ok) {
      throw await responseFailure(response, controller.signal)
    }
    reader = response.body?.getReader()
    if (!reader) throw new ProbeError('TET Responses returned an empty body.')
    if (stream && !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new ProbeError('TET SSE did not return an event stream.')
    }
    const decoder = new TextDecoder()
    let text = '', bytes = 0
    for (;;) {
      const { done, value } = await abortable(reader.read(), controller.signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new ProbeError('TET generation response exceeds 4 MiB.')
      text += decoder.decode(value, { stream: true })
      if (!stream) continue
      let boundary
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(text))) {
        const frame = text.slice(0, boundary.index)
        text = text.slice(boundary.index + boundary[0].length)
        if (completedEvent(frame)) return
      }
    }
    if (stream) throw new ProbeError('TET SSE ended without response.completed.')
    text += decoder.decode()
    let payload
    try { payload = JSON.parse(text) } catch { throw new ProbeError('TET Responses returned invalid JSON.') }
    if (payload?.object === 'response' && ['failed', 'incomplete'].includes(payload.status)) {
      throw new ProbeError('TET Responses reported ' + payload.status + '.')
    }
    if (verify) {
      if (payload?.object !== 'response' || payload.status !== 'completed' || payload.error || !verify(payload)) {
        throw new ProbeError('TET capability verification failed.', { category: 'protocol' })
      }
    } else if (!completed(payload)) throw new ProbeError('TET Responses did not return a completed response.')
    return payload
  } catch (error) {
    throw error instanceof ProbeError ? error : new ProbeError('TET generation request failed or timed out.',
      { category: controller.signal.aborted ? 'timeout' : 'network' })
  } finally {
    clearTimeout(timer)
    if (reader) {
      try { void reader.cancel().catch(() => {}) } catch {}
      reader.releaseLock()
    }
  }
}

/** 通过插件公开钩子核对，不绕过账号地址与凭据隔离；生成必须单独显式开启。 */
export async function probeRelay({ baseURL, key, model, generate = false, allowHTTP = false, tools = false, structured = false, timeoutMs = 15000 } = {}) {
  if ([generate, allowHTTP, tools, structured].some(value => typeof value !== 'boolean')) throw new ProbeError('Probe switches must be boolean.')
  if ((tools || structured) && !generate) throw new ProbeError('Capability checks require --generate and --model.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new ProbeError('Probe timeout must be between 1000 and 60000 ms.')
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new ProbeError('A valid TET_API_KEY is required.')
  if (generate && (typeof model !== 'string' || !model)) throw new ProbeError('An explicit model ID is required for generation.')
  let base
  try { base = apiBase(baseURL) } catch { throw new ProbeError('A valid API base URL is required, including its API path prefix.') }
  if (new URL(base).protocol === 'http:' && !allowHTTP) throw new ProbeError('HTTP credentials require explicit --allow-http consent.')
  const plugin = await TetPlugin({}, { queryTimeoutMs: timeoutMs })
  const login = await plugin.auth.methods[0].authorize({ baseURL: base })
  const auth = { type: 'api', key, metadata: login.metadata }
  const config = {}
  await plugin.config(config)
  let models
  try { models = await plugin.provider.models(config.provider[PROVIDER], { auth }) }
  catch (error) { throw failure('TET plugin model discovery failed', error) }
  const pluginModels = Object.keys(models).sort()
  if (!pluginModels.length) throw new ProbeError('TET has no plugin-supported models.')
  const usage = await plugin.auth.usage(async () => auth)
  if (usage.error || !Array.isArray(usage.windows)) throw failure('TET plugin usage probe failed', usage.signIn ? { ...usage, category: 'authentication' } : usage)
  const result = { pluginModels, usage: { ok: true, windows: usage.windows.length }, generation: 'skipped' }
  if (!generate) return result
  if (!Object.hasOwn(models, model)) throw new ProbeError('The requested model is not in the plugin-supported catalog.')
  const loader = await plugin.auth.loader(async () => auth)
  await generationProbe(loader, model, false, timeoutMs)
  await generationProbe(loader, model, true, timeoutMs)
  const generation = { responses: 'passed', sse: 'passed' }
  if (tools) {
    const tool = { type: 'function', name: 'report_number', description: 'Report the supplied number.', strict: true,
      parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }
    const input = [{ role: 'user', content: 'Call report_number with value 7. After the result, reply OK.' }]
    const called = await generationProbe(loader, model, false, timeoutMs,
      { input, tools: [tool], tool_choice: { type: 'function', name: tool.name } }, payload => {
        const calls = Array.isArray(payload.output) ? payload.output.filter(item => item?.type === 'function_call') : []
        if (calls.length !== 1) return false
        try {
          const args = JSON.parse(calls[0].arguments)
          return calls[0].name === tool.name && typeof calls[0].call_id === 'string' && !!calls[0].call_id &&
            args !== null && typeof args === 'object' && !Array.isArray(args) &&
            Object.keys(args).length === 1 && Object.hasOwn(args, 'value') && Number.isInteger(args.value) && args.value === 7
        }
        catch { return false }
      })
    const call = called.output.find(item => item.type === 'function_call')
    /** 显式传回完整历史，不借助当前账号不支持的服务端会话。 */
    await generationProbe(loader, model, false, timeoutMs, { tools: [tool], tool_choice: 'none',
      input: [...input, ...called.output, { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' }] },
      payload => completed(payload) && outputText(payload).trim() === 'OK')
    generation.tools = 'passed'
  }
  if (structured) {
    await generationProbe(loader, model, false, timeoutMs, { input: 'Return an object with ok equal to true.',
      text: { format: { type: 'json_schema', name: 'probe', strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } },
      payload => {
        try { const value = JSON.parse(outputText(payload)); return value?.ok === true && Object.keys(value).length === 1 }
        catch { return false }
      })
    generation.structured = 'passed'
  }
  return { ...result, generation }
}

function outputText(payload) {
  return (payload.output ?? []).flatMap(item => item.type === 'message' ? item.content ?? [] : [])
    .filter(item => item.type === 'output_text').map(item => item.text ?? '').join('')
}

function argumentsFor(args) {
  const options = {}
  const flags = { '--base-url': 'baseURL', '--model': 'model', '--generate': 'generate', '--tools': 'tools', '--structured': 'structured', '--allow-http': 'allowHTTP', '--help': 'help' }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined
    if (!key || Object.hasOwn(options, key)) throw new ProbeError('Invalid command-line arguments. Use --help.')
    const value = key === 'baseURL' || key === 'model' ? args[++index] : true
    if ((typeof value === 'string' && value.startsWith('--')) || value === undefined) throw new ProbeError('A command-line option value is missing. Use --help.')
    options[key] = value
  }
  if (!options.help && ((options.generate && !options.model) || (options.model && !options.generate) || ((options.tools || options.structured) && !options.generate))) {
    throw new ProbeError('Use --generate together with an explicit --model ID.')
  }
  return options
}

export async function runCLI(args, env = process.env, io = console) {
  try {
    const { help, ...options } = argumentsFor(args)
    if (help) { io.log(HELP); return 0 }
    if (options.generate) io.error('Generation probes send up to ' + (2 + (options.tools ? 2 : 0) + (options.structured ? 1 : 0)) + ' billable requests.')
    const result = await probeRelay({ ...options, baseURL: options.baseURL ?? env.TET_BASE_URL, key: env.TET_API_KEY })
    io.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    io.error(error instanceof ProbeError ? error.message : 'TET relay probe failed.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCLI(process.argv.slice(2))
}
