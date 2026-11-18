import { PROVIDER } from '../config/index.ts'
import type { ModelOverride, Settings } from '../config/types.ts'
import type { CatalogModel } from '../gateway/types.ts'
import { DEFAULT_PROTOCOL, MODALITIES, PROTOCOL_NAMES, type Modality, type Protocol } from '../protocols.ts'
import type { DiscoveredModel, ModelMetadata } from './model-types.ts'

/** 固定调用协议与宿主 AI SDK 包的映射，不从远端目录加载任意 SDK。 */
export const PROTOCOLS = Object.freeze({
  'openai-responses': '@ai-sdk/openai',
  'openai-chat': '@ai-sdk/openai-compatible',
  'anthropic-messages': '@ai-sdk/anthropic',
  'google-generative-ai': '@ai-sdk/google',
} satisfies Record<Protocol, string>)

function modelProtocol(existing: ModelMetadata, override: ModelOverride, options: Settings): Protocol {
  return (
    override.protocol ??
    PROTOCOL_NAMES.find(protocol => PROTOCOLS[protocol] === existing.api?.npm) ??
    options.defaultProtocol ??
    DEFAULT_PROTOCOL
  )
}

/**
 * 将已解析目录与宿主元数据、显式配置合并为可注册模型。
 *
 * 网关档位优先于宿主元数据；仅声明 none 或双方都缺少推理信息时，由宿主匹配档位。
 * 显式配置可覆盖两者。
 * 未知模态不补成文本；禁用推理时清除推理变体，不发送能力探测请求。
 *
 * @param models 已校验的账号模型目录。
 * @param existingModels 宿主已有元数据，以真实模型 ID 索引。
 * @param options 已归一化的配置，包含当前账号的网关地址。
 * @returns 未被排除的目录模型；不存在于目录的覆盖项不会创建模型。
 */
export function discoverModels(
  models: CatalogModel[],
  existingModels: Record<string, ModelMetadata>,
  options: Settings,
): Record<string, DiscoveredModel> {
  const excluded = new Set(options.excludeModels)
  const entries: [string, DiscoveredModel][] = []
  for (const model of models) {
    if (excluded.has(model.id)) continue
    const existing: ModelMetadata = Object.hasOwn(existingModels, model.id) ? (existingModels[model.id] ?? {}) : {}
    const override: ModelOverride = Object.hasOwn(options.modelOverrides, model.id)
      ? (options.modelOverrides[model.id] ?? {})
      : {}
    const capabilities = existing.capabilities ?? {}
    const modalities = (direction: 'input' | 'output'): Partial<Record<Modality, boolean>> => {
      const kinds = override.modalities?.[direction]
      return kinds === undefined
        ? { ...capabilities[direction] }
        : Object.fromEntries(MODALITIES.map(kind => [kind, kinds.includes(kind)]))
    }
    const input = modalities('input')
    const output = modalities('output')
    if (override.imageInput !== undefined && override.modalities?.input === undefined) input.image = override.imageInput
    const gatewayLevels = model.reasoningLevels
    const reasoning = override.reasoning ?? (gatewayLevels ? true : (capabilities.reasoning ?? true))
    const levels =
      override.reasoningLevels ?? (gatewayLevels?.length === 1 && gatewayLevels[0] === 'none' ? [] : gatewayLevels)
    entries.push([
      model.id,
      {
        ...existing,
        id: model.id,
        providerID: PROVIDER,
        status: 'active',
        name: override.name ?? model.displayName ?? model.name ?? existing.name ?? model.id,
        api: { id: model.id, url: options.baseURL, npm: PROTOCOLS[modelProtocol(existing, override, options)] },
        limit: override.limit ?? existing.limit ?? { context: 0, output: 0 },
        capabilities: {
          ...capabilities,
          temperature: override.temperature ?? capabilities.temperature ?? false,
          reasoning,
          toolcall: override.toolCall ?? capabilities.toolcall ?? false,
          attachment:
            override.modalities?.input !== undefined || override.imageInput !== undefined
              ? MODALITIES.some(kind => kind !== 'text' && input[kind] === true)
              : (capabilities.attachment ?? MODALITIES.some(kind => kind !== 'text' && input[kind] === true)),
          input,
          output,
        },
        variants: !reasoning
          ? {}
          : levels
            ? Object.fromEntries(levels.map(level => [level, { reasoningEffort: level }]))
            : (existing.variants ?? {}),
      },
    ])
  }
  return Object.fromEntries(entries)
}
