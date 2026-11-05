const finite = value => typeof value === 'number' && Number.isFinite(value)
const periods = [
  ['fiveHour', '5h', 18000],
  ['sevenDay', '7d', 604800],
]

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return
  return new Date(value).toISOString()
}

/** 窗口只承担指标展示；共享额度来源放在账号头部，避免逐项重复技术标识。 */
export function mapManagementUsage(
  { usage, credits, usageError, creditsError, capacity, capacityError },
  { now = Date.now() } = {},
) {
  const windows = []
  const text = (name, display) => windows.push({ name, display, aside: true })
  let usageIssue = usageError
  if (!usageIssue && usage?.degraded) usageIssue = '部分数据暂不可用'
  if (!usageIssue && usage?.updatedAt !== undefined) {
    const updatedAt = timestamp(usage.updatedAt)
    // 管理台缓存超过 15 分钟未更新时，不再把它作为刚读取的新额度历史点。
    if (!updatedAt || Date.parse(updatedAt) < now - 15 * 60 * 1000 || Date.parse(updatedAt) > now + 60 * 1000) {
      usageIssue = '数据待更新'
    }
  }
  for (const [key, name, span] of periods) {
    const reading = usage?.[key]
    const resetsAt = timestamp(reading?.resetsAt)
    let unavailable = usageIssue
    if (!unavailable && (!finite(reading?.utilization) || reading.utilization < 0)) {
      unavailable = '暂无数据'
    }
    // 上游明确报告的当前零值有效；旧截止时间仅表示倒计时已失效，不能把零值也隐藏。
    if (!unavailable && reading.utilization === 0 && (!resetsAt || Date.parse(resetsAt) <= now)) {
      windows.push({ name, used: 0, aside: true })
      continue
    }
    if (!unavailable && !resetsAt) unavailable = '重置时间待更新'
    // 旧窗口过期后不能把它的百分比当成新周期读数，也不能推断已经归零。
    if (!unavailable && Date.parse(resetsAt) <= now) unavailable = '等待新周期数据'
    if (unavailable) text(name, unavailable)
    else windows.push({ name, used: reading.utilization, span, resetsAt, aside: true })
  }

  const count = credits?.availableResetCount
  let creditsIssue = creditsError
  if (!creditsIssue && credits?.fetchedAt !== undefined) {
    // 重置次数接口使用 Unix 秒；过期缓存不能继续显示为当前可用次数。
    const fetchedAt = finite(credits.fetchedAt) ? credits.fetchedAt * 1000 : NaN
    if (!finite(fetchedAt) || fetchedAt < now - 15 * 60 * 1000 || fetchedAt > now + 60 * 1000) {
      creditsIssue = '次数待更新'
    }
  }
  if (creditsIssue) text('可用重置', creditsIssue)
  else if (!Number.isSafeInteger(count) || count < 0) text('可用重置', '暂无数据')
  else {
    const resets = { name: '可用重置', display: count.toLocaleString('en-US') + ' 次', aside: true }
    const future = (Array.isArray(credits.resetCreditExpirations) ? credits.resetCreditExpirations : [])
      .map(timestamp)
      .filter(value => value && Date.parse(value) > now)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    if (count > 0 && future.length) {
      resets.runsOutAt = future[0]
      resets.runsOut = Math.min(count, future.filter(at => at === future[0]).length)
      resets.unit = '次'
    }
    windows.push(resets)
  }
  if (capacityError) text('分组并发', capacityError)
  else if (capacity !== undefined) {
    if (
      !Number.isSafeInteger(capacity?.used) ||
      capacity.used < 0 ||
      !Number.isSafeInteger(capacity?.max) ||
      capacity.max <= 0
    ) {
      text('分组并发', '暂无数据')
    } else {
      windows.push({
        name: '分组并发',
        amount: capacity.used,
        limit: capacity.max,
        used: (capacity.used / capacity.max) * 100,
        aside: true,
      })
    }
  }
  return windows
}

/** 原生双列按额度、消费、运行信息成对排列；不同上游额度通过 plan 分隔而不混算。 */
export function presentManagementUsage(usage, windows, binding) {
  if (!windows.length) return usage
  const periods = windows.filter(window => window.name === '5h' || window.name === '7d')
  const details = windows.filter(window => !periods.includes(window))
  const concurrency = details.find(window => window.name === '分组并发')
  const limits = usage.windows.filter(window => !window.aside)
  const statistics = usage.windows.filter(window => window.aside)
  const source =
    typeof binding?.groupName === 'string' && Number.isSafeInteger(binding.accountId)
      ? [
          (limits.length || usage.until) && usage.plan !== 'TET' ? usage.plan : '',
          binding.groupName,
          '上游 ' + binding.accountId,
        ]
          .filter(Boolean)
          .join(' · ')
      : usage.plan
  return {
    ...usage,
    plan: source,
    windows: concurrency
      ? [...limits, ...periods, concurrency, ...details.filter(window => window !== concurrency), ...statistics]
      : [...limits, ...periods, ...statistics, ...details],
  }
}
