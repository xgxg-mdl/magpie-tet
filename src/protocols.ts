/** 插件允许配置及转发的调用协议名称，不包含宿主 SDK 包名。 */
export const PROTOCOL_NAMES = ['openai-responses', 'openai-chat', 'anthropic-messages', 'google-generative-ai'] as const
/** 受支持的模型调用协议。 */
export type Protocol = (typeof PROTOCOL_NAMES)[number]
/** 无显式覆盖或已知宿主适配器时采用的默认调用协议。 */
export const DEFAULT_PROTOCOL: Protocol = 'openai-responses'
/** 模型覆盖支持的输入输出模态集合。 */
export const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
/** 一种可声明的模型输入或输出模态。 */
export type Modality = (typeof MODALITIES)[number]
/** 可传递给宿主 SDK 的推理档位名称，不代表目录模型均支持这些档位。 */
export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
/** 显式模型配置可声明的单个推理档位。 */
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * 判断外部值是否为受支持的协议名称。
 * @param value 尚未校验的协议配置值。
 * @returns 匹配固定协议集合时为 true，并收窄类型。
 */
export function isProtocol(value: unknown): value is Protocol {
  return PROTOCOL_NAMES.some(protocol => protocol === value)
}

/**
 * 按网关相对端点识别调用协议，不依赖模型名称猜测。
 * @param path 去除账号 API 路径前缀后的请求 pathname，不含查询参数。
 * @returns 固定生成端点对应的协议；不支持的端点返回 undefined。
 */
export function requestProtocol(path: string): Protocol | undefined {
  if (['/responses', '/responses/compact'].includes(path)) return 'openai-responses'
  if (path === '/chat/completions') return 'openai-chat'
  if (path === '/messages') return 'anthropic-messages'
  if (/^\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) return 'google-generative-ai'
  return undefined
}
