import { expect, test } from 'bun:test'
import { mapManagementUsage, presentManagementUsage } from '../src/management-usage.mjs'

const now = Date.parse('2030-01-01T00:00:00Z')
const soon = '2030-01-01T05:00:00.000Z'
const later = '2030-01-08T00:00:00.000Z'
const context = { now }
const usage = { fiveHour: { utilization: 0, resetsAt: soon }, sevenDay: { utilization: 100, resetsAt: later } }

test('concurrency preserves zero, full and over-capacity snapshots as display-only progress', () => {
  for (const used of [0, 2, 10, 12]) {
    const windows = mapManagementUsage({ capacity: { used, max: 10 } }, context)
    expect(windows.at(-1)).toEqual({ name: '并发', amount: used, limit: 10, used: used * 10, aside: true })
  }
})

test('unknown and invalid concurrency never appear as available capacity', () => {
  for (const capacity of [
    null,
    {},
    { used: -1, max: 10 },
    { used: 0, max: 0 },
    { used: '2', max: 10 },
    { used: 1.5, max: 10 },
  ]) {
    expect(mapManagementUsage({ capacity }, context).at(-1)).toEqual({
      name: '并发',
      display: '暂无数据',
      aside: true,
    })
  }
})

test('an explicitly reported current zero remains visible after the old reset time passed', () => {
  const windows = mapManagementUsage(
    {
      usage: {
        fiveHour: { utilization: 0, resetsAt: '2029-12-31T23:59:59Z', remainingSeconds: 0 },
        updatedAt: '2030-01-01T00:00:00Z',
      },
    },
    context,
  )
  expect(windows[0].used).toBe(0)
  expect(windows[0].display).toBeUndefined()
  expect(windows[0].resetsAt).toBeUndefined()
  expect(windows[0].span).toBeUndefined()
  expect(windows[0].aside).toBe(true)
})

test('group windows preserve measured zero and full readings without affecting routing', () => {
  const windows = mapManagementUsage({ usage, credits: { availableResetCount: 0 } }, context)
  expect(windows).toEqual([
    { name: '5h', used: 0, span: 18000, resetsAt: soon, aside: true },
    { name: '7d', used: 100, span: 604800, resetsAt: later, aside: true },
    { name: '可用重置', display: '0 次', aside: true },
  ])
  expect(windows.every(window => window.amount === undefined && window.limit === undefined)).toBe(true)
})

test('invalid readings remain unknown instead of becoming zero', () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity, '12']) {
    const windows = mapManagementUsage(
      {
        usage: { ...usage, fiveHour: { utilization: invalid, resetsAt: soon } },
        credits: { availableResetCount: invalid },
      },
      context,
    )
    expect(windows[0].used).toBeUndefined()
    expect(windows[0].display).toBe('暂无数据')
    expect(windows[1].used).toBe(100)
    expect(windows[2].display).toBe('暂无数据')
  }
  expect(mapManagementUsage({ credits: { availableResetCount: 1.5 } }, context)[2].display).toBe('暂无数据')
  const over = mapManagementUsage({ usage: { ...usage, fiveHour: { utilization: 125, resetsAt: soon } } }, context)
  expect(over[0].used).toBe(125)
})

test('missing, malformed and expired reset times never create current-cycle readings', () => {
  for (const resetsAt of [undefined, 'invalid', '2029-12-31T23:59:59Z', '2030-01-01T00:00:00Z']) {
    const windows = mapManagementUsage({ usage: { ...usage, fiveHour: { utilization: 50, resetsAt } } }, context)
    expect(windows[0].used).toBeUndefined()
    expect(windows[0].resetsAt).toBeUndefined()
    expect(['重置时间待更新', '等待新周期数据']).toContain(windows[0].display)
    expect(windows[1].used).toBe(100)
  }
  const normalized = mapManagementUsage(
    { usage: { ...usage, fiveHour: { utilization: 50, resetsAt: '2030-01-01T13:00:00+08:00' } } },
    context,
  )
  expect(normalized[0].resetsAt).toBe(soon)
})

test('partial query failures do not hide independent group data', () => {
  const creditsFailed = mapManagementUsage({ usage, creditsError: '管理台登录已过期' }, context)
  expect(creditsFailed[0].used).toBe(0)
  expect(creditsFailed[1].used).toBe(100)
  expect(creditsFailed[2].display).toBe('管理台登录已过期')
  const usageFailed = mapManagementUsage(
    { usageError: '管理台查询超时或连接失败', credits: { availableResetCount: 2 } },
    context,
  )
  expect(usageFailed.slice(0, 2).every(window => window.display === '管理台查询超时或连接失败')).toBe(true)
  expect(usageFailed[2].display).toBe('2 次')
})

test('degraded group responses do not produce misleading history points', () => {
  const windows = mapManagementUsage(
    { usage: { ...usage, degraded: true }, credits: { availableResetCount: 1 } },
    context,
  )
  expect(windows.slice(0, 2).every(window => window.used === undefined && window.display === '部分数据暂不可用')).toBe(
    true,
  )
  expect(windows[2].display).toBe('1 次')
})

test('stale, future and invalid timestamps do not become fresh quota history points', () => {
  for (const updatedAt of ['2029-12-31T23:44:59Z', '2030-01-01T00:01:01Z', 'invalid', null]) {
    const windows = mapManagementUsage({ usage: { ...usage, updatedAt }, credits: { availableResetCount: 0 } }, context)
    expect(windows.slice(0, 2).every(window => window.used === undefined && window.display === '数据待更新')).toBe(true)
    expect(windows[2].display).toBe('0 次')
  }
  for (const updatedAt of [undefined, '2029-12-31T23:45:00Z', '2030-01-01T00:01:00Z']) {
    const windows = mapManagementUsage({ usage: { ...usage, updatedAt } }, context)
    expect(windows[0].used).toBe(0)
    expect(windows[1].used).toBe(100)
  }
})

test('reset counts require a fresh Unix-second timestamp when fetchedAt is provided', () => {
  const seconds = now / 1000
  for (const fetchedAt of [
    seconds - 901,
    seconds + 61,
    seconds * 1000,
    null,
    'invalid',
    String(seconds),
    NaN,
    Infinity,
  ]) {
    const windows = mapManagementUsage(
      { usage, credits: { availableResetCount: 2, resetCreditExpirations: [soon], fetchedAt } },
      context,
    )
    expect(windows[0].used).toBe(0)
    expect(windows[1].used).toBe(100)
    expect(windows[2].display).toBe('次数待更新')
    expect(windows).toHaveLength(3)
  }
  for (const fetchedAt of [undefined, seconds, seconds - 900, seconds + 60]) {
    const windows = mapManagementUsage({ usage, credits: { availableResetCount: 0, fetchedAt } }, context)
    expect(windows[2].display).toBe('0 次')
  }
})

test('reset expiry selects only the nearest valid future credit and respects zero counts', () => {
  const credits = {
    availableResetCount: 3,
    resetCreditExpirations: [later, 'invalid', '2029-12-31T23:59:59Z', soon],
  }
  const windows = mapManagementUsage({ usage, credits }, context)
  expect(windows.at(-1)).toEqual({
    name: '可用重置',
    display: '3 次',
    runsOutAt: soon,
    runsOut: 1,
    unit: '次',
    aside: true,
  })
  expect(mapManagementUsage({ usage, credits: { ...credits, availableResetCount: 0 } }, context)).toHaveLength(3)
  expect(
    mapManagementUsage({ usage, credits: { ...credits, resetCreditExpirations: ['invalid'] } }, context),
  ).toHaveLength(3)
})

test('presentation pairs periods, costs and operational metrics without repeated technical labels', () => {
  const normal = {
    plan: 'Wallet',
    balance: '12.00 USD',
    windows: [
      { name: 'Today', display: '$1.00 · req 2', aside: true },
      { name: 'Total', display: '$3.00 · req 4', aside: true },
      { name: 'Usage', display: '1 RPM · 2 TPM', aside: true },
    ],
  }
  const management = {
    groups: [
      {
        id: 7,
        name: '海能发',
        capacity: { used: 2, max: 10 },
        accounts: [
          {
            id: 5,
            usage,
            credits: { availableResetCount: 1, resetCreditExpirations: [soon] },
          },
        ],
      },
    ],
  }
  const shown = presentManagementUsage(normal, management)
  expect(shown.windows.map(window => window.name)).toEqual(['Today', 'Total', '并发', '可用重置', '5h', '7d', 'Usage'])
  expect(shown.windows).toHaveLength(7)
  expect(shown.plan).toBe('Wallet · 管理台 · 海能发')
  expect(shown.windows.every(window => !window.name.includes('海能发'))).toBe(true)
  expect(shown.balance).toBe('12.00 USD')
  expect(shown.windows[3].runsOutAt).toBe(soon)
  expect(shown.windows[3].runsOut).toBe(1)
  expect(presentManagementUsage(normal, null)).toBe(normal)
})

test('real key limits stay distinct and visible ahead of display-only group periods', () => {
  const normal = {
    plan: 'Pro',
    windows: [
      { name: '5 hours', amount: 1, limit: 10, used: 10, unit: 'USD' },
      { name: 'Today', display: '$1.00', aside: true },
    ],
  }
  const shown = presentManagementUsage(normal, {
    groups: [{ id: 7, name: 'Shared', accounts: [{ id: 5, usage, credits: { availableResetCount: 0 } }] }],
  })
  expect(shown.windows[0]).toEqual(normal.windows[0])
  expect(shown.plan).toBe('Pro · 管理台 · Shared')
  expect(shown.windows[0].aside).toBeUndefined()
  expect(shown.windows.slice(1).every(window => window.aside)).toBe(true)
  expect(shown.windows.map(window => window.name)).toEqual(['5 hours', 'Today', '并发', '可用重置', '5h', '7d'])
})

test('coincident reset expirations are combined into the native expiry annotation', () => {
  const windows = mapManagementUsage(
    {
      usage,
      credits: {
        availableResetCount: 3,
        resetCreditExpirations: [soon, later, soon],
      },
    },
    context,
  )
  expect(windows).toHaveLength(3)
  expect(windows[2].runsOutAt).toBe(soon)
  expect(windows[2].runsOut).toBe(2)
})
