import type { GatewayUsage, Allowance } from '../gateway/types.ts'
import type { UsageResult, UsageWindow } from './types.ts'

const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format
const rates: Readonly<Record<string, { name: string; span: number }>> = {
  '5h': { name: '5 hours', span: 18000 },
  '1d': { name: '1 day', span: 86400 },
  '7d': { name: '7 days', span: 604800 },
}
const subscriptions: Readonly<Record<string, { name: string; span?: number }>> = {
  daily: { name: '1 day', span: 86400 },
  weekly: { name: 'Weekly', span: 604800 },
  monthly: { name: 'Monthly' },
}

/** 只格式化展示值；不足一分的非零金额用边界表示，避免误报为零。 */
function money(value: number, unit: string): string {
  const small = value !== 0 && Math.abs(value) < 0.01
  const amount = small ? (value < 0 ? -0.01 : 0.01) : value === 0 ? 0 : value
  const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + unit
  return (small ? (value < 0 ? '>' : '<') : '') + formatted
}

function window(value: Allowance, unit: string): UsageWindow {
  const period =
    value.kind === 'subscription'
      ? subscriptions[value.period]
      : Object.hasOwn(rates, value.period)
        ? rates[value.period]
        : undefined
  const name = value.kind === 'key-quota' ? 'API key quota' : (period?.name ?? value.period)
  const extra = {
    ...(period?.span ? { span: period.span } : {}),
    ...(value.resetsAt ? { resetsAt: value.resetsAt } : {}),
  }
  // 宿主会将缺少 amount 的数值窗口归零，未知用量使用纯展示窗口。
  if (value.used === undefined)
    return { name, display: 'Limit ' + money(value.limit, unit) + ' · usage unavailable', ...extra }
  return { name, limit: value.limit, unit, amount: value.used, used: (value.used / value.limit) * 100, ...extra }
}

/**
 * 将网关领域用量转换为宿主钱包、真实限额和辅助统计。
 *
 * 金额只在展示时格式化，额度原始数值保持精度；未知用量不补零。
 * Key 失效返回登录提示，业务到期或额度耗尽只设置用量错误。
 *
 * @param data 已校验并归一化的网关用量。
 * @param options 展示选项；showTraffic 缺省为 true，控制流量和实时速率。
 * @returns 新建的宿主用量快照，不修改领域输入。
 */
export function presentGatewayUsage(
  data: GatewayUsage,
  {
    showTraffic = true,
  }: {
    /** 是否展示请求数、Token 和实时速率；缺省开启。 */
    showTraffic?: boolean
  } = {},
): UsageResult {
  if (data.kind === 'invalid-key')
    return { error: 'TET API key is invalid. Sign in again.', signIn: 'expired', windows: [] }
  const result: UsageResult = { plan: data.plan, windows: data.allowances.map(value => window(value, data.unit)) }
  if (data.wallet !== undefined) result.balance = money(data.wallet, data.unit)
  if (data.missingAccountUsage) result.error = 'TET did not report a wallet or an active subscription.'
  if (data.quotaStatus === 'expired') result.error = 'API key has expired.'
  if (data.quotaStatus === 'quota-exhausted') result.error = 'API key quota is exhausted.'
  if (data.expiresAt) {
    result.until = data.expiresAt
    if (Date.parse(data.expiresAt) <= Date.now()) result.error = 'The API key or subscription has expired.'
  }
  for (const [key, name] of [
    ['today', 'Today'],
    ['total', 'Total'],
  ] satisfies ['today' | 'total', string][]) {
    const stats = data.stats[key]
    if (!stats) continue
    const details = [money(stats.cost, data.unit)]
    const traffic: string[] = []
    if (showTraffic && stats.requests !== undefined) traffic.push(compactCount(stats.requests) + ' req')
    if (showTraffic && stats.tokens !== undefined) traffic.push(compactCount(stats.tokens) + ' tok')
    // 宿主只显示两段，所有流量明细放在同一段。
    if (traffic.length) details.push(traffic.join(' / '))
    result.windows.push({ name, display: details.join(' · '), aside: true })
  }
  if (showTraffic && (data.stats.rpm !== undefined || data.stats.tpm !== undefined)) {
    const parts: string[] = []
    if (data.stats.rpm !== undefined) parts.push(compactCount(data.stats.rpm) + ' RPM')
    if (data.stats.tpm !== undefined) parts.push(compactCount(data.stats.tpm) + ' TPM')
    result.windows.push({ name: '实时速率', display: parts.join(' · '), aside: true })
  }
  return result
}
