const finite = value => typeof value === 'number' && Number.isFinite(value)
const periods = [
  ['fiveHour', '5 hours', 18000],
  ['sevenDay', '7 days', 604800],
]

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return
  return new Date(value).toISOString()
}

/** 分组是共享额度；窗口名称按展示账号区分，避免宿主把它误作独立份额汇总。 */
export function mapManagementUsage(
  { usage, credits, usageError, creditsError },
  { groupName, keyLabel, now = Date.now() },
) {
  const prefix = 'Group ' + groupName + ' · ' + keyLabel
  const windows = []
  const text = (name, display) => windows.push({ name: prefix + ' · ' + name, display, aside: true })
  let usageIssue = usageError
  if (!usageIssue && usage?.degraded) usageIssue = 'Group usage is temporarily incomplete.'
  if (!usageIssue && usage?.updatedAt !== undefined) {
    const updatedAt = timestamp(usage.updatedAt)
    // 管理台缓存超过 15 分钟未更新时，不再把它作为刚读取的新额度历史点。
    if (!updatedAt || Date.parse(updatedAt) < now - 15 * 60 * 1000 || Date.parse(updatedAt) > now + 60 * 1000) {
      usageIssue = 'Group usage reading is stale or has an invalid timestamp.'
    }
  }
  for (const [key, name, span] of periods) {
    const reading = usage?.[key]
    const resetsAt = timestamp(reading?.resetsAt)
    let unavailable = usageIssue
    if (!unavailable && (!finite(reading?.utilization) || reading.utilization < 0)) {
      unavailable = 'Group usage is unavailable.'
    }
    if (!unavailable && !resetsAt) unavailable = 'Waiting for a valid reset time.'
    // 旧窗口过期后不能把它的百分比当成新周期读数，也不能推断已经归零。
    if (!unavailable && Date.parse(resetsAt) <= now) unavailable = 'Waiting for the next cycle reading.'
    if (unavailable) text(name, unavailable)
    else windows.push({ name: prefix + ' · ' + name, used: reading.utilization, span, resetsAt, aside: true })
  }

  const count = credits?.availableResetCount
  let creditsIssue = creditsError
  if (!creditsIssue && credits?.fetchedAt !== undefined) {
    // 重置次数接口使用 Unix 秒；过期缓存不能继续显示为当前可用次数。
    const fetchedAt = finite(credits.fetchedAt) ? credits.fetchedAt * 1000 : NaN
    if (!finite(fetchedAt) || fetchedAt < now - 15 * 60 * 1000 || fetchedAt > now + 60 * 1000) {
      creditsIssue = 'Remaining resets reading is stale or has an invalid timestamp.'
    }
  }
  if (creditsIssue) text('Resets', creditsIssue)
  else if (!Number.isSafeInteger(count) || count < 0) text('Resets', 'Remaining resets are unavailable.')
  else {
    text('Resets', count.toLocaleString('en-US') + ' remaining')
    const future = (Array.isArray(credits.resetCreditExpirations) ? credits.resetCreditExpirations : [])
      .map(timestamp)
      .filter(value => value && Date.parse(value) > now)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    if (count > 0 && future.length) text('Next reset credit expiry', future[0])
  }
  return windows
}
