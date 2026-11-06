import { TetPlugin } from '../../index.mjs'
import { apiBase, PROVIDER } from '../../src/config.mjs'
import { ProbeError, failure, generationProbe, completed, outputText } from './response-reader.mjs'

/** 通过插件公开钩子核对，不绕过账号地址与凭据隔离；生成必须单独显式开启。 */
export async function probeRelay({
  baseURL,
  key,
  model,
  generate = false,
  allowHTTP = false,
  tools = false,
  structured = false,
  timeoutMs = 15000,
} = {}) {
  if ([generate, allowHTTP, tools, structured].some(value => typeof value !== 'boolean'))
    throw new ProbeError('Probe switches must be boolean.')
  if ((tools || structured) && !generate) throw new ProbeError('Capability checks require --generate and --model.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    throw new ProbeError('Probe timeout must be between 1000 and 60000 ms.')
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
    throw new ProbeError('A valid TET_API_KEY is required.')
  if (generate && (typeof model !== 'string' || !model))
    throw new ProbeError('An explicit model ID is required for generation.')
  let base
  try {
    base = apiBase(baseURL)
  } catch {
    throw new ProbeError('A valid API base URL is required, including its API path prefix.')
  }
  if (new URL(base).protocol === 'http:' && !allowHTTP)
    throw new ProbeError('HTTP credentials require explicit --allow-http consent.')
  const plugin = await TetPlugin({}, { queryTimeoutMs: timeoutMs })
  const login = await plugin.auth.methods.find(method => method.type === 'api').authorize({ baseURL: base })
  const auth = { type: 'api', key, metadata: login.metadata }
  const config = {}
  await plugin.config(config)
  let models
  try {
    models = await plugin.provider.models(config.provider[PROVIDER], { auth })
  } catch (error) {
    throw failure('TET plugin model discovery failed', error)
  }
  const pluginModels = Object.keys(models).sort()
  if (!pluginModels.length) throw new ProbeError('TET has no plugin-supported models.')
  const usage = await plugin.auth.usage(async () => auth)
  if (usage.error || !Array.isArray(usage.windows))
    throw failure('TET plugin usage probe failed', usage.signIn ? { ...usage, category: 'authentication' } : usage)
  const result = { pluginModels, usage: { ok: true, windows: usage.windows.length }, generation: 'skipped' }
  if (!generate) return result
  if (!Object.hasOwn(models, model)) throw new ProbeError('The requested model is not in the plugin-supported catalog.')
  const loader = await plugin.auth.loader(async () => auth)
  await generationProbe(loader, model, false, timeoutMs)
  await generationProbe(loader, model, true, timeoutMs)
  const generation = { responses: 'passed', sse: 'passed' }
  if (tools) {
    const tool = {
      type: 'function',
      name: 'report_number',
      description: 'Report the supplied number.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        additionalProperties: false,
      },
    }
    const input = [{ role: 'user', content: 'Call report_number with value 7. After the result, reply OK.' }]
    const called = await generationProbe(
      loader,
      model,
      false,
      timeoutMs,
      { input, tools: [tool], tool_choice: { type: 'function', name: tool.name } },
      payload => {
        const calls = Array.isArray(payload.output) ? payload.output.filter(item => item?.type === 'function_call') : []
        if (calls.length !== 1) return false
        try {
          const args = JSON.parse(calls[0].arguments)
          return (
            calls[0].name === tool.name &&
            typeof calls[0].call_id === 'string' &&
            !!calls[0].call_id &&
            args !== null &&
            typeof args === 'object' &&
            !Array.isArray(args) &&
            Object.keys(args).length === 1 &&
            Object.hasOwn(args, 'value') &&
            Number.isInteger(args.value) &&
            args.value === 7
          )
        } catch {
          return false
        }
      },
    )
    const call = called.output.find(item => item.type === 'function_call')
    /** 显式传回完整历史，不借助当前账号不支持的服务端会话。 */
    await generationProbe(
      loader,
      model,
      false,
      timeoutMs,
      {
        tools: [tool],
        tool_choice: 'none',
        input: [
          ...input,
          ...called.output,
          { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' },
        ],
      },
      payload => completed(payload) && outputText(payload).trim() === 'OK',
    )
    generation.tools = 'passed'
  }
  if (structured) {
    await generationProbe(
      loader,
      model,
      false,
      timeoutMs,
      {
        input: 'Return an object with ok equal to true.',
        text: {
          format: {
            type: 'json_schema',
            name: 'probe',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      },
      payload => {
        try {
          const value = JSON.parse(outputText(payload))
          return value?.ok === true && Object.keys(value).length === 1
        } catch {
          return false
        }
      },
    )
    generation.structured = 'passed'
  }
  return { ...result, generation }
}
