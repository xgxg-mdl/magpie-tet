import type { UsageResult, UsageWindow } from './types.ts'
import type {
  CapacityReading,
  CodePlaneResult,
  PeriodReading,
  QuotaReadings,
  UnavailableReading,
} from '../codeplane/types.ts'

const PERIODS = [
  ['fiveHour', '5 hours', 18000],
  ['sevenDay', '7 days', 604800],
] as const
const text = (name: string, display: string): UsageWindow => ({ name, display, aside: true })

function unavailableText(reading: UnavailableReading, metric: 'period' | 'resets' | 'capacity'): string {
  if (reading.reason === 'request') return reading.message ?? 'TET CodePlane 服务异常'
  if (reading.reason === 'degraded') return '部分数据暂不可用'
  if (reading.reason === 'stale') return metric === 'resets' ? '次数待更新' : '数据待更新'
  if (reading.reason === 'reset-pending') return '重置时间待更新'
  if (reading.reason === 'expired') return '等待新周期数据'
  return '暂无数据'
}

/** 可读名称也可能恰好等于另一个来源的回退名称，必须对最终标签去重。 */
function sourceLabels(items: { id: number; name: string }[], fallback: (id: number) => string): Map<number, string> {
  const candidates = items.map(item => (item.name || fallback(item.id)).replaceAll('·', '/'))
  const assigned = new Set<string>()
  return new Map(
    items.map((item, index) => {
      let label = candidates[index] ?? fallback(item.id)
      while (assigned.has(label) || candidates.some((other, position) => position !== index && other === label))
        label += ' #' + item.id
      assigned.add(label)
      return [item.id, label]
    }),
  )
}

function periodWindow(reading: PeriodReading, name: string, span: number): UsageWindow {
  if (reading.kind === 'unavailable') return text(name, unavailableText(reading, 'period'))
  return {
    name,
    used: reading.utilization,
    aside: true,
    ...(reading.resetsAt === null ? {} : { resetsAt: reading.resetsAt, span }),
  }
}

function quotaWindows(readings: QuotaReadings): { periods: UsageWindow[]; resets: UsageWindow } {
  const periods = PERIODS.map(([key, name, span]) => periodWindow(readings.periods[key], name, span))
  const reading = readings.resets
  if (reading.kind === 'unavailable') return { periods, resets: text('重置次数', unavailableText(reading, 'resets')) }
  return {
    periods,
    resets: {
      ...text('重置次数', reading.count.toLocaleString('en-US') + ' 次'),
      ...(reading.expiration
        ? { runsOutAt: reading.expiration.at, runsOut: reading.expiration.count, unit: '次' }
        : {}),
    },
  }
}

function capacityWindow(capacity: CapacityReading): UsageWindow {
  if (capacity.kind === 'missing') return text('并发', '暂无数据')
  if (capacity.kind === 'unavailable') return text('并发', unavailableText(capacity, 'capacity'))
  return text('并发', capacity.used.toLocaleString('en-US') + ' / ' + capacity.limit.toLocaleString('en-US'))
}

/**
 * 将当前账号可见的分组与上游共享额度追加到网关用量。
 *
 * 宿主使用扁平双列；名称区分来源并保持周期成对排列，不累加共享百分比。
 * 失败和空分组作为辅助状态展示，不覆盖已有钱包、方案与网关窗口。
 *
 * @param usage 已生成的网关宿主用量。
 * @param codePlane 共享额度快照；null 表示当前登录不读取 CodePlane。
 * @returns 无共享快照时返回原对象，否则返回追加窗口的新对象。
 */
export function presentCodePlaneUsage(usage: UsageResult, codePlane: CodePlaneResult | null): UsageResult {
  if (!codePlane) return usage
  const groupText = (display: string): UsageWindow => text('分组', display)
  if ('error' in codePlane) return { ...usage, windows: [...usage.windows, groupText(codePlane.error)] }
  if (!codePlane.groups.length) return { ...usage, windows: [...usage.windows, groupText('暂无可见分组')] }
  const groups = [...codePlane.groups].sort((a, b) => a.id - b.id)
  const groupLabels = sourceLabels(groups, id => '分组 ' + id)
  const windows: UsageWindow[] = []
  for (const group of groups) {
    const groupName = groupLabels.get(group.id) ?? group.name
    const prefix = groups.length === 1 ? '' : groupName + ' · '
    const accounts = [...group.accounts].sort((a, b) => a.id - b.id)
    const capacity = capacityWindow(group.capacity)
    if (!accounts.length) {
      windows.push({ name: prefix + '周期额度', display: '暂无额度来源', aside: true })
      windows.push({ ...capacity, name: prefix + '并发' })
      continue
    }
    const account = accounts[0]
    if (accounts.length === 1 && account) {
      const mapped = quotaWindows(account.readings)
      windows.push(
        ...mapped.periods.map(window => ({
          ...window,
          name:
            !prefix && usage.windows.some(keyWindow => keyWindow.name === window.name)
              ? groupName + ' · ' + window.name
              : prefix + window.name,
        })),
      )
      windows.push({ ...capacity, name: prefix + '并发' })
      windows.push({ ...mapped.resets, name: prefix + mapped.resets.name })
    } else {
      const accountLabels = sourceLabels(accounts, id => '上游 ' + id)
      const sources = accounts.map(account => {
        const source = prefix + accountLabels.get(account.id) + ' · '
        const mapped = quotaWindows(account.readings)
        return {
          periods: mapped.periods.map(window => ({ ...window, name: source + window.name })),
          resets: { ...mapped.resets, name: source + mapped.resets.name },
        }
      })
      windows.push(...sources.flatMap(source => source.periods))
      windows.push({ ...capacity, name: prefix + '并发' })
      windows.push(...sources.map(source => source.resets))
      if (accounts.length % 2 === 0)
        windows.push({ name: prefix + '额度来源', display: accounts.length + ' 个', aside: true })
    }
  }
  const source = groups.map(group => groupLabels.get(group.id)).join('、')
  const leading = [...usage.windows]
  // Key 指标为奇数时补充真实来源概览，使后续周期从新行开始。
  if (leading.length % 2) leading.push(groupText(source))
  return { ...usage, windows: [...leading, ...windows] }
}
