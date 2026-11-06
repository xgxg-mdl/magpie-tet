const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function codePlaneBase(value) {
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) throw new Error()
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new Error('TET CodePlane 地址须使用 HTTP(S)，且不含凭据、查询参数或片段')
  }
}

/** TET CodePlane 会话与 API Key 分开传递；错误只使用固定文本，禁止透传响应正文。 */
export async function request(baseURL, path, { token, body, timeoutMs, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetch(baseURL + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: 'error',
    })
  } catch {
    throw new Error('TET CodePlane 查询超时或连接失败')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401)
      throw Object.assign(new Error(body ? 'TET CodePlane 账号或密码有误' : 'TET CodePlane 登录已过期'), {
        status: 401,
      })
    if (response.status === 403) throw new Error('无权查看此额度')
    throw new Error('TET CodePlane 服务异常（HTTP ' + response.status + '）')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('TET CodePlane 返回空数据')
  try {
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error()
      chunks.push(value)
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(envelope) || envelope.success !== true || !record(envelope.data)) throw new Error()
    return envelope.data
  } catch {
    await reader.cancel().catch(() => {})
    throw new Error('TET CodePlane 数据异常，请重试')
  } finally {
    reader.releaseLock()
  }
}
