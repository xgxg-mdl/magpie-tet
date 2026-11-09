import type { Modality, Protocol, ReasoningLevel } from '../protocols.ts'

/** 模型容量，单位为 Token；显式配置要求正安全整数，宿主默认零值表示未知。 */
export interface ModelLimit {
  /** 总上下文容量，不小于 input 与 output。 */
  context: number
  /** 单次最大输出容量。 */
  output: number
  /** 单次最大输入容量；缺失时该容量对象不声明独立输入上限。 */
  input?: number
}

/** 对实际目录模型的显式覆盖；未填写字段保留宿主信息或使用保守默认。 */
export interface ModelOverride {
  /** 非空模型展示名称。 */
  name?: string
  /** 明确声明的容量对象，整体替换宿主容量，不逐字段合并。 */
  limit?: ModelLimit
  /** 是否支持采样温度参数，不代表温度的具体取值。 */
  temperature?: boolean
  /** 是否支持推理；false 时不提供推理变体。 */
  reasoning?: boolean
  /** 是否支持工具调用。 */
  toolCall?: boolean
  /** 图片输入声明；modalities.input 存在时以后者为准。 */
  imageInput?: boolean
  /** 推理档位列表；在没有显式关闭推理时可启用推理能力。 */
  reasoningLevels?: ReasoningLevel[]
  /** 调用协议，优先于宿主适配器与站点默认协议。 */
  protocol?: Protocol
  /** 按方向完整替换模态声明，空数组表示该方向不声明任何模态。 */
  modalities?: {
    /** 支持的输入模态；缺失时保留宿主声明。 */
    input?: Modality[]
    /** 支持的输出模态；缺失时保留宿主声明。 */
    output?: Modality[]
  }
}

/** 完成校验与默认值填充的插件配置，初始化后只动态读取流量开关。 */
export interface Settings {
  /** 包级网关地址回退；undefined 表示必须由账号提供。 */
  baseURL: string | undefined
  /** 无显式模型协议或已知宿主适配器时采用的协议。 */
  defaultProtocol: Protocol
  /** 查询超时，单位毫秒，范围 1000–60000；不限制生成时长。 */
  queryTimeoutMs: number
  /** 按原始模型标识排除的目录项。 */
  excludeModels: string[]
  /** 以原始模型标识索引的已校验覆盖，不创建目录外模型。 */
  modelOverrides: Record<string, ModelOverride>
  /** 流量统计初始开关；宿主提供布尔值时使用宿主值。 */
  showTraffic: boolean
}
