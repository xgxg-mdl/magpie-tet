/**
 * 校验网关地址并去除尾斜杠，纯站点地址补齐 /v1。
 * @param rawBase 用户或服务端提供的地址候选。
 * @returns 不含凭据、查询参数或片段的 HTTP(S) API 地址，保留显式路径。
 * @throws 地址缺失、不是 HTTP(S) 或携带禁止组成部分时抛出固定错误。
 */
export function apiBase(rawBase: unknown): string {
  if (rawBase === undefined || rawBase === null || rawBase === '') {
    throw new Error('Configure an API base URL when signing in to TET.')
  }
  let base: URL
  try {
    if (typeof rawBase !== 'string' || !/^https?:\/\//i.test(rawBase.trim())) throw new Error()
    base = new URL(rawBase.trim())
    if (base.username || base.password || base.search || base.hash) throw new Error()
  } catch {
    throw new Error('baseURL must be an HTTP(S) API base URL without credentials, query or fragment.')
  }
  // 纯站点使用标准入口；显式路径保留代理前缀。
  if (!base.pathname.replace(/\/+$/, '')) base.pathname = '/v1'
  return base.href.replace(/\/+$/, '')
}

/**
 * 校验 CodePlane 地址并去除尾斜杠，不推断网关地址或添加 API 前缀。
 * @param value 用户提供的 CodePlane 站点地址。
 * @returns 不含凭据、查询参数或片段的 HTTP(S) 地址。
 * @throws 地址无效或含禁止组成部分时抛出固定错误。
 */
export function codePlaneBase(value: unknown): string {
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) throw new Error()
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new Error('TET CodePlane 地址须使用 HTTP(S)，且不含凭据、查询参数或片段')
  }
}
