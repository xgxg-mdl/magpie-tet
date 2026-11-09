import { finite, record } from '../validation.ts'
import type { Allowance, GatewayUsage, UsageStats } from './types.ts'

const timestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined

function allowance(
  kind: Allowance['kind'],
  period: string,
  used: unknown,
  limit: unknown,
  reset: unknown,
): Allowance | undefined {
  if (!finite(limit) || limit <= 0) return undefined
  const resetsAt = timestamp(reset)
  return { kind, period, limit, ...(finite(used) && used >= 0 ? { used } : {}), ...(resetsAt ? { resetsAt } : {}) }
}

function stats(raw: unknown): UsageStats | undefined {
  if (!record(raw)) return undefined
  const cost = finite(raw.actual_cost) ? raw.actual_cost : raw.cost
  if (!finite(cost)) return undefined
  return {
    cost,
    ...(finite(raw.requests) ? { requests: raw.requests } : {}),
    ...(finite(raw.total_tokens) ? { tokens: raw.total_tokens } : {}),
  }
}

/**
 * 将网关用量归一化为钱包、真实限额及统计，不生成宿主展示字段。
 * @param raw 尚未经结构校验的网关用量 JSON。
 * @returns 密钥失效状态或有效账号用量；无效可选读数被省略，未知用量不补零。
 * @throws 顶层不是对象或 isValid 不是布尔值时抛出错误。
 */
export function parseUsage(raw: unknown): GatewayUsage {
  if (!record(raw) || typeof raw.isValid !== 'boolean') throw new Error('TET returned an invalid usage response.')
  if (!raw.isValid) return { kind: 'invalid-key' }
  const sub = record(raw.subscription) ? raw.subscription : undefined
  const periods = ['daily', 'weekly', 'monthly']
  const hasSubscription =
    !!sub &&
    (!!timestamp(sub.expires_at) ||
      periods.some(period => {
        const limit = sub[period + '_limit_usd']
        return finite(limit) && limit > 0
      }))
  const allowances: Allowance[] = []
  let expiresAt = timestamp(raw.expires_at)
  let quotaStatus: 'expired' | 'quota-exhausted' | undefined
  if (raw.mode === 'quota_limited') {
    const quota = record(raw.quota) ? raw.quota : undefined
    const key = allowance('key-quota', '', quota?.used, quota?.limit, undefined)
    if (key) allowances.push(key)
    for (const item of Array.isArray(raw.rate_limits) ? raw.rate_limits : []) {
      if (!record(item) || typeof item.window !== 'string') continue
      const window = allowance('rate', item.window, item.used, item.limit, item.reset_at)
      if (window) allowances.push(window)
    }
    if (raw.status === 'expired') quotaStatus = 'expired'
    if (raw.status === 'quota_exhausted') quotaStatus = 'quota-exhausted'
  } else if (hasSubscription && sub) {
    for (const period of periods) {
      const window = allowance(
        'subscription',
        period,
        sub[period + '_usage_usd'],
        sub[period + '_limit_usd'],
        sub[period + '_reset_at'],
      )
      if (window) allowances.push(window)
    }
    const subscriptionExpiry = timestamp(sub.expires_at)
    if (subscriptionExpiry && (!expiresAt || Date.parse(subscriptionExpiry) < Date.parse(expiresAt)))
      expiresAt = subscriptionExpiry
  }
  const usage = record(raw.usage) ? raw.usage : undefined
  const today = stats(usage?.today)
  const total = stats(usage?.total)
  return {
    kind: 'valid',
    plan: typeof raw.planName === 'string' && raw.planName ? raw.planName : 'TET',
    unit: typeof raw.unit === 'string' ? raw.unit : 'USD',
    ...(finite(raw.balance) ? { wallet: raw.balance } : {}),
    allowances,
    ...(expiresAt ? { expiresAt } : {}),
    ...(quotaStatus ? { quotaStatus } : {}),
    missingAccountUsage: raw.mode !== 'quota_limited' && !hasSubscription && !finite(raw.balance),
    stats: {
      ...(today ? { today } : {}),
      ...(total ? { total } : {}),
      ...(finite(usage?.rpm) ? { rpm: usage.rpm } : {}),
      ...(finite(usage?.tpm) ? { tpm: usage.tpm } : {}),
    },
  }
}
