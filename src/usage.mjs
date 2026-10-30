const finite = value => typeof value === 'number' && Number.isFinite(value)
const money = (value, unit) => value.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + unit
const spans = { '5h': 18000, '1d': 86400, '7d': 604800 }
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined

/** 账户钱包与密钥消费属于不同范围；只有上游提供真实限额才生成可影响路由的窗口。 */
export function mapUsage(data, { showTraffic = true } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.isValid !== 'boolean') {
    throw new Error('TET returned an invalid usage response.')
  }
  if (!data.isValid) return { error: 'TET API key is invalid. Sign in again.', signIn: 'expired', windows: [] }
  const result = { plan: typeof data.planName === 'string' && data.planName ? data.planName : 'TET', windows: [] }
  const unit = typeof data.unit === 'string' ? data.unit : 'USD'
  const sub = data.subscription && typeof data.subscription === 'object' && !Array.isArray(data.subscription) ? data.subscription : undefined
  const periods = [['daily', 'Daily', 86400], ['weekly', 'Weekly', 604800], ['monthly', 'Monthly', undefined]]
  const hasSubscription = sub && (timestamp(sub.expires_at) || periods.some(([period]) => finite(sub[period + '_limit_usd']) && sub[period + '_limit_usd'] > 0))
  const addLimit = (name, used, limit, extra = {}) => {
    if (!finite(limit) || limit <= 0) return
    /** 宿主会把缺少 amount 的数值窗口归零，未知用量必须用纯展示窗口表达。 */
    if (!finite(used) || used < 0) {
      result.windows.push({ name, display: 'Limit ' + money(limit, unit) + ' · usage unavailable', ...extra })
      return
    }
    result.windows.push({ name, limit, unit, amount: used, ...extra })
  }
  if (data.mode === 'quota_limited') {
    addLimit('API key quota', data.quota?.used, data.quota?.limit)
    for (const window of Array.isArray(data.rate_limits) ? data.rate_limits : []) {
      if (!window || typeof window.window !== 'string') continue
      addLimit(window.window, window.used, window.limit, {
        ...(spans[window.window] ? { span: spans[window.window] } : {}),
        ...(timestamp(window.reset_at) ? { resetsAt: window.reset_at } : {}),
      })
    }
    if (data.status === 'expired') result.error = 'API key has expired.'
    if (data.status === 'quota_exhausted') result.error = 'API key quota is exhausted.'
  } else if (hasSubscription) {
    for (const [period, name, span] of periods) {
      const resetsAt = timestamp(sub[period + '_reset_at'])
      addLimit(name, sub[period + '_usage_usd'], sub[period + '_limit_usd'], {
        ...(span ? { span } : {}), ...(resetsAt ? { resetsAt } : {}),
      })
    }
    if (timestamp(sub.expires_at)) result.until = sub.expires_at
  } else if (finite(data.balance)) {
    result.balance = money(data.balance, unit)
    result.windows.push({ name: 'Wallet', balance: data.balance, unit })
  } else {
    result.error = 'TET did not report a wallet or an active subscription.'
  }
  /** 密钥与订阅分别约束可用性，较晚的到期时间不能掩盖另一项已到期。 */
  const keyExpiry = timestamp(data.expires_at)
  if (keyExpiry && (!result.until || Date.parse(keyExpiry) < Date.parse(result.until))) result.until = keyExpiry
  if (result.until && Date.parse(result.until) <= Date.now()) result.error = 'The API key or subscription has expired.'
  for (const [key, name] of [['today', 'Today'], ['total', 'Total']]) {
    const stats = data.usage?.[key]
    const cost = finite(stats?.actual_cost) ? stats.actual_cost : stats?.cost
    if (!finite(cost)) continue
    const details = [money(cost, unit)]
    if (showTraffic && finite(stats.requests)) details.push(stats.requests.toLocaleString('en-US') + ' requests')
    if (showTraffic && finite(stats.total_tokens)) details.push(stats.total_tokens.toLocaleString('en-US') + ' tokens')
    result.windows.push({ name, display: details.join(' · '), aside: true })
  }
  if (showTraffic && (finite(data.usage?.rpm) || finite(data.usage?.tpm))) {
    const parts = []
    if (finite(data.usage.rpm)) parts.push(data.usage.rpm.toLocaleString('en-US') + ' RPM')
    if (finite(data.usage.tpm)) parts.push(data.usage.tpm.toLocaleString('en-US') + ' TPM')
    result.windows.push({ name: 'Traffic', display: parts.join(' · '), aside: true })
  }
  return result
}
