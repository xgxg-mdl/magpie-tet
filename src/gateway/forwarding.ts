import { apiBase } from '../config/address.ts'
import type { GatewayAccess } from '../auth/types.ts'
import { requestProtocol } from '../protocols.ts'

/**
 * 向已确认网关转发模型请求，按协议注入当前账号 Key 并保留正文、流和取消信号。
 * @param input 原始请求或目标 URL，必须位于网关前缀内的受支持生成端点。
 * @param init Fetch 覆盖选项；认证及重定向设置由转发器接管。
 * @param getAccess 发送前读取当前网关访问凭据，支持同站点 Key 替换。
 * @param baseURL 创建 loader 时确认的网关 API 地址。
 * @returns 原始 Fetch Response，不解析或改写生成内容。
 * @throws 端点越界、账号网关已变化或 Fetch 失败时抛出错误；不自动重试。
 */
export async function forward(
  input: string | URL | Request,
  init: RequestInit | undefined,
  getAccess: () => GatewayAccess | Promise<GatewayAccess>,
  baseURL: string,
): Promise<Response> {
  baseURL = apiBase(baseURL)
  const url = new URL(input instanceof Request ? input.url : input)
  const base = new URL(baseURL)
  const prefix = base.pathname.replace(/\/+$/, '')
  const protocol = url.pathname.startsWith(prefix + '/')
    ? requestProtocol(url.pathname.slice(prefix.length))
    : undefined
  if (url.origin !== base.origin || url.username || url.password || url.hash || !protocol) {
    throw new Error('TET refused a request outside its supported model APIs.')
  }
  const access = await getAccess()
  if (apiBase(access.baseURL) !== baseURL) throw new Error('TET account URL changed. Reload the request.')
  const key = access.apiKey
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-goog-api-key', 'host'])
    headers.delete(name)
  if (protocol === 'anthropic-messages') headers.set('x-api-key', key)
  else if (protocol === 'google-generative-ai') headers.set('x-goog-api-key', key)
  else headers.set('authorization', 'Bearer ' + key)
  /** 保留原始正文、取消信号和 Response 流，不擅自改写 store、工具调用或推理参数。 */
  return fetch(input, { ...init, headers, redirect: 'error' })
}
