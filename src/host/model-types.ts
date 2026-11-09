import type { ModelLimit } from '../config/types.ts'
import type { Modality } from '../protocols.ts'

/** 宿主已有或显式配置的模型能力；缺少字段表示没有该能力的声明。 */
export interface ModelCapabilities {
  /** 是否接受温度采样参数，不根据模型名称推断。 */
  temperature?: boolean
  /** 是否启用推理能力；明确的 false 会移除推理变体。 */
  reasoning?: boolean
  /** 是否支持函数工具调用。 */
  toolcall?: boolean
  /** 是否接受非文本附件输入。 */
  attachment?: boolean
  /** 各输入模态的声明；缺少模态键表示未知。 */
  input?: Partial<Record<Modality, boolean>>
  /** 各输出模态的声明；缺少模态键表示未知。 */
  output?: Partial<Record<Modality, boolean>>
}

/** 宿主 SDK 的变体参数；未知扩展字段原样保留，不由插件重新解释。 */
export type ModelVariant = Record<string, unknown>

/** 宿主按模型 ID 提供的可选元数据，缺失容量与能力不代表服务不支持。 */
export interface ModelMetadata {
  /** 宿主模型标识；目录映射时使用真实目录 ID。 */
  id?: string
  /** 供应商标识。 */
  providerID?: string
  /** 宿主记录的模型状态。 */
  status?: string
  /** 可读模型名称。 */
  name?: string
  /** 构造模型请求所需的宿主 SDK 元数据。 */
  api?: {
    /** 发送至上游的模型 ID。 */
    id?: string
    /** 网关 API 基地址；缺失时尚未指定账号地址。 */
    url?: string | undefined
    /** 宿主识别的 AI SDK 包名，决定请求协议。 */
    npm?: string
  }
  /** Token 容量；缺失时映射输出使用零值表示未知容量。 */
  limit?: ModelLimit
  /** 已有能力声明；配置只覆盖明确指定的字段。 */
  capabilities?: ModelCapabilities
  /** 以变体名称索引的 SDK 参数。 */
  variants?: Record<string, ModelVariant>
  /** 宿主已有的价格元数据，插件原样保留且不据此估算账单。 */
  cost?: {
    /** 宿主定义口径的输入价格。 */
    input?: number
    /** 宿主定义口径的输出价格。 */
    output?: number
    /** 宿主定义口径的缓存价格。 */
    cache?: {
      /** 缓存读取价格。 */
      read?: number
      /** 缓存写入价格。 */
      write?: number
    }
  }
}

/** 目录与配置合并后的完整宿主模型；仅包含目录中存在且未排除的模型。 */
export interface DiscoveredModel extends ModelMetadata {
  /** 真实目录模型 ID，不按品牌或名称重写。 */
  id: string
  /** 插件注册的供应商 ID。 */
  providerID: string
  /** 模型存在于本轮有效目录，不表示每项可选能力均已实测。 */
  status: 'active'
  /** 配置、目录或宿主元数据选出的名称。 */
  name: string
  /** 当前账号地址及选定协议的宿主 SDK 参数。 */
  api: {
    /** 发送至上游的模型 ID。 */
    id: string
    /** 归一化的网关基地址；未提供账号地址时为 undefined。 */
    url: string | undefined
    /** 选定调用协议对应的 SDK 包名。 */
    npm: string
  }
  /** Token 容量；context/output 为零时表示未知。 */
  limit: ModelLimit
  /** 完整顶层能力声明；输入输出模态仍可保留未知键。 */
  capabilities: Required<ModelCapabilities>
  /** 可用推理变体；推理禁用时为空对象。 */
  variants: Record<string, ModelVariant>
}
