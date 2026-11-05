import { createHash } from 'node:crypto'
import { apiBase } from './config.mjs'
import { mapManagementUsage } from './management-usage.mjs'

const GROUPS = '/api/costs/llm-quotas'
// 宿主用量调用只有 20 秒，辅助管理台请求不能耗尽该预算而丢掉正常钱包。
const USAGE_TIMEOUT_MS = 5000
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function managementBase(value) {
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) throw new Error()
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) throw new Error()
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new Error('Management URL must be an HTTP(S) URL without credentials, query or fragment.')
  }
}

/** 管理台会话与 API Key 分开传递；错误只使用固定文本，禁止透传响应正文。 */
async function request(baseURL, path, { token, body, timeoutMs, signal } = {}) {
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
    throw new Error('Management query failed or timed out. Retry later.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401) throw new Error('Management session expired. Sign in again using management usage.')
    if (response.status === 403) throw new Error('Management account cannot read this quota group.')
    throw new Error('Management query returned HTTP ' + response.status + '. Retry later.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Management returned an empty response.')
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
    throw new Error('Management returned an invalid, oversized or interrupted response.')
  } finally {
    reader.releaseLock()
  }
}

async function listGroups(url, token, timeoutMs, signal) {
  const groups = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await request(url, GROUPS + '?pageNum=' + page + '&pageSize=100', { token, timeoutMs, signal })
    if (!Array.isArray(data.content) || !Number.isSafeInteger(data.totalElements) || data.totalElements < 0) {
      throw new Error('Management returned an invalid quota group list.')
    }
    for (const item of data.content) {
      if (!Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('Management returned an invalid quota group.')
      }
      if (groups.has(item.id)) throw new Error('Management quota group pagination repeated.')
      if (
        !Array.isArray(item.accounts) ||
        item.accounts.some(account => !Number.isSafeInteger(account?.id) || account.id <= 0)
      ) {
        throw new Error('Management returned invalid quota accounts.')
      }
      groups.set(item.id, {
        id: item.id,
        name: item.name.trim(),
        accounts: item.accounts.map(account => ({ id: account.id })),
      })
    }
    if (groups.size >= data.totalElements) return [...groups.values()]
    if (!data.content.length) break
  }
  throw new Error('Management quota group list is incomplete or excessive.')
}

/** 不解析 JWT 作为权限依据；由服务端判断会话有效性，过期后重新登录而不保存密码。 */
export function createManagement() {
  const signIns = new Map()
  const pending = new Map()
  const fields = [
    { type: 'text', key: 'baseURL', message: 'API base URL', placeholder: 'https://relay.example' },
    { type: 'text', key: 'managementURL', message: 'Management URL', placeholder: 'https://console.example' },
    { type: 'text', key: 'managementUsername', message: 'Management username' },
    { type: 'password', key: 'managementPassword', message: 'Management password' },
  ]
  const flowKey = inputs =>
    createHash('sha256')
      .update(
        JSON.stringify([inputs.baseURL, inputs.managementURL, inputs.managementUsername, inputs.managementPassword]),
      )
      .digest('hex')
  const signIn = (inputs, timeoutMs, signal) => {
    const url = managementBase(inputs.managementURL)
    if (
      typeof inputs.managementUsername !== 'string' ||
      !inputs.managementUsername.trim() ||
      typeof inputs.managementPassword !== 'string' ||
      !inputs.managementPassword
    ) {
      throw new Error('Enter the management username and password.')
    }
    for (const [id, cached] of signIns) if (cached.until <= Date.now()) signIns.delete(id)
    const id = flowKey(inputs)
    if (!signIns.has(id)) {
      if (signIns.size >= 10) signIns.delete(signIns.keys().next().value)
      const task = (async () => {
        const data = await request(url, '/api/auth/login', {
          body: { loginName: inputs.managementUsername.trim(), password: inputs.managementPassword },
          timeoutMs,
          signal,
        })
        if (typeof data.token !== 'string' || !data.token.trim() || /\s/.test(data.token)) {
          throw new Error('Management login returned an invalid session.')
        }
        const groups = await listGroups(url, data.token, timeoutMs, signal)
        if (!groups.length) throw new Error('No readable management quota groups were found.')
        if (!groups.some(group => group.accounts.length))
          throw new Error('No readable management quota accounts were found.')
        const expiresAt = Number.isFinite(data.tokenExpiresAt) ? data.tokenExpiresAt * 1000 : undefined
        return { url, token: data.token, groups, expiresAt }
      })()
      signIns.set(id, { task, until: Date.now() + 5 * 60 * 1000 })
      task.catch(() => signIns.delete(id))
    }
    return signIns.get(id).task
  }
  return {
    async ask(inputs, timeoutMs) {
      for (const field of fields) {
        if (!(field.key in inputs)) return field
        if (field.key === 'baseURL') apiBase(inputs.baseURL)
        if (field.key === 'managementURL') managementBase(inputs.managementURL)
      }
      if ('managementGroup' in inputs) return null
      const { groups } = await signIn(inputs, timeoutMs)
      return {
        type: 'select',
        key: 'managementGroup',
        message: 'Quota group to display (shared group, display only)',
        options: groups.flatMap(group =>
          group.accounts.map(account => ({
            value: group.id + ':' + account.id,
            label: group.name + ' / account #' + account.id,
          })),
        ),
      }
    },
    async authorize(inputs, timeoutMs, signal) {
      const baseURL = apiBase(inputs.baseURL)
      try {
        const session = await signIn(inputs, timeoutMs, signal)
        const group = session.groups.find(group =>
          group.accounts.some(account => group.id + ':' + account.id === inputs.managementGroup),
        )
        const account = group?.accounts.find(account => group.id + ':' + account.id === inputs.managementGroup)
        if (!group || !account) throw new Error('Select a readable management quota account.')
        return {
          type: 'success',
          metadata: {
            baseURL,
            management: {
              url: session.url,
              token: session.token,
              expiresAt: session.expiresAt,
              groupId: group.id,
              accountId: account.id,
              groupName: group.name,
              apiBaseURL: baseURL,
            },
            /** 宿主会合并所有输入；显式覆盖后 JSON 序列化才能移除密码等临时字段。 */
            managementURL: undefined,
            managementUsername: undefined,
            managementPassword: undefined,
            managementGroup: undefined,
          },
        }
      } finally {
        signIns.delete(flowKey(inputs))
      }
    },
    async windows(auth, timeoutMs) {
      const binding = auth?.metadata?.management
      if (!binding) return []
      const keyLabel = createHash('sha256').update(String(auth.key)).digest('hex').slice(0, 8)
      try {
        if (
          !record(binding) ||
          typeof binding.token !== 'string' ||
          !binding.token ||
          /\s/.test(binding.token) ||
          !Number.isSafeInteger(binding.groupId) ||
          binding.groupId <= 0 ||
          !Number.isSafeInteger(binding.accountId) ||
          binding.accountId <= 0 ||
          typeof binding.groupName !== 'string' ||
          binding.apiBaseURL !== apiBase(auth.metadata.baseURL)
        )
          throw new Error()
        const groupName = binding.groupName + ' / account #' + binding.accountId
        if (Number.isFinite(binding.expiresAt) && binding.expiresAt <= Date.now()) {
          const expired = 'Management session expired. Sign in again using management usage.'
          return mapManagementUsage({ usageError: expired, creditsError: expired }, { groupName, keyLabel })
        }
        const url = managementBase(binding.url)
        const usageTimeoutMs = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
        const scope = createHash('sha256')
          .update(JSON.stringify([url, binding.token, binding.accountId, usageTimeoutMs]))
          .digest('hex')
        if (!pending.has(scope)) {
          const task = Promise.allSettled(
            ['usage', 'credits'].map(kind =>
              request(url, GROUPS + '/' + binding.accountId + '/' + kind + (kind === 'usage' ? '?active=false' : ''), {
                token: binding.token,
                timeoutMs: usageTimeoutMs,
              }),
            ),
          ).finally(() => pending.delete(scope))
          pending.set(scope, task)
        }
        const [usage, credits] = await pending.get(scope)
        return mapManagementUsage(
          {
            ...(usage.status === 'fulfilled' ? { usage: usage.value } : { usageError: usage.reason.message }),
            ...(credits.status === 'fulfilled' ? { credits: credits.value } : { creditsError: credits.reason.message }),
          },
          { groupName, keyLabel },
        )
      } catch {
        return [
          {
            name: 'Management usage',
            display: 'Management configuration changed or is invalid. Sign in again using management usage.',
            aside: true,
          },
        ]
      }
    },
  }
}
