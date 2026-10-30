export const PROVIDER = 'tet'
export const NAME = 'TET'
export const SDK = '@ai-sdk/openai'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function apiBase(rawBase) {
  if (rawBase === undefined || rawBase === null || rawBase === '') {
    throw new Error('Configure an API base URL when signing in to TET.')
  }
  let base
  try {
    if (typeof rawBase !== 'string' || !/^https?:\/\//i.test(rawBase.trim())) throw new Error()
    base = new URL(rawBase.trim())
    if (base.username || base.password || base.search || base.hash) throw new Error()
  } catch { throw new Error('baseURL must be an HTTP(S) API base URL without credentials, query or fragment.') }
  /** 纯站点地址使用标准入口；显式路径保留，避免破坏代理前缀。 */
  if (!base.pathname.replace(/\/+$/, '')) base.pathname = '/v1'
  return base.href.replace(/\/+$/, '')
}

/** 账号地址优先，避免包配置将账号凭据发往其他服务。 */
export function accountBase(auth, options) {
  return apiBase(auth?.metadata?.baseURL ?? options.baseURL)
}

/** 地址只允许由专用选项设置，模型元数据不能改变凭据或请求去向。 */
export function settings(value = {}) {
  if (!record(value)) throw new Error('TET options must be an object.')
  const baseURL = value.baseURL === undefined ? undefined : apiBase(value.baseURL)
  const queryTimeoutMs = value.queryTimeoutMs ?? 15000
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1000 || queryTimeoutMs > 60000) {
    throw new Error('queryTimeoutMs must be an integer between 1000 and 60000.')
  }
  const excludeModels = value.excludeModels ?? []
  if (!Array.isArray(excludeModels) || excludeModels.some(id => typeof id !== 'string' || !id)) {
    throw new Error('excludeModels must contain model IDs.')
  }
  const modelOverrides = value.modelOverrides ?? {}
  const modelLimits = value.modelLimits ?? {}
  if (!record(modelOverrides) || !record(modelLimits)) throw new Error('Model settings must be objects.')
  const overrides = Object.assign(Object.create(null), Object.fromEntries(Object.entries(modelOverrides).map(([id, override]) => {
    if (!record(override) || Object.keys(override).some(key => !['name', 'limit', 'temperature', 'reasoning', 'toolCall', 'imageInput', 'reasoningLevels'].includes(key))) {
      throw new Error('Unsupported model override for ' + id)
    }
    const checked = { ...override }
    for (const key of ['temperature', 'reasoning', 'toolCall', 'imageInput']) {
      if (key in checked && typeof checked[key] !== 'boolean') throw new Error(key + ' must be boolean.')
    }
    if ('name' in checked && (typeof checked.name !== 'string' || !checked.name.trim())) throw new Error('Model name cannot be empty.')
    if ('reasoningLevels' in checked && (!Array.isArray(checked.reasoningLevels) || checked.reasoningLevels.some(level => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)))) {
      throw new Error('Invalid reasoning levels.')
    }
    if ('reasoningLevels' in checked) checked.reasoningLevels = [...checked.reasoningLevels]
    return [id, checked]
  })))
  for (const [id, limit] of Object.entries(modelLimits)) overrides[id] = { ...overrides[id], limit: overrides[id]?.limit ?? limit }
  for (const override of Object.values(overrides)) {
    if (!('limit' in override)) continue
    const limit = override.limit
    if (!record(limit) || !Number.isSafeInteger(limit.context) || limit.context <= 0 ||
      !Number.isSafeInteger(limit.output) || limit.output <= 0 || limit.output > limit.context ||
      (limit.input !== undefined && (!Number.isSafeInteger(limit.input) || limit.input <= 0 || limit.input > limit.context))) {
      throw new Error('Model limits must be positive integers within the context window.')
    }
    override.limit = { context: limit.context, output: limit.output, ...(limit.input === undefined ? {} : { input: limit.input }) }
  }
  const showTraffic = value.showTraffic ?? true
  if (typeof showTraffic !== 'boolean') throw new Error('showTraffic must be boolean.')
  return { baseURL, queryTimeoutMs, excludeModels: [...excludeModels], modelOverrides: overrides, showTraffic }
}
