import { apiBase } from '../config/address.ts'
import { httpDetails } from '../errors.ts'
import type { GatewayAccess } from '../auth/types.ts'

/**
 * 使用账号网关 Key 查询 JSON，拒绝重定向并限制响应大小。
 * @param path 调用方选择的网关相对路径，包含前导斜杠及可选查询参数。
 * @param access 已解析的网关地址与 Key，仅用于当前账号。
 * @param timeoutMs 该次请求的超时毫秒数，须为 AbortSignal.timeout 接受的非负整数。
 * @returns 尚未经过领域校验的 JSON；响应最大 4 MiB。
 * @throws 地址、网络、HTTP、读取或 JSON 校验失败时抛出安全错误，401 附带 signIn 标记。
 */
export async function query(path: string, access: GatewayAccess, timeoutMs: number): Promise<unknown> {
  const baseURL = apiBase(access.baseURL)
  const endpoint = path.split(/[?#]/, 1)[0]
  let response: Response
  try {
    response = await fetch(baseURL + path, {
      headers: { authorization: 'Bearer ' + access.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
  } catch (error) {
    throw Object.assign(new Error('TET ' + endpoint + ' query failed or timed out. Retry later.'), {
      category: error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network',
    })
  }
  if (!response.ok) {
    try {
      await response.body?.cancel()
    } catch {}
    if (response.status === 401) {
      throw Object.assign(new Error('TET rejected the API key. Sign in again.'), {
        ...httpDetails(response),
        signIn: 'expired',
      })
    }
    throw Object.assign(
      new Error('TET ' + endpoint + ' returned HTTP ' + response.status + '. Retry later.'),
      httpDetails(response),
    )
  }
  const reader = response.body?.getReader()
  if (!reader)
    throw Object.assign(new Error('TET ' + endpoint + ' returned an empty response.'), { category: 'protocol' })
  const chunks: Uint8Array[] = []
  let size = 0
  let category = 'network'
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) {
        category = 'protocol'
        throw new Error('Query response exceeds 4 MiB.')
      }
      chunks.push(value)
    }
    category = 'protocol'
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return payload
  } catch (error) {
    await reader.cancel().catch(() => {})
    /** 读取中断与完整正文格式错误分开，避免响应头返回后丢失超时分类。 */
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) category = 'timeout'
    throw Object.assign(new Error('TET ' + endpoint + ' returned invalid, oversized or interrupted JSON.'), {
      category,
    })
  } finally {
    reader.releaseLock()
  }
}

/**
 * 创建独立查询作用域，合并地址、Key、路径和超时均相同的在途请求。
 * @returns 与 query 参数相同的查询函数；完成或失败后移除任务，不缓存响应数据。
 */
export function createQueries() {
  const pending = new Map<string, Promise<unknown>>()
  return (path: string, access: GatewayAccess, timeoutMs: number): Promise<unknown> => {
    const baseURL = apiBase(access.baseURL)
    const scope = JSON.stringify([baseURL, access.apiKey, path, timeoutMs])
    const existing = pending.get(scope)
    if (existing) return existing
    const task = query(path, { ...access, baseURL }, timeoutMs).finally(() => pending.delete(scope))
    pending.set(scope, task)
    return task
  }
}
