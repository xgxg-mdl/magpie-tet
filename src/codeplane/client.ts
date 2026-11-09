import { record } from '../validation.ts'
import type { RequestOptions } from './types.ts'

/**
 * 发送 CodePlane 请求并读取至多 4 MiB 的成功数据对象，拒绝重定向。
 * @param baseURL 已规范化的 CodePlane 站点地址。
 * @param path 站点内请求路径，由调用方使用固定端点构造。
 * @param options 会话令牌、JSON 请求体、毫秒超时及可选取消信号。
 * @returns success 为 true 的响应信封内 data 对象，字段仍需领域解析。
 * @throws 网络、超时、HTTP 失败或响应格式异常时抛出安全错误；401 带 status。
 */
export async function request(
  baseURL: string,
  path: string,
  { token, body, timeoutMs, signal }: RequestOptions,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
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
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error()
      chunks.push(value)
    }
    const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(envelope) || envelope.success !== true || !record(envelope.data)) throw new Error()
    return envelope.data
  } catch {
    await reader.cancel().catch(() => {})
    throw new Error('TET CodePlane 数据异常，请重试')
  } finally {
    reader.releaseLock()
  }
}
