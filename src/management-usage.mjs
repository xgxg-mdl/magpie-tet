const finite = value => typeof value === 'number' && Number.isFinite(value)
const periods = [
  ['fiveHour', '5h', 18000],
  ['sevenDay', '7d', 604800],
]

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return
  return new Date(value).toISOString()
}

/** 可读名称也可能恰好等于另一个来源的回退名称，必须对最终标签去重。 */
function sourceLabels(items, fallback) {
  // 中点只用于层级分隔，避免分组“X · Y”与分组 X 下的来源 Y 生成同一路径。
  const candidates = items.map(item => (item.name || fallback(item.id)).replaceAll('·', '/'))
  const assigned = new Set()
  return new Map(
    items.map((item, index) => {
      let label = candidates[index]
      while (assigned.has(label) || candidates.some((other, position) => position !== index && other === label)) {
        label += ' #' + item.id
      }
      assigned.add(label)
      return [item.id, label]
    }),
  )
}

/** 管理台指标仅供展示，不参与 Key 的路由额度判断。 */
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
  if (capacityError) text('并发', capacityError)
  else if (capacity !== undefined) {
    if (
      !Number.isSafeInteger(capacity?.used) ||
      capacity.used < 0 ||
      !Number.isSafeInteger(capacity?.max) ||
      capacity.max <= 0
    ) {
      text('并发', '暂无数据')
    } else {
      windows.push({
        name: '并发',
        amount: capacity.used,
        limit: capacity.max,
        used: (capacity.used / capacity.max) * 100,
        aside: true,
      })
    }
  }
  return windows
}

/** 宿主只有扁平双列；多来源通过指标名称区分，不伪造钱包账号或合计共享额度。 */
export function presentManagementUsage(usage, management) {
  if (!management) return usage
  const text = display => ({ name: '管理台分组', display, aside: true })
  if (management.error) return { ...usage, windows: [...usage.windows, text(management.error)] }
  if (!management.groups.length) return { ...usage, windows: [...usage.windows, text('暂无可见分组')] }
  const groups = [...management.groups].sort((a, b) => a.id - b.id)
  const groupLabels = sourceLabels(groups, id => '分组 ' + id)
  const windows = []
  for (const group of groups) {
    // 同名分组仍需区分；单分组正常路径不展示任何内部编号。
    const groupName = groupLabels.get(group.id)
    const prefix = groups.length > 1 ? groupName + ' · ' : ''
    const accounts = [...group.accounts].sort((a, b) => a.id - b.id)
    const capacity = mapManagementUsage({ capacity: group.capacity ?? null }).find(window => window.name === '并发')
    windows.push({ ...capacity, name: prefix + '并发' })
    if (!accounts.length) {
      windows.push({ name: prefix + '周期额度', display: '暂无额度来源', aside: true })
      continue
    }
    if (accounts.length === 1) {
      const mapped = mapManagementUsage(accounts[0])
      windows.push({ ...mapped[2], name: prefix + mapped[2].name })
      windows.push(...mapped.slice(0, 2).map(window => ({ ...window, name: prefix + window.name })))
    } else {
      const accountLabels = sourceLabels(accounts, id => '上游 ' + id)
      const sources = accounts.map(account => {
        const source = prefix + accountLabels.get(account.id) + ' · '
        return mapManagementUsage(account).map(window => ({ ...window, name: source + window.name }))
      })
      // 首个来源次数与并发配对；周期始终两两排列，其余次数分别展示，不计算合计。
      windows.push(sources[0][2])
      windows.push(...sources.flatMap(source => source.slice(0, 2)))
      windows.push(...sources.slice(1).map(source => source[2]))
      if (accounts.length % 2 === 0) {
        windows.push({ name: prefix + '额度来源', display: accounts.length + ' 个', aside: true })
      }
    }
  }
  const source = groups.length === 1 ? groups[0].name : groups.length + ' 个分组'
  const leading = usage.windows.filter(window => window.name !== 'Usage')
  // 用真实来源说明填满前面余下的一列，防止单项消费或 Key 限额使后续周期跨行。
  if (leading.length % 2) leading.push(text(source))
  return {
    ...usage,
    plan: [usage.plan !== 'TET' ? usage.plan : '', '管理台 · ' + source].filter(Boolean).join(' · '),
    windows: [...leading, ...windows, ...usage.windows.filter(window => window.name === 'Usage')],
  }
}
