import { pathToFileURL } from 'node:url'
import { TetPlugin } from '../index.mjs'
import { apiBase, PROVIDER } from '../src/config.mjs'

const MAX_BYTES = 4 * 1024 * 1024
const HELP = `Usage: bun run test:relay -- [options]

Read-only by default: verify the TET plugin model catalog and usage hooks.
TET_API_KEY supplies the credential; TET_BASE_URL supplies the API base URL.

  --base-url URL   Override TET_BASE_URL, including the API path prefix
  --allow-http     Permit sending credentials over unencrypted HTTP
  --generate      Send up to two billable Responses requests
  --model ID      Explicit plugin model ID required with --generate
  --help          Show this help without reading credentials or making requests

Only plugin-supported model IDs and probe status are printed.
`

class ProbeError extends Error {}

/** 即使合成响应没有实现 fetch 的取消约定，也不能让诊断无限等待。 */
async function abortable(task, signal) {
  let abort
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      abort = () => reject(new ProbeError('TET generation probe timed out.'))
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

async function generationProbe(loader, model, stream, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    const response = await abortable(loader.fetch(loader.baseURL + '/responses', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify({ model, input: 'Reply only with OK.', max_output_tokens: 128, stream }),
    }), controller.signal)
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => {}) } catch {}
      throw new ProbeError('TET Responses returned HTTP ' + response.status + '.')
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
    if (!completed(payload)) throw new ProbeError('TET Responses did not return a completed response.')
  } catch (error) {
    throw error instanceof ProbeError ? error : new ProbeError('TET generation request failed or timed out.')
  } finally {
    clearTimeout(timer)
    if (reader) {
      try { void reader.cancel().catch(() => {}) } catch {}
      reader.releaseLock()
    }
  }
}

/** 通过插件公开钩子核对，不绕过账号地址与凭据隔离；生成必须单独显式开启。 */
export async function probeRelay({ baseURL, key, model, generate = false, allowHTTP = false, timeoutMs = 15000 } = {}) {
  if (typeof generate !== 'boolean' || typeof allowHTTP !== 'boolean') throw new ProbeError('Probe switches must be boolean.')
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
  catch { throw new ProbeError('TET plugin model discovery failed. Check the API address and key.') }
  const pluginModels = Object.keys(models).sort()
  if (!pluginModels.length) throw new ProbeError('TET has no plugin-supported models.')
  const usage = await plugin.auth.usage(async () => auth)
  if (usage.error || !Array.isArray(usage.windows)) throw new ProbeError('TET plugin usage probe failed.')
  const result = { pluginModels, usage: { ok: true, windows: usage.windows.length }, generation: 'skipped' }
  if (!generate) return result
  if (!Object.hasOwn(models, model)) throw new ProbeError('The requested model is not in the plugin-supported catalog.')
  const loader = await plugin.auth.loader(async () => auth)
  await generationProbe(loader, model, false, timeoutMs)
  await generationProbe(loader, model, true, timeoutMs)
  return { ...result, generation: { responses: 'passed', sse: 'passed' } }
}

function argumentsFor(args) {
  const options = {}
  const flags = { '--base-url': 'baseURL', '--model': 'model', '--generate': 'generate', '--allow-http': 'allowHTTP', '--help': 'help' }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const key = Object.hasOwn(flags, flag) ? flags[flag] : undefined
    if (!key || Object.hasOwn(options, key)) throw new ProbeError('Invalid command-line arguments. Use --help.')
    const value = key === 'baseURL' || key === 'model' ? args[++index] : true
    if ((typeof value === 'string' && value.startsWith('--')) || value === undefined) throw new ProbeError('A command-line option value is missing. Use --help.')
    options[key] = value
  }
  if (!options.help && ((options.generate && !options.model) || (options.model && !options.generate))) {
    throw new ProbeError('Use --generate together with an explicit --model ID.')
  }
  return options
}

export async function runCLI(args, env = process.env, io = console) {
  try {
    const { help, ...options } = argumentsFor(args)
    if (help) { io.log(HELP); return 0 }
    if (options.generate) io.error('Generation probes send up to two billable requests.')
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
