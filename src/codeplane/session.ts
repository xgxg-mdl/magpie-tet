import { createHash } from 'node:crypto'
import { apiBase, codePlaneBase } from '../config/address.ts'
import { record } from '../validation.ts'
import { request } from './client.ts'
import { readQuotas } from './quota-reader.ts'
import { decodeGatewayConfiguration, decodeSessionInfo, decodeSessionReply } from './session-decoder.ts'
import type { CodePlaneAccount, CodePlaneLogin } from '../auth/types.ts'
import type { CodePlaneQuery, CodePlaneResult } from './types.ts'
import type { SessionReply } from './session-decoder.ts'

// 宿主用量调用只有 20 秒，辅助 TET CodePlane 请求不能耗尽该预算而丢掉正常钱包。
const USAGE_TIMEOUT_MS = 5000

interface RefreshOptions {
  /** 忽略距离到期时间的提前量，立即尝试恢复；仍复用已有成功结果与退避。 */
  force?: boolean
  /** 调用方取消信号，与最多五秒的恢复预算组合。 */
  signal?: AbortSignal
}

const message = (error: unknown): string => (error instanceof Error ? error.message : 'TET CodePlane 服务异常')
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const flowKey = (input: CodePlaneLogin): string =>
  digest([input.baseURL, input.codePlaneURL, input.username, input.password])
/**
 * 创建独立的 CodePlane 会话协调器，管理登录合并、恢复退避及在途额度共享。
 * 同一实例复用相同输入的在途登录、相同账号的恢复和相同会话的额度读取；完成后不缓存额度。
 * @returns login、refresh 和 read 接口；宿主认证解析、编码和账号作用域保存由调用方负责。
 */
export function createCodePlane() {
  const signIns = new Map<string, { task: Promise<SessionReply>; until: number }>()
  const pending = new Map<string, Promise<CodePlaneResult>>()
  const renewals = new Map<string, Promise<CodePlaneAccount>>()
  const renewed = new Map<string, { account: CodePlaneAccount; until: number }>()
  const failures = new Map<string, { message: string; until: number }>()

  const signIn = (input: CodePlaneLogin, timeoutMs: number, signal?: AbortSignal): Promise<SessionReply> => {
    for (const [id, cached] of signIns) if (cached.until <= Date.now()) signIns.delete(id)
    const id = flowKey(input)
    const existing = signIns.get(id)
    if (existing) return existing.task
    if (signIns.size >= 10) {
      const oldest = signIns.keys().next().value
      if (oldest !== undefined) signIns.delete(oldest)
    }
    const task = (async (): Promise<SessionReply> => {
      const payload = await request(input.codePlaneURL, '/api/auth/login', {
        body: { loginName: input.username, password: input.password },
        timeoutMs,
        ...(signal ? { signal } : {}),
      })
      return decodeSessionReply(payload)
    })()
    signIns.set(id, { task, until: Date.now() + 5 * 60 * 1000 })
    void task.catch(() => signIns.delete(id))
    return task
  }

  const accountSession = async (
    reply: SessionReply,
    input: CodePlaneLogin,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CodePlaneAccount> => {
    let key = reply.apiKey
    let gateway = input.baseURL || reply.gatewayURL
    if (!key || !gateway) {
      const config = decodeGatewayConfiguration(
        await request(input.codePlaneURL, '/api/auth/profile/gateway-config', {
          token: reply.token,
          timeoutMs,
          ...(signal ? { signal } : {}),
        }),
      )
      key ||= config.apiKey
      gateway ||= config.gatewayURL
    }
    if (
      !key ||
      reply.expiresAt === undefined ||
      reply.expiresAt === null ||
      reply.expiresAt <= Date.now() ||
      !reply.userId
    )
      throw new Error('TET CodePlane 账号登录数据不完整')
    const id = reply.userId
    return {
      kind: 'codeplane',
      gateway: { apiKey: key, baseURL: apiBase(gateway) },
      uid: digest([input.codePlaneURL, id]),
      session: {
        baseURL: input.codePlaneURL,
        token: reply.token,
        expiresAt: reply.expiresAt,
        userId: id,
        username: input.username,
        password: input.password,
      },
    }
  }

  /**
   * 会话距离到期不足五分钟时先查询 /me，未明确续期则使用账号密码重登。
   * 恢复结果短期复用，失败退避三十秒；成功只能更新同一身份和已确认网关下的 Key。
   * @param account 已校验的完整 CodePlane 账号。
   * @param timeoutMs 恢复超时，单位毫秒；实际预算不超过五秒。
   * @param options 强制恢复开关与可选调用方取消信号。
   * @returns 新账号或可复用的恢复结果；无需恢复时为 undefined，不执行宿主持久化。
   * @throws 续期与重登均失败、身份变化或处于失败退避时抛出安全错误。
   */
  const refresh = async (
    account: CodePlaneAccount,
    timeoutMs: number,
    { force = false, signal }: RefreshOptions = {},
  ): Promise<CodePlaneAccount | undefined> => {
    const binding = account.session
    const id = digest(account)
    for (const [key, value] of renewed) if (value.until <= Date.now()) renewed.delete(key)
    for (const [key, value] of failures) if (value.until <= Date.now()) failures.delete(key)
    const cached = renewed.get(id)
    if (cached) return cached.account
    if (!force && binding.expiresAt > Date.now() + 300000) return
    const failure = failures.get(id)
    if (failure) throw new Error(failure.message)
    const existing = renewals.get(id)
    if (existing) return existing
    const input: CodePlaneLogin = {
      baseURL: account.gateway.baseURL,
      codePlaneURL: binding.baseURL,
      username: binding.username,
      password: binding.password,
    }
    const task = (async (): Promise<CodePlaneAccount> => {
      const budget = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
      const deadline = AbortSignal.timeout(budget)
      const renewalSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      try {
        let reply: SessionReply | undefined
        // /me 只有明确返回新令牌或更晚的有效期，才视为续期成功。
        try {
          const info = decodeSessionInfo(
            await request(binding.baseURL, '/api/auth/me', {
              token: binding.token,
              timeoutMs: budget,
              signal: renewalSignal,
            }),
          )
          if (info.userId !== undefined && info.userId !== binding.userId)
            throw Object.assign(new Error('TET CodePlane 账号已变更，请重新登录'), { identityChanged: true })
          const token = info.token ?? binding.token
          const effectiveExpiry = info.expiresAt === undefined ? binding.expiresAt : info.expiresAt
          if (
            effectiveExpiry !== null &&
            effectiveExpiry > Date.now() &&
            (token !== binding.token || effectiveExpiry > binding.expiresAt)
          ) {
            reply = {
              ...info,
              token,
              expiresAt: effectiveExpiry,
              userId: info.userId ?? binding.userId,
            }
          }
        } catch (error) {
          if (record(error) && error.identityChanged) throw error
        }
        reply ??= await signIn(input, budget, renewalSignal)
        if (reply.userId !== binding.userId) throw new Error('TET CodePlane 账号已变更，请重新登录')
        // 重登可更新 Key，但不自动迁移已确认的网关地址或账号身份。
        const next = await accountSession(reply, input, budget, renewalSignal)
        const result: CodePlaneAccount = { ...next, uid: account.uid }
        if (renewed.size >= 100) {
          const oldest = renewed.keys().next().value
          if (oldest !== undefined) renewed.delete(oldest)
        }
        renewed.set(id, { account: result, until: Date.now() + 300000 })
        return result
      } catch (error) {
        if (failures.size >= 100) {
          const oldest = failures.keys().next().value
          if (oldest !== undefined) failures.delete(oldest)
        }
        failures.set(id, { message: message(error), until: Date.now() + 30000 })
        throw error
      } finally {
        signIns.delete(flowKey(input))
      }
    })().finally(() => renewals.delete(id))
    renewals.set(id, task)
    return task
  }

  return {
    refresh,
    /**
     * 通过账号密码取得完整会话、网关密钥和稳定身份，不执行持久化。
     * @param input 已校验登录输入，显式网关地址优先于服务端候选。
     * @param timeoutMs 整个登录和配置回退的预算，单位毫秒，最多五秒。
     * @param signal 调用方可选取消信号；相同输入的并发登录复用首个在途请求。
     * @returns 可用于网关访问和共享额度读取的完整账号。
     * @throws 认证、请求、身份、有效期或网关配置校验失败时抛出安全错误。
     */
    async login(input: CodePlaneLogin, timeoutMs: number, signal?: AbortSignal): Promise<CodePlaneAccount> {
      const budget = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
      const deadline = AbortSignal.timeout(budget)
      const loginSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      try {
        return await accountSession(await signIn(input, budget, loginSignal), input, budget, loginSignal)
      } finally {
        signIns.delete(flowKey(input))
      }
    },
    /**
     * 在独立网络预算内恢复会话并读取本轮共享额度，401 只触发一次恢复与查询重试。
     * 同站点、令牌和超时共享在途额度读取；同一账号的并发调用分别保存其恢复结果。
     * @param account 已校验的 CodePlane 账号。
     * @param timeoutMs 恢复与查询的网络预算，单位毫秒，最多五秒；不限制 save 回调耗时。
     * @param save 保存恢复后的账号；必须在当前宿主账号作用域内拒绝覆盖替换登录，耗时由调用方约束。
     * @returns 分组快照或安全错误结果；读取、恢复及保存失败均转为 error，不抛给钱包流程。
     */
    async read(
      account: CodePlaneAccount,
      timeoutMs: number,
      save: (account: CodePlaneAccount) => Promise<void> = async () => {},
    ): Promise<CodePlaneResult> {
      try {
        let current = account
        const url = codePlaneBase(current.session.baseURL)
        const usageTimeoutMs = Math.min(timeoutMs, USAGE_TIMEOUT_MS)
        const signal = AbortSignal.timeout(usageTimeoutMs)
        const renew = async (force: boolean): Promise<void> => {
          const next = await refresh(current, usageTimeoutMs, { force, signal })
          if (next) {
            await save(next)
            current = next
          }
        }
        await renew(false)
        let retried = false
        let recovery: Promise<void> | undefined
        const query: CodePlaneQuery = async (path, options) => {
          const token = current.session.token
          try {
            return await request(url, path, { ...options, token })
          } catch (error) {
            if (!record(error) || error.status !== 401) throw error
            if (current.session.token === token) {
              if (!recovery) {
                if (retried) throw error
                retried = true
                recovery = renew(true)
              }
              await recovery
            }
            return request(url, path, { ...options, token: current.session.token })
          }
        }
        const scope = digest([url, current.session.token, usageTimeoutMs])
        let task = pending.get(scope)
        if (!task) {
          task = readQuotas(query, { timeoutMs: usageTimeoutMs, signal })
            .catch((error: unknown) => ({ error: message(error) }))
            .finally(() => pending.delete(scope))
          pending.set(scope, task)
        }
        const result = await task
        // 共用读取的其他账号也必须在各自宿主作用域保存新会话。
        await renew(false)
        return result
      } catch (error) {
        return { error: message(error) }
      }
    },
  }
}
