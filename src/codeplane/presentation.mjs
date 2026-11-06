const finite = value => typeof value === 'number' && Number.isFinite(value)
const PERIODS = [
  ['fiveHour', '5 hours', 18000],
  ['sevenDay', '7 days', 604800],
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

const text = (name, display) => ({ name, display, aside: true })

function quotaReadings({ usage, credits, usageError, creditsError }, { now = Date.now() } = {}) {
  const windows = []
  let usageIssue = usageError
  if (!usageIssue && usage?.degraded) usageIssue = '部分数据暂不可用'
  if (!usageIssue && usage?.updatedAt !== undefined) {
    const updatedAt = timestamp(usage.updatedAt)
    // TET CodePlane 缓存超过 15 分钟未更新时，不再把它作为刚读取的新额度历史点。
    if (!updatedAt || Date.parse(updatedAt) < now - 15 * 60 * 1000 || Date.parse(updatedAt) > now + 60 * 1000) {
      usageIssue = '数据待更新'
    }
  }
  for (const [key, name, span] of PERIODS) {
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
    if (unavailable) windows.push(text(name, unavailable))
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
  let resets
  if (creditsIssue) resets = text('重置次数', creditsIssue)
  else if (!Number.isSafeInteger(count) || count < 0) resets = text('重置次数', '暂无数据')
  else {
    resets = text('重置次数', count.toLocaleString('en-US') + ' 次')
    const future = (Array.isArray(credits.resetCreditExpirations) ? credits.resetCreditExpirations : [])
      .map(timestamp)
      .filter(value => value && Date.parse(value) > now)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
    if (count > 0 && future.length) {
      resets.runsOutAt = future[0]
      resets.runsOut = Math.min(count, future.filter(at => at === future[0]).length)
      resets.unit = '次'
    }
  }
  return { periods: windows, resets }
}

function capacityReading(capacity, error) {
  if (error) return text('并发', error)
  if (capacity === undefined) return
  if (
    !Number.isSafeInteger(capacity?.used) ||
    capacity.used < 0 ||
    !Number.isSafeInteger(capacity?.max) ||
    capacity.max <= 0
  ) {
    return text('并发', '暂无数据')
  }
  return text('并发', capacity.used.toLocaleString('en-US') + ' / ' + capacity.max.toLocaleString('en-US'))
}

/** TET CodePlane 指标仅供展示，不参与 Key 的路由额度判断。 */
export function mapCodePlaneUsage(data, context = {}) {
  const mapped = quotaReadings(data, context)
  const capacity = capacityReading(data.capacity, data.capacityError)
  return [...mapped.periods, mapped.resets, ...(capacity ? [capacity] : [])]
}

/** 宿主只有扁平双列；多来源通过指标名称区分，不伪造钱包账号或合计共享额度。 */
export function presentCodePlaneUsage(usage, codePlane) {
  if (!codePlane) return usage
  const text = display => ({ name: '分组', display, aside: true })
  if (codePlane.error) return { ...usage, windows: [...usage.windows, text(codePlane.error)] }
  if (!codePlane.groups.length) return { ...usage, windows: [...usage.windows, text('暂无可见分组')] }
  const groups = [...codePlane.groups].sort((a, b) => a.id - b.id)
  const groupLabels = sourceLabels(groups, id => '分组 ' + id)
  const windows = []
  for (const group of groups) {
    // 同名分组仍需区分；单分组正常路径不展示任何内部编号。
    const groupName = groupLabels.get(group.id)
    const prefix = groups.length === 1 ? '' : groupName + ' · '
    const accounts = [...group.accounts].sort((a, b) => a.id - b.id)
    const capacity = capacityReading(group.capacity ?? null)
    if (!accounts.length) {
      windows.push({ name: prefix + '周期额度', display: '暂无额度来源', aside: true })
      windows.push({ ...capacity, name: prefix + '并发' })
      continue
    }
    if (accounts.length === 1) {
      const mapped = quotaReadings(accounts[0])
      windows.push(
        ...mapped.periods.map(window => ({
          ...window,
          // 与真实 Key 周期同名时保留来源，避免宿主把两类额度合并。
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
        const mapped = quotaReadings(account)
        return {
          periods: mapped.periods.map(window => ({ ...window, name: source + window.name })),
          resets: { ...mapped.resets, name: source + mapped.resets.name },
        }
      })
      windows.push(...sources.flatMap(source => source.periods))
      windows.push({ ...capacity, name: prefix + '并发' })
      windows.push(...sources.map(source => source.resets))
      if (accounts.length % 2 === 0) {
        windows.push({ name: prefix + '额度来源', display: accounts.length + ' 个', aside: true })
      }
    }
  }
  const source = groups.map(group => groupLabels.get(group.id)).join('、')
  const leading = [...usage.windows]
  // Key 指标为奇数时补充真实来源概览，使后续周期从新行开始。
  if (leading.length % 2) leading.push(text(source))
  return {
    ...usage,
    windows: [...leading, ...windows],
  }
}
