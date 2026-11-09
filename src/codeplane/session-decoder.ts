import { apiBase } from '../config/address.ts'
import { finite, record } from '../validation.ts'

/** 服务端提供的可用网关配置候选；最终地址由账号输入优先选择。 */
export interface GatewayConfiguration {
  /** 格式有效的网关密钥；缺失、空白或包含空白字符时为 undefined。 */
  apiKey: string | undefined
  /** 已规范化的网关 API 地址；未提供或无效候选为 undefined。 */
  gatewayURL: string | undefined
}

/** 登录或会话查询响应的归一化信息，可供恢复流程判定是否明确续期。 */
export interface SessionInfo extends GatewayConfiguration {
  /** 非空且不含空白字符的会话令牌；不可用时为 undefined。 */
  token: string | undefined
  /** Unix 毫秒时间；undefined 表示未提供，null 表示显式无效，不能沿用旧有效期。 */
  expiresAt: number | null | undefined
  /** 有效用户 ID 的字符串形式；缺省由恢复流程使用已确认身份。 */
  userId: string | undefined
}

/** 已确认提供有效令牌的登录响应，其余字段仍由完整账号校验处理。 */
export interface SessionReply extends SessionInfo {
  /** 格式有效的 CodePlane 会话令牌。 */
  token: string
}

function credential(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !/\s/.test(value) ? value : undefined
}

function identity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new Error('TET CodePlane 登录数据异常')
}

function expiry(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (!finite(value)) return null
  const milliseconds = value * 1000
  return finite(milliseconds) ? milliseconds : null
}

function gatewayCandidate(value: unknown): string | undefined {
  if (!value) return undefined
  try {
    return apiBase(value)
  } catch {
    // 服务端地址只是候选，不能阻断显式覆盖或已确认地址的会话恢复。
    return undefined
  }
}

/**
 * 解析网关配置候选，保留可用密钥和地址而不泄漏其他响应字段。
 * @param raw 未校验的登录或网关配置响应。
 * @returns 可选密钥及地址；无效服务端地址不阻断显式地址覆盖。
 * @throws 响应不是对象时抛出安全错误。
 */
export function decodeGatewayConfiguration(raw: unknown): GatewayConfiguration {
  if (!record(raw)) throw new Error('TET CodePlane 账号登录数据不完整')
  const gateway = raw.codexGatewayUrl || raw.gatewayPublicBaseUrl
  return {
    apiKey: credential(raw.apiKey),
    gatewayURL: gatewayCandidate(gateway),
  }
}

/**
 * 解析会话查询信息，将服务端 Unix 秒转换为内部 Unix 毫秒。
 * @param raw 未校验的登录或会话查询响应。
 * @returns 可供续期判定的身份、令牌、有效期和网关候选。
 * @throws 响应不是对象或显式身份值格式无效时抛出安全错误。
 */
export function decodeSessionInfo(raw: unknown): SessionInfo {
  if (!record(raw)) throw new Error('TET CodePlane 登录数据异常')
  return {
    ...decodeGatewayConfiguration(raw),
    token: credential(raw.token),
    expiresAt: expiry(raw.tokenExpiresAt),
    userId: identity(raw.userId ?? (record(raw.user) ? raw.user.id : undefined) ?? raw.id),
  }
}

/**
 * 解析登录响应并要求服务端提供有效令牌。
 * @param raw 未校验登录响应。
 * @returns 含有效 token 的会话信息；用户、有效期和网关完整性由账号流程校验。
 * @throws 令牌缺失、格式无效或响应身份格式无效时抛出安全错误。
 */
export function decodeSessionReply(raw: unknown): SessionReply {
  const info = decodeSessionInfo(raw)
  if (!info.token) throw new Error('TET CodePlane 登录数据异常')
  return { ...info, token: info.token }
}
