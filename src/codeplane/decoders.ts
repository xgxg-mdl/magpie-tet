import { finite, record } from '../validation.ts'
import type {
  CapacityReading,
  ListedQuotaGroup,
  PeriodReading,
  QuotaReadings,
  ResetReading,
  UnavailableReading,
} from './types.ts'

const positiveId = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0

const unavailable = (reason: UnavailableReading['reason'], message?: string): UnavailableReading => ({
  kind: 'unavailable',
  reason,
  ...(message ? { message } : {}),
})

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return
  return new Date(value).toISOString()
}

const fresh = (value: number, now: number): boolean => value >= now - 15 * 60 * 1000 && value <= now + 60 * 1000

function period(raw: unknown, now: number, issue?: UnavailableReading): PeriodReading {
  if (issue) return issue
  if (!record(raw) || !finite(raw.utilization) || raw.utilization < 0) return unavailable('missing')
  const resetsAt = timestamp(raw.resetsAt)
  // 当前零值仍有效，但已失效的截止时间不能生成新的周期历史。
  if (raw.utilization === 0 && (!resetsAt || Date.parse(resetsAt) <= now))
    return { kind: 'available', utilization: 0, resetsAt: null }
  if (!resetsAt) return unavailable('reset-pending')
  if (Date.parse(resetsAt) <= now) return unavailable('expired')
  return { kind: 'available', utilization: raw.utilization, resetsAt }
}

function resets(raw: unknown, now: number, error?: string): ResetReading {
  if (error) return unavailable('request', error)
  if (!record(raw)) return unavailable('missing')
  // 重置次数接口的缓存时间使用 Unix 秒，不能按毫秒解释。
  if (raw.fetchedAt !== undefined && (!finite(raw.fetchedAt) || !fresh(raw.fetchedAt * 1000, now)))
    return unavailable('stale')
  const count = raw.availableResetCount
  if (!finite(count) || !Number.isSafeInteger(count) || count < 0) return unavailable('missing')
  const expirations: unknown[] = Array.isArray(raw.resetCreditExpirations) ? raw.resetCreditExpirations : []
  const future = expirations
    .map(timestamp)
    .filter((value): value is string => value !== undefined && Date.parse(value) > now)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  const first = future[0]
  return {
    kind: 'available',
    count,
    ...(count > 0 && first !== undefined
      ? { expiration: { at: first, count: Math.min(count, future.filter(at => at === first).length) } }
      : {}),
  }
}

/**
 * 将周期与重置响应归一化为独立读数，校验数值、缓存新鲜度和重置时间。
 * @param input 未校验的两个响应及各自安全请求错误；缺失或异常值转为不可用状态。
 * @param context 当前 Unix 毫秒时间，默认使用系统时间；缓存接受前 15 分钟至后 1 分钟。
 * @returns 完整的两个周期和重置读数；有效零值不携带失效截止时间。
 */
export function decodeQuotaReadings(
  input: {
    /** 周期用量响应；缺失时两个周期均不可用。 */
    usage?: unknown
    /** 重置次数响应；缺失时次数不可用。 */
    credits?: unknown
    /** 周期查询的安全失败文本，优先于响应读数。 */
    usageError?: string
    /** 重置次数查询的安全失败文本，独立于周期查询。 */
    creditsError?: string
  },
  {
    now = Date.now(),
  }: {
    /** 新鲜度与重置截止判断使用的 Unix 毫秒时间，缺省取系统时间。 */
    now?: number
  } = {},
): QuotaReadings {
  const usage = record(input.usage) ? input.usage : undefined
  let issue = input.usageError ? unavailable('request', input.usageError) : undefined
  if (!issue && usage?.degraded) issue = unavailable('degraded')
  if (!issue && usage?.updatedAt !== undefined) {
    const updatedAt = timestamp(usage.updatedAt)
    if (!updatedAt || !fresh(Date.parse(updatedAt), now)) issue = unavailable('stale')
  }
  return {
    periods: { fiveHour: period(usage?.fiveHour, now, issue), sevenDay: period(usage?.sevenDay, now, issue) },
    resets: resets(input.credits, now, input.creditsError),
  }
}

/**
 * 解析分组并发快照，不将缺失或无效上限解释为无限并发。
 * @param raw 未校验并发对象；undefined 表示未提供。
 * @returns 可用、缺失或不可用的并发领域状态。
 */
export function decodeCapacity(raw: unknown): CapacityReading {
  if (raw === undefined) return { kind: 'missing' }
  if (!record(raw) || !finite(raw.used) || !Number.isSafeInteger(raw.used) || raw.used < 0 || !positiveId(raw.max))
    return unavailable('missing')
  return { kind: 'available', used: raw.used, limit: raw.max }
}

/**
 * 校验一页分组及关联上游，按上游 ID 去重并规范化名称。
 * @param raw 未校验的分组分页响应。
 * @returns 本页分组及服务端声明的非负总数，尚未读取上游指标。
 * @throws 分组身份、名称、上游账号列表或分页信封无效时抛出安全错误。
 */
export function decodeGroupPage(raw: unknown): {
  /** 本页已校验的分组与去重上游来源。 */
  groups: ListedQuotaGroup[]
  /** 服务端声明的分组总数，非负安全整数。 */
  total: number
} {
  if (
    !record(raw) ||
    !Array.isArray(raw.content) ||
    !finite(raw.totalElements) ||
    !Number.isSafeInteger(raw.totalElements) ||
    raw.totalElements < 0
  )
    throw new Error('TET CodePlane 分组列表异常')
  const content: unknown[] = raw.content
  const groups = content.map(item => {
    if (!record(item) || !positiveId(item.id) || typeof item.name !== 'string' || !item.name.trim())
      throw new Error('TET CodePlane 分组数据异常')
    if (!Array.isArray(item.accounts)) throw new Error('TET CodePlane 上游账号列表异常')
    const accounts: unknown[] = item.accounts
    const sources = accounts.map(account => {
      if (!record(account) || !positiveId(account.id)) throw new Error('TET CodePlane 上游账号列表异常')
      return { id: account.id, name: typeof account.name === 'string' ? account.name.trim() : '' }
    })
    return {
      id: item.id,
      name: item.name.trim(),
      accounts: [...new Map(sources.map(source => [source.id, source])).values()],
      capacity: decodeCapacity(item.capacity),
    }
  })
  return { groups, total: raw.totalElements }
}
