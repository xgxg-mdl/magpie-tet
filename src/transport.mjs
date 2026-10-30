import { apiBase } from './config.mjs'
import { httpDetails } from './errors.mjs'

export function credentials(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim()) {
    throw Object.assign(new Error('Sign in with a TET API key.'), { signIn: 'expired' })
  }
  const key = auth.key.trim()
  if (/[\r\n]/.test(key)) throw new Error('Invalid TET API key format.')
  return key
}

/** 查询错误只报告状态和固定路径，不把可能含凭据的响应或网络异常写入 UI。 */
export async function query(path, auth, timeoutMs, baseURL) {
  baseURL = apiBase(baseURL)
  const endpoint = path.split(/[?#]/, 1)[0]
  let response
  try {
    response = await fetch(baseURL + path, {
      headers: { authorization: 'Bearer ' + credentials(auth) },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
  } catch (error) {
    if (error.signIn) throw error
    throw Object.assign(new Error('TET ' + endpoint + ' query failed or timed out. Retry later.'),
      { category: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network' })
  }
  if (!response.ok) {
    try { await response.body?.cancel() } catch {}
    if (response.status === 401) {
      throw Object.assign(new Error('TET rejected the API key. Sign in again.'), { ...httpDetails(response), signIn: 'expired' })
    }
    throw Object.assign(new Error('TET ' + endpoint + ' returned HTTP ' + response.status + '. Retry later.'), httpDetails(response))
  }
  const reader = response.body?.getReader()
  if (!reader) throw Object.assign(new Error('TET ' + endpoint + ' returned an empty response.'), { category: 'protocol' })
  const chunks = []
  let size = 0
  let category = 'network'
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) { category = 'protocol'; throw new Error('Query response exceeds 4 MiB.') }
      chunks.push(value)
    }
    category = 'protocol'
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    await reader.cancel().catch(() => {})
    /** 读取中断与完整正文格式错误分开，避免响应头返回后丢失超时分类。 */
    if (['TimeoutError', 'AbortError'].includes(error.name)) category = 'timeout'
    throw Object.assign(new Error('TET ' + endpoint + ' returned invalid, oversized or interrupted JSON.'), { category })
  } finally { reader.releaseLock() }
}

/** 每次取当前账号凭据，避免重新登录后旧 loader 继续发送已替换的密钥。 */
export async function forward(input, init, getAuth, baseURL) {
  baseURL = apiBase(baseURL)
  const url = new URL(input instanceof Request ? input.url : input)
  const base = new URL(baseURL)
  const prefix = base.pathname.replace(/\/+$/, '')
  if (url.origin !== base.origin || url.username || url.password || url.hash ||
    ![prefix + '/responses', prefix + '/responses/compact'].includes(url.pathname)) {
    throw new Error('TET refused a request outside its Responses API.')
  }
  const key = credentials(await getAuth())
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-goog-api-key', 'host']) headers.delete(name)
  headers.set('authorization', 'Bearer ' + key)
  /** 保留原始正文、取消信号和 Response 流，不擅自改写 store、工具调用或推理参数。 */
  return fetch(input, { ...init, headers, redirect: 'error' })
}

/** 并发合并仅限同一地址和密钥的在途查询；完成后移除，不缓存账户数据。 */
export function createQueries() {
  const pending = new Map()
  return (path, auth, timeoutMs, baseURL) => {
    baseURL = apiBase(baseURL)
    const key = credentials(auth)
    const scope = JSON.stringify([baseURL, key, path, timeoutMs])
    if (!pending.has(scope)) {
      const task = query(path, { type: 'api', key }, timeoutMs, baseURL).finally(() => pending.delete(scope))
      pending.set(scope, task)
    }
    return pending.get(scope)
  }
}
