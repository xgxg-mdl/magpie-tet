import { createHash } from 'node:crypto'
import { apiBase } from './config.mjs'

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
    throw new Error('管理台地址须使用 HTTP(S)，且不含凭据、查询参数或片段')
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
    throw new Error('管理台查询超时或连接失败')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401)
      throw Object.assign(new Error(body ? '管理台账号或密码有误' : '管理台登录已过期'), { status: 401 })
    if (response.status === 403) throw new Error('无权查看此额度')
    throw new Error('管理台服务异常（HTTP ' + response.status + '）')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('管理台返回空数据')
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
    throw new Error('管理台数据异常，请重试')
  } finally {
    reader.releaseLock()
  }
}

async function listGroups(url, token, timeoutMs, signal, query = request) {
  const groups = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await query(url, GROUPS + '?pageNum=' + page + '&pageSize=100', { token, timeoutMs, signal })
    if (!Array.isArray(data.content) || !Number.isSafeInteger(data.totalElements) || data.totalElements < 0) {
      throw new Error('管理台分组列表异常')
    }
    for (const item of data.content) {
      if (!Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('管理台分组数据异常')
      }
      if (groups.has(item.id)) throw new Error('管理台分组分页重复')
      if (
        !Array.isArray(item.accounts) ||
        item.accounts.some(account => !Number.isSafeInteger(account?.id) || account.id <= 0)
      ) {
        throw new Error('管理台上游账号列表异常')
      }
      groups.set(item.id, {
        id: item.id,
        name: item.name.trim(),
        accounts: [
          ...new Map(
            item.accounts.map(account => [
              account.id,
              {
                id: account.id,
                name: typeof account.name === 'string' ? account.name.trim() : '',
              },
            ]),
          ).values(),
        ],
        capacity: item.capacity,
      })
    }
    if (groups.size >= data.totalElements) return [...groups.values()]
    if (!data.content.length) break
  }
  throw new Error('管理台分组列表不完整或过大')
}

/** 管理台会话独立续签，失败不得使网关 Key 失效。 */
export function createManagement() {
  const signIns = new Map()
  const pending = new Map()
  const renewals = new Map()
  const renewed = new Map()
  const failures = new Map()
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
      throw new Error('请填写管理台账号和密码')
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
          throw new Error('管理台登录数据异常')
        }
        const expiresAt = Number.isFinite(data.tokenExpiresAt) ? data.tokenExpiresAt * 1000 : undefined
        return { url, token: data.token, expiresAt, data }
      })()
      signIns.set(id, { task, until: Date.now() + 5 * 60 * 1000 })
      task.catch(() => signIns.delete(id))
    }
    return signIns.get(id).task
  }
  const validate = auth => {
    const binding = auth?.metadata?.management
    if (
      !record(binding) ||
      typeof binding.token !== 'string' ||
      !binding.token ||
      /\s/.test(binding.token) ||
      binding.apiBaseURL !== apiBase(auth.metadata.baseURL)
    )
      throw new Error('配置已变更，请重新登录')
    managementBase(binding.url)
    return binding
  }
  const identity = (url, userId) =>
    createHash('sha256')
      .update(JSON.stringify([url, String(userId)]))
      .digest('hex')
  const userIdOf = data => data.userId ?? data.user?.id ?? data.id
  const validKey = key => typeof key === 'string' && key.trim() && !/\s/.test(key)
  const accountSession = async (session, inputs, timeoutMs, signal) => {
    let data = session.data
    let key = data.apiKey
    let gateway = inputs.baseURL || data.codexGatewayUrl || data.gatewayPublicBaseUrl
    if (!validKey(key) || !gateway) {
      const config = await request(session.url, '/api/auth/profile/gateway-config', {
        token: session.token,
        timeoutMs,
        signal,
      })
      key = validKey(key) ? key : config.apiKey
      gateway ||= config.codexGatewayUrl || config.gatewayPublicBaseUrl
    }
    const userId = userIdOf(data)
    const validUserId =
      (typeof userId === 'string' && userId.trim()) ||
      (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0)
    if (!validKey(key) || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || !validUserId)
      throw new Error('管理台账号登录数据不完整')
    return { key, baseURL: apiBase(gateway), userId }
  }
  const refresh = async (auth, timeoutMs, { force = false, signal } = {}) => {
    const binding = validate(auth)
    const id = createHash('sha256')
      .update(JSON.stringify([auth.type, auth.key, binding]))
      .digest('hex')
    for (const [key, value] of renewed) if (value.until <= Date.now()) renewed.delete(key)
    for (const [key, value] of failures) if (value.until <= Date.now()) failures.delete(key)
    const cached = renewed.get(id)
    if (cached) return cached.auth
    if (!force && (!Number.isFinite(binding.expiresAt) || binding.expiresAt > Date.now() + 300000)) return
    if (!binding.accountLogin && auth.type !== 'oauth' && (!binding.username || !binding.password)) {
      if (force || binding.expiresAt <= Date.now()) throw new Error('管理台登录已过期，请重新登录以启用自动续期')
      return
    }
    if (failures.has(id)) throw new Error(failures.get(id).message)
    if (!renewals.has(id)) {
      const inputs = {
        baseURL: binding.apiBaseURL,
        managementURL: binding.url,
        managementUsername: binding.username,
        managementPassword: binding.password,
      }
      const task = (async () => {
        const budget = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
        const deadline = AbortSignal.timeout(budget)
        const renewalSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
        try {
          let session
          // /me 只有明确返回新令牌或更晚的有效期，才视为续期成功。
          try {
            const data = await request(binding.url, '/api/auth/me', {
              token: binding.token,
              timeoutMs: budget,
              signal: renewalSignal,
            })
            const uid = userIdOf(data)
            if (binding.userId !== undefined && uid !== undefined && String(uid) !== String(binding.userId))
              throw Object.assign(new Error('管理台账号已变更，请重新登录'), { identityChanged: true })
            const token = validKey(data.token) ? data.token : binding.token
            const expiry = Number.isFinite(data.tokenExpiresAt) ? data.tokenExpiresAt * 1000 : undefined
            const effectiveExpiry = expiry ?? binding.expiresAt
            if (effectiveExpiry > Date.now() && (token !== binding.token || expiry > (binding.expiresAt ?? 0)))
              session = {
                url: binding.url,
                token,
                expiresAt: effectiveExpiry,
                data: { ...data, userId: uid ?? binding.userId },
              }
          } catch (error) {
            if (error.identityChanged) throw error
          }
          if (!session) {
            if (!inputs.managementUsername || !inputs.managementPassword)
              throw new Error('管理台登录已过期，请重新登录以启用自动续期')
            session = await signIn(inputs, budget, renewalSignal)
          }
          const uid = userIdOf(session.data)
          if (binding.userId !== undefined && uid !== undefined && String(uid) !== String(binding.userId))
            throw new Error('管理台账号已变更，请重新登录')
          let key = auth.key
          if (binding.accountLogin) {
            // 重登不自动迁移网关地址；账号 Key 则跟随服务端当前值。
            const account = await accountSession(session, inputs, budget, renewalSignal)
            if (String(account.userId) !== String(binding.userId)) throw new Error('管理台账号已变更，请重新登录')
            key = account.key
          }
          const nextBinding = { ...binding, token: session.token, expiresAt: session.expiresAt }
          const next = {
            ...auth,
            key,
            metadata: { ...auth.metadata, management: nextBinding },
            ...(auth.type === 'oauth' ? { access: session.token, expires: session.expiresAt } : {}),
          }
          if (renewed.size >= 100) renewed.delete(renewed.keys().next().value)
          renewed.set(id, { auth: next, until: Date.now() + 300000 })
          return next
        } catch (error) {
          if (failures.size >= 100) failures.delete(failures.keys().next().value)
          failures.set(id, { message: error.message, until: Date.now() + 30000 })
          throw error
        } finally {
          signIns.delete(flowKey(inputs))
        }
      })().finally(() => renewals.delete(id))
      renewals.set(id, task)
    }
    return await renewals.get(id)
  }
  return {
    refresh,
    async authorizeAccount(inputs, timeoutMs, signal) {
      const budget = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
      const deadline = AbortSignal.timeout(budget)
      const accountSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      try {
        const session = await signIn(inputs, budget, accountSignal)
        const account = await accountSession(session, inputs, budget, accountSignal)
        const uid = identity(session.url, account.userId)
        return {
          type: 'success',
          refresh: uid,
          access: session.token,
          expires: session.expiresAt,
          key: account.key,
          accountId: uid,
          uid,
          metadata: {
            baseURL: account.baseURL,
            management: {
              url: session.url,
              token: session.token,
              expiresAt: session.expiresAt,
              apiBaseURL: account.baseURL,
              userId: account.userId,
              accountLogin: true,
              username: inputs.managementUsername.trim(),
              password: inputs.managementPassword,
            },
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
    async authorize(inputs, timeoutMs, signal) {
      const baseURL = apiBase(inputs.baseURL)
      try {
        const session = await signIn(inputs, timeoutMs, signal)
        return {
          type: 'success',
          metadata: {
            baseURL,
            management: {
              url: session.url,
              token: session.token,
              expiresAt: session.expiresAt,
              apiBaseURL: baseURL,
              username: inputs.managementUsername.trim(),
              password: inputs.managementPassword,
              ...(userIdOf(session.data) !== undefined ? { userId: userIdOf(session.data) } : {}),
            },
            /** 宿主会合并所有输入；移除顶层临时字段，自动重登凭据只保存在管理台绑定内。 */
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
    async read(auth, timeoutMs, save = async () => {}) {
      const binding = auth?.metadata?.management
      if (!binding) return null
      try {
        validate(auth)
        const url = managementBase(binding.url)
        const usageTimeoutMs = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
        const signal = AbortSignal.timeout(usageTimeoutMs)
        let current = auth
        const renew = async force => {
          const next = await refresh(current, usageTimeoutMs, { force, signal })
          if (next) {
            await save(next)
            current = next
          }
        }
        await renew(false)
        let retried = false
        let recovery
        const query = async (base, path, options) => {
          const token = current.metadata.management.token
          try {
            return await request(base, path, { ...options, token })
          } catch (error) {
            if (error.status !== 401) throw error
            if (current.metadata.management.token === token) {
              if (!recovery) {
                if (retried) throw error
                retried = true
                recovery = renew(true)
              }
              await recovery
            }
            return request(base, path, { ...options, token: current.metadata.management.token })
          }
        }
        const scope = createHash('sha256')
          .update(JSON.stringify([url, current.metadata.management.token, usageTimeoutMs]))
          .digest('hex')
        if (!pending.has(scope)) {
          const task = (async () => {
            // 列表分页、排队和各上游查询共用总预算，避免多分组使刷新时间失控。
            const groups = await listGroups(url, current.metadata.management.token, usageTimeoutMs, signal, query)
            const ids = [...new Set(groups.flatMap(group => group.accounts.map(account => account.id)))]
            const readings = new Map()
            let next = 0
            const worker = async () => {
              while (next < ids.length) {
                const id = ids[next++]
                const values = await Promise.allSettled(
                  ['usage', 'credits'].map(kind => {
                    if (signal.aborted) return Promise.reject(new Error('管理台查询超时或连接失败'))
                    return query(url, GROUPS + '/' + id + '/' + kind + (kind === 'usage' ? '?active=false' : ''), {
                      timeoutMs: usageTimeoutMs,
                      signal,
                    })
                  }),
                )
                readings.set(
                  id,
                  Object.fromEntries(
                    values.map((result, index) => {
                      const kind = index === 0 ? 'usage' : 'credits'
                      return result.status === 'fulfilled'
                        ? [kind, result.value]
                        : [kind + 'Error', result.reason.message]
                    }),
                  ),
                )
              }
            }
            // 最多同时查询两个上游，每个上游两个只读接口。
            await Promise.all(Array.from({ length: Math.min(2, ids.length) }, worker))
            return {
              groups: groups.map(group => ({
                ...group,
                accounts: group.accounts.map(account => ({ ...account, ...readings.get(account.id) })),
              })),
            }
          })()
            .catch(error => ({ error: error.message }))
            .finally(() => pending.delete(scope))
          pending.set(scope, task)
        }
        const result = await pending.get(scope)
        // 共用读取的其他账号也必须在各自宿主作用域保存新会话。
        await renew(false)
        return result
      } catch (error) {
        return { error: error.message }
      }
    },
  }
}
