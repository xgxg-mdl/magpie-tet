/** 模型目录中通过标识校验的基础信息，不包含能力或容量推断。 */
export interface CatalogModel {
  /** 服务端原始模型标识；保留大小写及内容，调用时按此值寻址。 */
  id: string
  /** 服务端展示名称；缺失或非字符串时不提供。 */
  displayName?: string
  /** 服务端名称，供展示名称缺失时回退。 */
  name?: string
}

/** 单页模型目录及服务端提供的后续页线索。 */
export interface CatalogPage {
  /** 本页具有非空字符串标识的模型。 */
  models: CatalogModel[]
  /** 非空的下一页地址候选；读取下一页前仍须校验目标端点。 */
  next?: string
  /** 服务端是否明确声明尚有后续数据。 */
  hasMore: boolean
  /** 游标分页的末项标识；仅在没有 next 且 hasMore 时必需。 */
  lastID?: string
}

/** 一项真实金额限额；与钱包余额独立，不表示可相加的账户资源。 */
export interface Allowance {
  /** 限额来自密钥总额、密钥周期还是订阅周期。 */
  kind: 'key-quota' | 'rate' | 'subscription'
  /** 周期标识；密钥总额为空串，订阅为 daily/weekly/monthly。 */
  period: string
  /** 大于零的有限金额上限，单位取所在用量对象的 unit，保留原精度。 */
  limit: number
  /** 非负有限消费金额；缺失表示用量未知，不能补零。 */
  used?: number
  /** 服务端提供的可解析日期字符串；缺失时不推算重置时间。 */
  resetsAt?: string
}

/** 一个统计周期的消费及可选流量，均不作为路由限额。 */
export interface UsageStats {
  /** 有限消费金额，单位取所在用量对象的 unit；允许负数调整。 */
  cost: number
  /** 服务端返回的有限请求数；缺失时不展示。 */
  requests?: number
  /** 服务端返回的有限 Token 数；缺失时不展示。 */
  tokens?: number
}

/** 已解析网关用量；密钥失效与有效账号的额度状态分别表达。 */
export type GatewayUsage =
  | {
      /** 网关明确报告密钥无效。 */
      kind: 'invalid-key'
    }
  | {
      /** 网关接受该密钥；额度仍可能到期或耗尽。 */
      kind: 'valid'
      /** 账户方案名称，缺失时采用 TET。 */
      plan: string
      /** 金额单位，服务端缺失时采用 USD。 */
      unit: string
      /** 有限钱包余额；缺失表示未报告，不等同于零。 */
      wallet?: number
      /** 密钥或有效订阅的实际限额，不含钱包及共享上游额度。 */
      allowances: Allowance[]
      /** 密钥与当前订阅中较早的有效到期日期字符串。 */
      expiresAt?: string
      /** 密钥额度模式下服务端明确报告的不可用状态。 */
      quotaStatus?: 'expired' | 'quota-exhausted'
      /** 非密钥额度模式中，钱包与有效订阅均未报告。 */
      missingAccountUsage: boolean
      /** 独立的消费与实时速率统计，缺失项不补零。 */
      stats: {
        /** 今日消费和流量。 */
        today?: UsageStats
        /** 累计消费和流量。 */
        total?: UsageStats
        /** 服务端返回的有限每分钟请求速率。 */
        rpm?: number
        /** 服务端返回的有限每分钟 Token 速率。 */
        tpm?: number
      }
    }
