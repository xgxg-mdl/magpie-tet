import { expect, test } from 'bun:test'
import { mapManagementUsage } from '../src/management-usage.mjs'

const now = Date.parse('2030-01-01T00:00:00Z')
const soon = '2030-01-01T05:00:00.000Z'
const later = '2030-01-08T00:00:00.000Z'
const context = { groupName: 'Shared group', keyLabel: 'key-1234', now }
const usage = { fiveHour: { utilization: 0, resetsAt: soon }, sevenDay: { utilization: 100, resetsAt: later } }

test('group windows preserve measured zero and full readings without affecting routing', () => {
  const windows = mapManagementUsage({ usage, credits: { availableResetCount: 0 } }, context)
  expect(windows).toEqual([
    { name: 'Group Shared group · key-1234 · 5 hours', used: 0, span: 18000, resetsAt: soon, aside: true },
    { name: 'Group Shared group · key-1234 · 7 days', used: 100, span: 604800, resetsAt: later, aside: true },
    { name: 'Group Shared group · key-1234 · Resets', display: '0 remaining', aside: true },
  ])
  expect(windows.every(window => window.amount === undefined && window.limit === undefined)).toBe(true)
  const other = mapManagementUsage({ usage }, { ...context, keyLabel: 'key-5678' })
  expect(other[0].name).not.toBe(windows[0].name)
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
    expect(windows[0].display).toContain('unavailable')
    expect(windows[1].used).toBe(100)
    expect(windows[2].display).toContain('unavailable')
  }
  expect(mapManagementUsage({ credits: { availableResetCount: 1.5 } }, context)[2].display).toContain('unavailable')
  const over = mapManagementUsage({ usage: { ...usage, fiveHour: { utilization: 125, resetsAt: soon } } }, context)
  expect(over[0].used).toBe(125)
})

test('missing, malformed and expired reset times never create current-cycle readings', () => {
  for (const resetsAt of [undefined, 'invalid', '2029-12-31T23:59:59Z', '2030-01-01T00:00:00Z']) {
    const windows = mapManagementUsage({ usage: { ...usage, fiveHour: { utilization: 50, resetsAt } } }, context)
    expect(windows[0].used).toBeUndefined()
    expect(windows[0].resetsAt).toBeUndefined()
    expect(windows[0].display).toContain('Waiting')
    expect(windows[1].used).toBe(100)
  }
  const normalized = mapManagementUsage(
    { usage: { ...usage, fiveHour: { utilization: 50, resetsAt: '2030-01-01T13:00:00+08:00' } } },
    context,
  )
  expect(normalized[0].resetsAt).toBe(soon)
})

test('partial query failures do not hide independent group data', () => {
  const creditsFailed = mapManagementUsage({ usage, creditsError: 'Management session expired.' }, context)
  expect(creditsFailed[0].used).toBe(0)
  expect(creditsFailed[1].used).toBe(100)
  expect(creditsFailed[2].display).toBe('Management session expired.')
  const usageFailed = mapManagementUsage(
    { usageError: 'Group usage query timed out.', credits: { availableResetCount: 2 } },
    context,
  )
  expect(usageFailed.slice(0, 2).every(window => window.display === 'Group usage query timed out.')).toBe(true)
  expect(usageFailed[2].display).toBe('2 remaining')
})

test('degraded group responses do not produce misleading history points', () => {
  const windows = mapManagementUsage(
    { usage: { ...usage, degraded: true }, credits: { availableResetCount: 1 } },
    context,
  )
  expect(windows.slice(0, 2).every(window => window.used === undefined && window.display.includes('incomplete'))).toBe(
    true,
  )
  expect(windows[2].display).toBe('1 remaining')
})

test('stale, future and invalid timestamps do not become fresh quota history points', () => {
  for (const updatedAt of ['2029-12-31T23:44:59Z', '2030-01-01T00:01:01Z', 'invalid', null]) {
    const windows = mapManagementUsage({ usage: { ...usage, updatedAt }, credits: { availableResetCount: 0 } }, context)
    expect(windows.slice(0, 2).every(window => window.used === undefined && window.display.includes('stale'))).toBe(
      true,
    )
    expect(windows[2].display).toBe('0 remaining')
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
    expect(windows[2].display).toContain('stale')
    expect(windows).toHaveLength(3)
  }
  for (const fetchedAt of [undefined, seconds, seconds - 900, seconds + 60]) {
    const windows = mapManagementUsage({ usage, credits: { availableResetCount: 0, fetchedAt } }, context)
    expect(windows[2].display).toBe('0 remaining')
  }
})

test('reset expiry selects only the nearest valid future credit and respects zero counts', () => {
  const credits = {
    availableResetCount: 3,
    resetCreditExpirations: [later, 'invalid', '2029-12-31T23:59:59Z', soon],
  }
  const windows = mapManagementUsage({ usage, credits }, context)
  expect(windows.at(-1)).toEqual({
    name: 'Group Shared group · key-1234 · Next reset credit expiry',
    display: soon,
    aside: true,
  })
  expect(mapManagementUsage({ usage, credits: { ...credits, availableResetCount: 0 } }, context)).toHaveLength(3)
  expect(
    mapManagementUsage({ usage, credits: { ...credits, resetCreditExpirations: ['invalid'] } }, context),
  ).toHaveLength(3)
})
