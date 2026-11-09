/** 读数不可用的原因：缺失、降级、缓存过期、待重置时间、新周期待更新或请求失败。 */
export type UnavailableReason = 'missing' | 'degraded' | 'stale' | 'reset-pending' | 'expired' | 'request'

/** 不可用状态，不应转换为零用量或参与百分比历史。 */
export interface UnavailableReading {
  /** 不可用读数判别标记。 */
  kind: 'unavailable'
  /** 可映射为宿主状态文案的领域原因。 */
  reason: UnavailableReason
  /** 请求模块提供的安全错误文本，仅请求失败时通常存在。 */
  message?: string
}

/** 共享周期用量；百分比允许超过 100，不代表当前 Key 独占资源。 */
export type PeriodReading =
  | {
      /** 可用读数判别标记。 */
      kind: 'available'
      /** 非负有限百分比，以 100 表示全部用量。 */
      utilization: number
      /** 未来重置时间的 ISO 字符串；有效零值没有未来截止时间时为 null。 */
      resetsAt: string | null
    }
  | UnavailableReading

/** 当前可用重置次数及最早一批额度的到期信息。 */
export type ResetReading =
  | {
      /** 可用读数判别标记。 */
      kind: 'available'
      /** 非负安全整数，零表示明确没有可用重置次数。 */
      count: number
      /** 最近未来到期批次；没有有效未来到期记录时省略。 */
      expiration?: {
        /** 最近到期的 ISO 时间。 */
        at: string
        /** 该时间到期的次数，不超过当前可用次数。 */
        count: number
      }
    }
  | UnavailableReading

/** 分组并发快照；missing 表示接口未提供该项，不能推断为零或无限。 */
export type CapacityReading =
  | {
      /** 可用快照判别标记。 */
      kind: 'available'
      /** 当前并发占用的非负安全整数，允许超过上限。 */
      used: number
      /** 并发上限的正安全整数。 */
      limit: number
    }
  | {
      /** 上游没有提供并发字段。 */
      kind: 'missing'
    }
  | UnavailableReading

/** 一个上游账号的独立共享指标，各项失败互不遮蔽。 */
export interface QuotaReadings {
  /** 两个服务原生周期的读数。 */
  periods: {
    /** 五小时周期。 */
    fiveHour: PeriodReading
    /** 七天周期。 */
    sevenDay: PeriodReading
  }
  /** 可用重置次数，不与周期百分比合并。 */
  resets: ResetReading
}

/** 额度来源的稳定标识与可读名称。 */
export interface QuotaSource {
  /** 服务端上游账号 ID，用于额度请求和跨分组去重。 */
  id: number
  /** 已修剪名称；空字符串由展示模块生成回退标签。 */
  name: string
}

/** 带有本轮指标读数的上游账号。 */
export interface QuotaAccount extends QuotaSource {
  /** 该上游的归一化读数，不能与其他来源相加。 */
  readings: QuotaReadings
}

/** 当前账号可见分组及其关联上游的本轮快照。 */
export interface QuotaGroup {
  /** 正安全整数分组 ID；不同于额度查询使用的上游账号 ID。 */
  id: number
  /** 非空、已修剪的分组名称。 */
  name: string
  /** 关联上游账号，允许为空；同一来源可出现在其他分组中。 */
  accounts: QuotaAccount[]
  /** 整个分组的并发快照，不代表当前 Key 的独占并发。 */
  capacity: CapacityReading
}

/** 分组列表的已校验结果，尚未附加上游用量读数。 */
export interface ListedQuotaGroup extends Omit<QuotaGroup, 'accounts'> {
  /** 已按上游 ID 去重的关联来源。 */
  accounts: QuotaSource[]
}

/** 一轮共享额度读取结果；失败时不返回先前缓存的分组。 */
export type CodePlaneResult =
  | {
      /** 本轮完整分组快照，零可见分组时为空数组。 */
      groups: QuotaGroup[]
    }
  | {
      /** 可供宿主展示的安全错误文本。 */
      error: string
    }

/** 单个 CodePlane HTTP 请求的参数。 */
export interface RequestOptions {
  /** 当前会话 Bearer 令牌；公开登录端点不提供。 */
  token?: string | undefined
  /** JSON 请求体；提供时使用 POST，否则使用 GET。 */
  body?: Record<string, unknown> | undefined
  /** 单次请求超时，单位毫秒。 */
  timeoutMs: number
  /** 与单次超时组合的调用方取消信号，可代表整轮预算。 */
  signal?: AbortSignal | undefined
}

/** 已绑定认证站点的请求函数，返回经信封校验但尚未领域解析的数据。 */
export type CodePlaneQuery = (path: string, options: RequestOptions) => Promise<Record<string, unknown>>
