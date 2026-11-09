/** 网关请求使用的地址与密钥；不包含 CodePlane 会话凭据。 */
export interface GatewayAccess {
  /** 已规范化的 HTTP(S) API 基地址，含实际 API 路径前缀。 */
  baseURL: string
  /** 当前账号的非空网关密钥，不得写入日志或展示结果。 */
  apiKey: string
}

/** 仅访问网关的账号，不读取 CodePlane 共享资源。 */
export interface ApiKeyAccount {
  /** 账号判别标记。 */
  kind: 'api-key'
  /** 该账号独立的网关访问配置。 */
  gateway: GatewayAccess
}

/** 同时具备网关访问和 CodePlane 自动恢复能力的完整账号。 */
export interface CodePlaneAccount {
  /** 账号判别标记。 */
  kind: 'codeplane'
  /** 模型请求与钱包查询使用的网关访问配置。 */
  gateway: GatewayAccess
  /** 读取共享资源及恢复登录所需的会话，不与网关密钥互换。 */
  session: {
    /** 独立于网关地址的 CodePlane 站点基地址，可包含部署路径前缀。 */
    baseURL: string
    /** 当前 CodePlane Bearer 令牌，不得暴露给模型端点。 */
    token: string
    /** 会话到期的 Unix 毫秒时间；允许已经到期，以便触发恢复。 */
    expiresAt: number
    /** 服务端用户标识的字符串形式，用于阻止恢复时切换身份。 */
    userId: string
    /** 已去除首尾空白的登录账号名。 */
    username: string
    /** 会话恢复使用的密码，保留原始内容且不得输出。 */
    password: string
  }
  /** CodePlane 站点与用户标识生成的 SHA-256 十六进制身份键。 */
  uid: string
}

/** 已校验账号；调用方通过 kind 决定是否可使用会话恢复。 */
export type Account = ApiKeyAccount | CodePlaneAccount

/** 已校验并规范化的 CodePlane 登录输入。 */
export interface CodePlaneLogin {
  /** CodePlane 认证站点地址。 */
  codePlaneURL: string
  /** 已去除首尾空白的非空登录名。 */
  username: string
  /** 非空密码；不做修剪，避免改变有效凭据。 */
  password: string
  /** 显式网关地址；缺省时使用服务端配置。 */
  baseURL?: string
}
