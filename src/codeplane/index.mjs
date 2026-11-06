import { createHash } from 'node:crypto'
import { apiBase } from '../config.mjs'
import { codePlaneBase, request } from './client.mjs'
import { readQuotas } from './quota-reader.mjs'

// 宿主用量调用只有 20 秒，辅助 TET CodePlane 请求不能耗尽该预算而丢掉正常钱包。
const USAGE_TIMEOUT_MS = 5000
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** TET CodePlane 会话独立续签，失败不得使网关 Key 失效。 */
export function createCodePlane() {
  // metadata.management 与 managementURL 等旧字段名仅用于兼容已保存的认证，不迁移存储格式。
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
    const url = codePlaneBase(inputs.managementURL)
    if (
      typeof inputs.managementUsername !== 'string' ||
      !inputs.managementUsername.trim() ||
      typeof inputs.managementPassword !== 'string' ||
      !inputs.managementPassword
    ) {
      throw new Error('请填写 TET CodePlane 账号和密码')
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
          throw new Error('TET CodePlane 登录数据异常')
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
    codePlaneBase(binding.url)
    return binding
  }
  const identity = (url, userId) =>
    createHash('sha256')
      .update(JSON.stringify([url, String(userId)]))
      .digest('hex')
  const userIdOf = data => data.userId ?? data.user?.id ?? data.id
  const validKey = key => typeof key === 'string' && key.trim() && !/\s/.test(key)
  const accountSession = async (session, inputs, timeoutMs, signal) => {
    const data = session.data
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
      throw new Error('TET CodePlane 账号登录数据不完整')
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
      if (force || binding.expiresAt <= Date.now())
        throw new Error('TET CodePlane 登录已过期，请重新登录以启用自动续期')
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
              throw Object.assign(new Error('TET CodePlane 账号已变更，请重新登录'), { identityChanged: true })
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
              throw new Error('TET CodePlane 登录已过期，请重新登录以启用自动续期')
            session = await signIn(inputs, budget, renewalSignal)
          }
          const uid = userIdOf(session.data)
          if (binding.userId !== undefined && uid !== undefined && String(uid) !== String(binding.userId))
            throw new Error('TET CodePlane 账号已变更，请重新登录')
          let key = auth.key
          if (binding.accountLogin) {
            // 重登不自动迁移网关地址；账号 Key 则跟随服务端当前值。
            const account = await accountSession(session, inputs, budget, renewalSignal)
            if (String(account.userId) !== String(binding.userId))
              throw new Error('TET CodePlane 账号已变更，请重新登录')
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
    async read(auth, timeoutMs, save = async () => {}) {
      const binding = auth?.metadata?.management
      if (!binding) return null
      try {
        validate(auth)
        const url = codePlaneBase(binding.url)
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
        const query = async (path, options) => {
          const token = current.metadata.management.token
          try {
            return await request(url, path, { ...options, token })
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
            return request(url, path, { ...options, token: current.metadata.management.token })
          }
        }
        const scope = createHash('sha256')
          .update(JSON.stringify([url, current.metadata.management.token, usageTimeoutMs]))
          .digest('hex')
        if (!pending.has(scope)) {
          const task = readQuotas(query, { timeoutMs: usageTimeoutMs, signal })
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
