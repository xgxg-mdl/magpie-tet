import { DEFAULT_PROTOCOL, MODALITIES, REASONING_LEVELS, isProtocol } from '../protocols.ts'
import type { Modality, ReasoningLevel } from '../protocols.ts'
import { finite, record } from '../validation.ts'
import type { ModelLimit, ModelOverride, Settings } from './types.ts'
import { apiBase } from './address.ts'

/** 配置与账号共用的网关地址规范化入口。 */
export { apiBase } from './address.ts'

/** 宿主注册、认证保存与模型寻址共用的供应商标识。 */
export const PROVIDER = 'tet'
/** 宿主供应商的默认展示名称。 */
export const NAME = 'TET'

function modelLimit(value: unknown): ModelLimit {
  if (
    !record(value) ||
    !finite(value.context) ||
    !Number.isSafeInteger(value.context) ||
    value.context <= 0 ||
    !finite(value.output) ||
    !Number.isSafeInteger(value.output) ||
    value.output <= 0 ||
    value.output > value.context ||
    (value.input !== undefined &&
      (!finite(value.input) || !Number.isSafeInteger(value.input) || value.input <= 0 || value.input > value.context))
  ) {
    throw new Error('Model limits must be positive integers within the context window.')
  }
  return {
    context: value.context,
    output: value.output,
    ...(typeof value.input === 'number' ? { input: value.input } : {}),
  }
}

function modelOverride(value: unknown, id: string): ModelOverride {
  const allowed = [
    'name',
    'limit',
    'temperature',
    'reasoning',
    'toolCall',
    'imageInput',
    'reasoningLevels',
    'protocol',
    'modalities',
  ]
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Unsupported model override for ' + id)
  }
  const checked: ModelOverride = {}
  if ('protocol' in value) {
    if (!isProtocol(value.protocol)) throw new Error('Unsupported model protocol.')
    checked.protocol = value.protocol
  }
  if ('modalities' in value) {
    if (!record(value.modalities) || Object.keys(value.modalities).some(key => !['input', 'output'].includes(key))) {
      throw new Error('Invalid model modalities.')
    }
    checked.modalities = {}
    for (const direction of ['input', 'output'] as const) {
      if (!(direction in value.modalities)) continue
      const kinds: unknown = value.modalities[direction]
      if (
        !Array.isArray(kinds) ||
        !kinds.every((kind: unknown): kind is Modality => MODALITIES.some(item => item === kind))
      ) {
        throw new Error('Invalid model modalities.')
      }
      checked.modalities[direction] = [...new Set(kinds)]
    }
  }
  for (const key of ['temperature', 'reasoning', 'toolCall', 'imageInput'] as const) {
    if (!(key in value)) continue
    const flag = value[key]
    if (typeof flag !== 'boolean') throw new Error(key + ' must be boolean.')
    checked[key] = flag
  }
  if ('name' in value) {
    if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Model name cannot be empty.')
    checked.name = value.name
  }
  if ('reasoningLevels' in value) {
    const levels: unknown = value.reasoningLevels
    if (
      !Array.isArray(levels) ||
      !levels.every((level: unknown): level is ReasoningLevel => REASONING_LEVELS.some(item => item === level))
    ) {
      throw new Error('Invalid reasoning levels.')
    }
    checked.reasoningLevels = [...levels]
  }
  // modelLimits 可补齐显式空值；合并后再拒绝没有回退的空 limit。
  if ('limit' in value && value.limit != null) checked.limit = modelLimit(value.limit)
  return checked
}

/**
 * 校验插件外部配置，复制可变集合并补齐内部所需默认值。
 * @param value 插件包 options；省略时使用默认值，非对象不接受。
 * @returns 完整配置；模型覆盖中的 limit 优先于 modelLimits，地址仍可由账号覆盖。
 * @throws 地址、协议、超时、模型覆盖、容量或流量开关不满足约束时抛出错误。
 */
export function settings(value: unknown = {}): Settings {
  if (!record(value)) throw new Error('TET options must be an object.')
  const baseURL = value.baseURL === undefined ? undefined : apiBase(value.baseURL)
  const defaultProtocol = value.defaultProtocol ?? DEFAULT_PROTOCOL
  if (!isProtocol(defaultProtocol)) throw new Error('Unsupported default protocol.')
  const queryTimeoutMs = value.queryTimeoutMs ?? 15000
  if (!finite(queryTimeoutMs) || !Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1000 || queryTimeoutMs > 60000) {
    throw new Error('queryTimeoutMs must be an integer between 1000 and 60000.')
  }
  const excludeModels: unknown = value.excludeModels ?? []
  if (
    !Array.isArray(excludeModels) ||
    !excludeModels.every((id: unknown): id is string => typeof id === 'string' && !!id)
  ) {
    throw new Error('excludeModels must contain model IDs.')
  }
  const modelOverrides = value.modelOverrides ?? {}
  const modelLimits = value.modelLimits ?? {}
  if (!record(modelOverrides) || !record(modelLimits)) throw new Error('Model settings must be objects.')
  const overrides: Record<string, ModelOverride> = Object.create(null)
  for (const [id, override] of Object.entries(modelOverrides)) overrides[id] = modelOverride(override, id)
  for (const [id, limit] of Object.entries(modelLimits)) {
    const override = overrides[id] ?? {}
    overrides[id] = { ...override, limit: override.limit ?? modelLimit(limit) }
  }
  for (const [id, override] of Object.entries(modelOverrides)) {
    if (record(override) && 'limit' in override && overrides[id]?.limit === undefined) modelLimit(override.limit)
  }
  const showTraffic = value.showTraffic ?? true
  if (typeof showTraffic !== 'boolean') throw new Error('showTraffic must be boolean.')
  return {
    baseURL,
    defaultProtocol,
    queryTimeoutMs,
    excludeModels: [...excludeModels],
    modelOverrides: overrides,
    showTraffic,
  }
}
