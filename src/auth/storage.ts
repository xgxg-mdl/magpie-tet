import { apiBase, codePlaneBase } from '../config/address.ts'
import { finite, record } from '../validation.ts'
import type { Account, ApiKeyAccount, CodePlaneAccount, CodePlaneLogin } from './types.ts'

/** API Key 登录项在宿主认证存储中的形状。 */
export interface StoredApiAuth {
  /** 宿主 API Key 认证类型。 */
  type: 'api'
  /** 网关密钥，编码时从账号访问配置取得。 */
  key: string
  /** 登录项专属配置。 */
  metadata: {
    /** 规范化网关 API 基地址。 */
    baseURL: string
  }
}

/** CodePlane 登录项的宿主存储形状；会话字段使用宿主原生位置。 */
export interface StoredCodePlaneAuth {
  /** 宿主会调度 refresh 的认证类型。 */
  type: 'oauth'
  /** 模型请求使用的网关密钥，与 access 分开保存。 */
  key: string
  /** CodePlane 会话令牌。 */
  access: string
  /** 会话到期的 Unix 毫秒时间。 */
  expires: number
  /** 与 uid 相同的稳定身份键，不是服务端 refresh token。 */
  refresh: string
  /** 64 位十六进制账号身份键。 */
  uid: string
  /** 宿主显示的账号标签，默认使用登录名。 */
  accountId: string
  /** 两套服务各自的地址及 CodePlane 恢复凭据。 */
  metadata: {
    /** 模型请求使用的网关 API 基地址。 */
    baseURL: string
    /** CodePlane 站点与恢复身份信息；不重复保存令牌和有效期。 */
    codePlane: {
      /** CodePlane 站点基地址。 */
      baseURL: string
      /** 服务端用户标识的字符串形式。 */
      userId: string
      /** 已规范化登录名。 */
      username: string
      /** 自动恢复会话使用的密码。 */
      password: string
    }
  }
}

/** 宿主可持久化的两种认证形状。 */
export type StoredAuth = StoredApiAuth | StoredCodePlaneAuth

const invalidAuth = (): Error =>
  Object.assign(new Error('Sign in with a TET API key or CodePlane account.'), { signIn: 'expired' })

/**
 * 将宿主认证解码为完整内部账号，校验凭据、身份字段及服务地址。
 * @param raw 宿主提供的未校验认证数据。
 * @param fallbackBase 账号未提供网关地址时使用的包级地址。
 * @returns 可直接交给网关或会话模块使用的账号；到期会话保留以供恢复。
 * @throws 认证字段、存储格式或地址无效时抛出安全错误；失效认证带 signIn 标记。
 */
export function decodeAuth(raw: unknown, fallbackBase?: string): Account {
  if (!record(raw) || (raw.type !== 'api' && raw.type !== 'oauth') || typeof raw.key !== 'string' || !raw.key.trim())
    throw invalidAuth()
  if (/[\r\n]/.test(raw.key)) throw new Error('Invalid TET API key format.')
  const metadata = record(raw.metadata) ? raw.metadata : {}
  if ('management' in metadata) throw Object.assign(new Error('认证格式已更新，请重新登录 TET'), { signIn: 'expired' })
  const gateway = { baseURL: apiBase(metadata.baseURL ?? fallbackBase), apiKey: raw.key.trim() }
  if (raw.type === 'api') return { kind: 'api-key', gateway }
  const session = metadata.codePlane
  if (
    !record(session) ||
    typeof raw.access !== 'string' ||
    !raw.access ||
    /\s/.test(raw.access) ||
    !finite(raw.expires) ||
    raw.expires <= 0 ||
    typeof raw.uid !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.uid) ||
    raw.refresh !== raw.uid ||
    typeof session.userId !== 'string' ||
    !session.userId.trim() ||
    typeof session.username !== 'string' ||
    !session.username.trim() ||
    typeof session.password !== 'string' ||
    !session.password
  )
    throw invalidAuth()
  return {
    kind: 'codeplane',
    gateway,
    uid: raw.uid,
    session: {
      baseURL: codePlaneBase(session.baseURL),
      token: raw.access,
      expiresAt: raw.expires,
      userId: session.userId,
      username: session.username.trim(),
      password: session.password,
    },
  }
}

/**
 * 编码仅网关账号，不继承其他认证的会话或标签。
 * @param account 已校验的 API Key 账号。
 * @param previous 宿主原认证快照；此重载不使用它。
 * @returns 可持久化的 API Key 认证。
 */
export function encodeAuth(account: ApiKeyAccount, previous?: unknown): StoredApiAuth
/**
 * 编码 CodePlane 账号，同身份的有效宿主标签原样保留。
 * @param account 已校验的 CodePlane 账号。
 * @param previous 持久化前的宿主认证快照，用于保留同 UID 的自定义标签。
 * @returns 使用宿主原生会话字段的认证数据。
 */
export function encodeAuth(account: CodePlaneAccount, previous?: unknown): StoredCodePlaneAuth
/**
 * 按账号类型生成认证存储形状，不执行写入。
 * @param account 已校验的内部账号。
 * @param previous 可选宿主认证快照，仅同身份标签可继承。
 * @returns 与账号类型对应的认证数据。
 */
export function encodeAuth(account: Account, previous?: unknown): StoredAuth
/** 将内部账号序列化为宿主认证数据，实际保存由调用方负责。 */
export function encodeAuth(account: Account, previous?: unknown): StoredAuth {
  const metadata = { baseURL: account.gateway.baseURL }
  if (account.kind === 'api-key') return { type: 'api', key: account.gateway.apiKey, metadata }
  const session = account.session
  const accountId =
    record(previous) &&
    previous.uid === account.uid &&
    typeof previous.accountId === 'string' &&
    previous.accountId.trim()
      ? previous.accountId
      : session.username
  return {
    type: 'oauth',
    key: account.gateway.apiKey,
    access: session.token,
    expires: session.expiresAt,
    refresh: account.uid,
    uid: account.uid,
    accountId,
    metadata: {
      ...metadata,
      codePlane: {
        baseURL: session.baseURL,
        userId: session.userId,
        username: session.username,
        password: session.password,
      },
    },
  }
}

/**
 * 校验登录输入，并规范化站点、显式网关地址及登录名。
 * @param raw 宿主收集的未校验输入。
 * @returns 可用于登录请求的输入；空网关地址按未提供处理。
 * @throws 地址无效或账号、密码缺失时抛出安全错误。
 */
export function decodeLogin(raw: unknown): CodePlaneLogin {
  if (!record(raw)) throw new Error('请填写 TET CodePlane 账号和密码')
  const codePlaneURL = codePlaneBase(raw.codePlaneURL)
  if (typeof raw.username !== 'string' || !raw.username.trim() || typeof raw.password !== 'string' || !raw.password)
    throw new Error('请填写 TET CodePlane 账号和密码')
  return {
    codePlaneURL,
    username: raw.username.trim(),
    password: raw.password,
    ...(raw.baseURL === undefined || raw.baseURL === '' ? {} : { baseURL: apiBase(raw.baseURL) }),
  }
}
