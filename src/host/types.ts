import type { ModelMetadata } from './model-types.ts'
import type { StoredCodePlaneAuth } from '../auth/storage.ts'
import type { DiagnosticDetails } from '../errors.ts'

/** 在当前宿主账号作用域读取认证；每次调用可得到更新后的数据或空值。 */
export type AuthReader = () => unknown | Promise<unknown>

/** 宿主用量窗口；数值字段表达真实限额或百分比，display 表达文本，aside 标记辅助用途。 */
export interface UsageWindow {
  /** 指标名称；宿主可按名称翻译并关联历史。 */
  name: string
  /** 纯展示文本，不作为真实用量或额度参与计算。 */
  display?: string | undefined
  /** 已使用百分比，允许超过 100；null 或缺失表示没有可用百分比。 */
  used?: number | null | undefined
  /** 已用数量，保持上游原始精度，和 limit 使用同一单位。 */
  amount?: number | undefined
  /** 真实额度上限；纯展示或未知额度不提供该字段。 */
  limit?: number | undefined
  /** amount、limit 或失效数量的单位，例如 USD、次。 */
  unit?: string | undefined
  /** 周期长度，单位为秒；不从无效截止时间推算周期。 */
  span?: number | undefined
  /** 周期重置时间，使用可解析的日期字符串。 */
  resetsAt?: string | undefined
  /** true 表示辅助展示，不作为当前 Key 的路由额度；缺失采用宿主默认行为。 */
  aside?: boolean | undefined
  /** 最近一批可用数量失效的时间，使用日期字符串。 */
  runsOutAt?: string | undefined
  /** 在 runsOutAt 失效的数量，不能大于当前可用数量。 */
  runsOut?: number | undefined
}

/** 返回宿主的一轮用量快照；辅助额度故障可与正常钱包并存。 */
export interface UsageResult extends DiagnosticDetails {
  /** 按宿主显示顺序排列的窗口；失败时可以为空。 */
  windows: UsageWindow[]
  /** 账号方案名称，不混入分组来源。 */
  plan?: string
  /** 格式化后的原生钱包余额，不与其他额度相加。 */
  balance?: string
  /** 当前 Key 或订阅中较早的有效截止时间。 */
  until?: string
  /** 可供用户显示的固定安全错误文本。 */
  error?: string
  /** 宿主登录状态提示，例如 expired；辅助 CodePlane 故障不设置此字段。 */
  signIn?: string
}

/** 宿主已有模型的输入契约，按实际使用字段保留元数据。 */
export type HostModel = ModelMetadata

/** 模型发现钩子收到的供应商快照。 */
export interface HostProvider {
  /** 宿主已有模型，以真实模型 ID 索引。 */
  models?: Record<string, HostModel>
  /** 宿主附带的其他信息，模型映射不依赖这些字段。 */
  [key: string]: unknown
}

/** 插件装配所使用的宿主能力；可选能力在调用时检查。 */
export interface HostInput {
  /** Magpie 的动态供应商选项读取能力。 */
  magpie?: {
    /** 读取供应商开关；未设置时返回空值，由插件使用配置默认值。 */
    option?: (provider: string, key: string) => unknown
  }
  /** 宿主客户端，认证写入受当前账号作用域约束。 */
  client?: {
    /** 认证持久化能力。 */
    auth?: {
      /** 保存完整认证快照；失败时拒绝 Promise，不代表其他账号已保存。 */
      set?: (request: {
        /** 当前供应商路由。 */
        path: {
          /** 供应商 ID。 */
          id: string
        }
        /** 经认证编码器生成的完整存储数据。 */
        body: unknown
      }) => Promise<unknown>
    }
  }
}

/** 可由插件补充的宿主配置；已有供应商配置不会被覆盖。 */
export interface HostConfig {
  /** 以供应商 ID 索引的配置。 */
  provider?: Record<
    string,
    {
      /** 供应商展示名称。 */
      name: string
      /** 默认协议对应的 AI SDK 包名。 */
      npm?: string
      /** 包级网关 API 地址。 */
      api?: string
      /** 初始模型元数据，以模型 ID 索引。 */
      models?: Record<string, HostModel>
    }
  >
}

/** 宿主登录表单中的单个问题。 */
export interface Prompt {
  /** password 输入由宿主隐藏回显。 */
  type: 'text' | 'password'
  /** 登录输入对象中的字段名。 */
  key: string
  /** 向用户显示的问题。 */
  message: string
  /** 空输入时的提示示例。 */
  placeholder?: string
  /** 返回校验错误文本；undefined 表示该字段通过校验。 */
  validate?: (value: unknown) => string | undefined
}

/** API Key 登录成功时交给宿主的元数据，Key 本身由宿主采集。 */
export interface ApiAuthorization {
  /** 宿主约定的授权完成标记。 */
  type: 'success'
  /** 新登录的地址及需清除的 CodePlane 数据。 */
  metadata: {
    /** 校验并归一化后的网关 API 地址。 */
    baseURL: string
    /** 切换为 API Key 时移除当前登录项的 CodePlane 信息。 */
    codePlane: undefined
  }
}

/** CodePlane 登录结果，使用宿主 success 标记携带完整会话存储数据。 */
export type CodePlaneAuthorization = Omit<StoredCodePlaneAuth, 'type'> & {
  /** 宿主约定的授权完成标记，保存时转换为 oauth 认证。 */
  type: 'success'
}

/** 已完成远端认证、等待宿主回调保存的自动授权流程。 */
export interface AuthorizationFlow {
  /** 宿主直接调用 callback，无需用户打开浏览器。 */
  method: 'auto'
  /** 授权完成后的用户提示。 */
  instructions: string
  /** 返回可持久化的认证，不在此重复请求登录接口。 */
  callback: () => Promise<CodePlaneAuthorization>
}

/** 由宿主采集 Key、由插件校验地址的登录方式。 */
export interface ApiMethod {
  /** API Key 登录判别值。 */
  type: 'api'
  /** 登录方式展示名称。 */
  label: string
  /** Key 输入框的提示示例。 */
  placeholder: string
  /** 除 Key 外需要采集的字段。 */
  prompts: Prompt[]
  /** 校验输入并返回元数据；地址无效时拒绝 Promise。 */
  authorize: (inputs: Record<string, unknown>) => Promise<ApiAuthorization>
}

/** 借助宿主会话认证存储承载的 CodePlane 账号登录方式。 */
export interface OAuthMethod {
  /** 宿主会话认证判别值，不表示服务端采用浏览器 OAuth 流程。 */
  type: 'oauth'
  /** 登录方式展示名称。 */
  label: string
  /** 地址、账号、密码及可选网关地址问题。 */
  prompts: Prompt[]
  /** 先验证远端账号再返回流程；取消信号参与本次登录请求。 */
  authorize: (
    inputs: Record<string, unknown>,
    context?: {
      /** 宿主取消本次授权的信号。 */
      signal?: AbortSignal
    },
  ) => Promise<AuthorizationFlow>
}

/** 当前账号的模型访问能力；未登录时返回空对象。 */
export interface AuthLoader {
  /** loader 创建时确认的网关基地址。 */
  baseURL?: string
  /** 当前网关 Key，不能用 CodePlane 会话令牌替代。 */
  apiKey?: string
  /** 每次读取最新认证后透传请求；保留正文、流和取消信号，地址变化时拒绝。 */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** 插件向 Magpie 暴露的钩子集合，业务结果在此映射为宿主契约。 */
export interface PluginHooks {
  /** 补齐供应商默认配置，保留用户已有配置。 */
  config: (config: HostConfig) => Promise<void>
  /** 登录、会话恢复、模型访问及用量读取能力。 */
  auth: {
    /** 认证所属的供应商 ID。 */
    provider: string
    /** 内嵌图标 data URI。 */
    icon: string
    /** false 表示宿主可为该供应商保存多个独立登录项。 */
    single: boolean
    /** 宿主提前触发续期的时间，单位为毫秒。 */
    refreshLead: number
    /** 返回需保存的新会话；无需更新或非会话账号时返回 undefined。 */
    refresh: (auth: unknown) => Promise<StoredCodePlaneAuth | undefined>
    /** 宿主可动态修改的布尔供应商选项。 */
    options: {
      /** 选项持久化键。 */
      key: string
      /** 选项标题。 */
      label: string
      /** 选项用途说明。 */
      description: string
      /** 未由宿主设置时采用的初始值。 */
      default: boolean
    }[]
    /** 按宿主界面顺序排列的账号登录与 API Key 登录。 */
    methods: [OAuthMethod, ApiMethod]
    /** 基于当前账号创建访问器；每次实际请求仍重新读取认证。 */
    loader: (getAuth: AuthReader) => Promise<AuthLoader>
    /** 读取网关和可选共享额度，返回用量快照及安全诊断。 */
    usage: (getAuth: AuthReader) => Promise<UsageResult>
  }
  /** 供应商注册和账号模型发现能力。 */
  provider: {
    /** 注册到宿主的供应商 ID。 */
    id: string
    /** 合并账号目录与宿主元数据；无认证时返回空目录，查询失败时拒绝。 */
    models: (
      provider: HostProvider,
      context?: {
        /** 当前宿主账号的原始认证，由存储解析器校验。 */
        auth?: unknown
      },
    ) => Promise<Record<string, HostModel>>
  }
}
