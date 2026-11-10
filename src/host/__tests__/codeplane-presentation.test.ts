import { expect, test } from 'bun:test'
import { presentCodePlaneUsage } from '../codeplane-presentation.ts'
import type { CapacityReading, QuotaAccount, QuotaGroup, QuotaReadings } from '../../codeplane/types.ts'
import { decodeCapacity, decodeQuotaReadings } from '../../codeplane/decoders.ts'
import { present } from '../../../test/support/assertions.ts'

const soon = '2030-01-01T05:00:00.000Z'
const later = '2030-01-08T00:00:00.000Z'
const sample: QuotaReadings = {
  periods: {
    fiveHour: { kind: 'available', utilization: 0, resetsAt: soon },
    sevenDay: { kind: 'available', utilization: 100, resetsAt: later },
  },
  resets: { kind: 'available', count: 1, expiration: { at: soon, count: 1 } },
}
const capacity: CapacityReading = { kind: 'available', used: 2, limit: 10 }
const account = (id = 5, name = '', readings = sample): QuotaAccount => ({ id, name, readings })
const group = (id = 7, name = 'Shared', accounts = [account()]): QuotaGroup => ({ id, name, accounts, capacity })

test('shared percentages remain display-only and preserve native zero and expiry annotations', () => {
  const { windows } = presentCodePlaneUsage({ windows: [] }, { groups: [group()] })
  expect(windows).toEqual([
    { name: '5 hours', used: 0, span: 18000, resetsAt: soon, aside: true },
    { name: '7 days', used: 100, span: 604800, resetsAt: later, aside: true },
    { name: '并发', display: '2 / 10', aside: true },
    { name: '重置次数', display: '1 次', runsOutAt: soon, runsOut: 1, unit: '次', aside: true },
  ])
  expect(windows.every(window => window.amount === undefined && window.limit === undefined)).toBe(true)
  const noDeadline: QuotaReadings = {
    ...sample,
    periods: { ...sample.periods, fiveHour: { kind: 'available', utilization: 0, resetsAt: null } },
  }
  expect(
    presentCodePlaneUsage({ windows: [] }, { groups: [group(7, 'Shared', [account(5, '', noDeadline)])] }).windows[0],
  ).toEqual({ name: '5 hours', used: 0, aside: true })
})

test('decoder failures become independent native status windows without routing history', () => {
  const decoded = decodeQuotaReadings({
    usage: { fiveHour: { utilization: 'invalid' }, degraded: true },
    credits: { availableResetCount: 0 },
  })
  const { windows } = presentCodePlaneUsage(
    { windows: [] },
    {
      groups: [{ ...group(7, 'Shared', [account(5, '', decoded)]), capacity: decodeCapacity({ used: 0, max: null }) }],
    },
  )
  expect(windows.slice(0, 2)).toEqual([
    { name: '5 hours', display: '部分数据暂不可用', aside: true },
    { name: '7 days', display: '部分数据暂不可用', aside: true },
  ])
  expect(windows[2]).toEqual({ name: '并发', display: '暂无数据', aside: true })
  expect(windows[3]).toEqual({ name: '重置次数', display: '0 次', aside: true })
})

test('zero capacity remains a text snapshot regardless of period availability', () => {
  for (const used of [0, 2]) {
    for (const accounts of [[account()], []]) {
      const { windows } = presentCodePlaneUsage(
        { windows: [] },
        { groups: [{ ...group(7, 'Shared', accounts), capacity: decodeCapacity({ used, max: 0 }) }] },
      )
      expect(windows.find(window => window.name === '并发')).toEqual({
        name: '并发',
        display: used + ' / 0',
        aside: true,
      })
    }
  }
})

test('unavailable domain reasons are translated without inspecting external response fields', () => {
  for (const [reason, expected] of [
    ['missing', '暂无数据'],
    ['stale', '数据待更新'],
    ['reset-pending', '重置时间待更新'],
    ['expired', '等待新周期数据'],
  ] satisfies [Exclude<import('../../codeplane/types.ts').UnavailableReason, 'degraded' | 'request'>, string][]) {
    const reading: QuotaReadings = {
      ...sample,
      periods: { ...sample.periods, fiveHour: { kind: 'unavailable', reason } },
    }
    expect(
      presentCodePlaneUsage({ windows: [] }, { groups: [group(7, 'Shared', [account(5, '', reading)])] }).windows[0],
    ).toEqual({ name: '5 hours', display: expected, aside: true })
  }
})

test('periods start on a native row after wallet costs and preserve the wallet identity', () => {
  const normal = {
    plan: 'Wallet',
    balance: '12.00 USD',
    windows: [
      { name: 'Today', display: '1.00 USD · 2 req', aside: true },
      { name: 'Total', display: '3.00 USD · 4 req', aside: true },
      { name: '实时速率', display: '1 RPM · 2 TPM', aside: true },
    ],
  }
  const shown = presentCodePlaneUsage(normal, { groups: [group()] })
  expect(shown.windows.map(window => window.name)).toEqual([
    'Today',
    'Total',
    '实时速率',
    '分组',
    '5 hours',
    '7 days',
    '并发',
    '重置次数',
  ])
  expect(shown.windows[3]).toEqual({ name: '分组', display: 'Shared', aside: true })
  expect(shown.plan).toBe('Wallet')
  expect(shown.balance).toBe('12.00 USD')
  expect(normal.windows).toHaveLength(3)
  expect(presentCodePlaneUsage(normal, null)).toBe(normal)
})

test('group overview sorts and distinguishes names while empty groups retain concurrency status', () => {
  const original = { windows: [{ name: 'Today', display: '1.00 USD', aside: true }] }
  const shown = presentCodePlaneUsage(original, { groups: [group(8, 'Same', []), group(7, 'Same', [])] })
  expect(shown.windows[1]).toEqual({ name: '分组', display: 'Same #7、Same #8', aside: true })
  expect(shown.windows.slice(2).map(window => window.name)).toEqual([
    'Same #7 · 周期额度',
    'Same #7 · 并发',
    'Same #8 · 周期额度',
    'Same #8 · 并发',
  ])
  expect(presentCodePlaneUsage(original, { groups: [] }).windows.at(-1)).toEqual({
    name: '分组',
    display: '暂无可见分组',
    aside: true,
  })
  expect(presentCodePlaneUsage(original, { error: 'safe error' }).windows.at(-1)).toEqual({
    name: '分组',
    display: 'safe error',
    aside: true,
  })
})

test('real key periods stay separate from same-named shared periods', () => {
  const keyWindows = ['5 hours', '7 days'].map(name => ({ name, used: 10, amount: 1, limit: 10, unit: 'USD' }))
  const shown = presentCodePlaneUsage({ plan: 'Pro', windows: keyWindows }, { groups: [group()] })
  expect(shown.windows.slice(0, 2)).toEqual(keyWindows)
  expect(shown.windows.slice(2, 4).map(window => window.name)).toEqual(['Shared · 5 hours', 'Shared · 7 days'])
  expect(shown.windows.slice(2).every(window => window.aside)).toBe(true)
  expect(shown.plan).toBe('Pro')
})

test('single-source common period names do not vary with group identity', () => {
  for (const name of ['Group A', 'Group B']) {
    const shown = presentCodePlaneUsage({ windows: [] }, { groups: [group(7, name)] })
    expect(shown.windows.slice(0, 2).map(window => window.name)).toEqual(['5 hours', '7 days'])
    expect(present(shown.windows[2]).name).toBe('并发')
  }
})

test('multiple upstream period pairs and following groups remain aligned without summation', () => {
  for (const count of [2, 3, 4]) {
    const accounts = Array.from({ length: count }, (_, index) => account(index + 1))
    const shown = presentCodePlaneUsage({ windows: [] }, { groups: [group(7, 'Shared', accounts), group(8, 'Next')] })
    for (const source of accounts) {
      const index = shown.windows.findIndex(window => window.name === 'Shared · 上游 ' + source.id + ' · 5 hours')
      expect(index % 2).toBe(0)
      expect(present(shown.windows[index + 1]).name).toBe('Shared · 上游 ' + source.id + ' · 7 days')
    }
    expect(shown.windows.findIndex(window => window.name === 'Next · 5 hours') % 2).toBe(0)
    expect(shown.windows.filter(window => window.name === 'Shared · 并发')).toHaveLength(1)
    expect(shown.windows.filter(window => window.name.includes('重置次数'))).toHaveLength(count + 1)
  }
})

test('odd key and statistic counts add a group overview without shifting period pairs', () => {
  for (const windows of [
    [{ name: 'Today', aside: true }],
    [
      { name: 'Total', aside: true },
      { name: '速率', aside: true },
    ],
    [{ name: 'Limit' }, { name: 'Today', aside: true }, { name: 'Total', aside: true }],
  ]) {
    const shown = presentCodePlaneUsage({ windows }, { groups: [group()] })
    const index = shown.windows.findIndex(window => window.name === '5 hours')
    expect(index % 2).toBe(0)
    expect(shown.windows.slice(0, windows.length)).toEqual(windows)
    expect(present(shown.windows[index + 1]).name).toBe('7 days')
    if (windows.length % 2) expect(present(shown.windows[index - 1]).name).toBe('分组')
  }
})

test('natural names, fallback IDs and hierarchy separators cannot collide', () => {
  for (const groups of [
    [group(7, 'X', [account(5, '上游 6'), account(6)]), group(8, 'X'), group(9, 'X #7')],
    [group(7, 'X', [account(5, 'Y'), account(6, 'Z')]), group(8, 'X · Y'), group(9, 'X / Y')],
  ]) {
    const names = presentCodePlaneUsage({ windows: [] }, { groups }).windows.map(window => window.name)
    expect(new Set(names).size).toBe(names.length)
  }
})
