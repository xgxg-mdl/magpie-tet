import { expect, test } from 'bun:test'
import { mapUsage } from '../../src/usage.mjs'

test('wallets use one native balance without fabricating progress', () => {
  for (const balance of [0, -1.234, 12.345, 9999999385.337]) {
    const usage = mapUsage({ isValid: true, balance })
    expect(usage.balance).toBe(
      balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD',
    )
    expect(usage.windows).toEqual([])
  }
  expect(mapUsage({ isValid: true, balance: 12.3456, unit: 'EUR' }).balance).toBe('12.35 EUR')
})

test('costs display two decimals without presenting small nonzero charges as zero', () => {
  const data = {
    isValid: true,
    balance: 10,
    usage: {
      today: { cost: 0.0001, requests: 12, total_tokens: 345 },
      total: { actual_cost: 1.2345, requests: 26710 },
      rpm: 2,
      tpm: 1000,
    },
  }
  const usage = mapUsage(data)
  expect(usage.windows).toEqual([
    { name: 'Today', display: '<0.01 USD · 12 req / 345 tok', aside: true },
    { name: 'Total', display: '1.23 USD · 26.7K req', aside: true },
    { name: '实时速率', display: '2 RPM · 1K TPM', aside: true },
  ])
  expect(mapUsage(data, { showTraffic: false }).windows).toEqual([
    { name: 'Today', display: '<0.01 USD', aside: true },
    { name: 'Total', display: '1.23 USD', aside: true },
  ])
})

test('real limits retain native progress and unknown usage remains unknown', () => {
  const usage = mapUsage({
    isValid: true,
    subscription: {
      daily_limit_usd: 10,
      daily_usage_usd: 2,
      weekly_limit_usd: 100,
      monthly_limit_usd: 1000,
      monthly_usage_usd: 1200,
    },
  })
  expect(usage.windows[0]).toEqual({ name: '1 day', amount: 2, limit: 10, unit: 'USD', span: 86400, used: 20 })
  expect(usage.windows[1]).toEqual({ name: 'Weekly', display: 'Limit 100.00 USD · usage unavailable', span: 604800 })
  expect(usage.windows[2]).toMatchObject({ amount: 1200, limit: 1000, unit: 'USD' })
  expect(usage.windows.every(window => window.aside === undefined)).toBe(true)
})

test('large token counts stay compact and within the host two-part display contract', () => {
  const usage = mapUsage({
    isValid: true,
    balance: 10,
    usage: {
      today: { actual_cost: 152.47, requests: 1207, total_tokens: 26500000 },
      rpm: 14,
      tpm: 5382799,
    },
  })
  expect(usage.windows[0].display).toBe('152.47 USD · 1.2K req / 26.5M tok')
  expect(usage.windows[0].display.split(' · ')).toHaveLength(2)
  expect(usage.windows[1].display).toBe('14 RPM · 5.4M TPM')
})

test('request counts and rates share compact suffixes at thousand and million boundaries', () => {
  for (const [value, shown] of [
    [0, '0'],
    [914, '914'],
    [1000, '1K'],
    [29297, '29.3K'],
    [1000000, '1M'],
  ]) {
    const usage = mapUsage({ isValid: true, balance: 0, usage: { today: { cost: 0, requests: value }, rpm: value } })
    expect(usage.windows[0].display).toBe('0.00 USD · ' + shown + ' req')
    expect(usage.windows[1]).toEqual({ name: '实时速率', display: shown + ' RPM', aside: true })
  }
})

test('known period labels translate without interpreting arbitrary server names as object keys', () => {
  const windows = ['5h', '1d', '7d', '__proto__', 'constructor']
  const usage = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    rate_limits: windows.map(window => ({ window, used: 1, limit: 10 })),
  })
  expect(usage.windows.map(window => window.name)).toEqual(['5 hours', '1 day', '7 days', '__proto__', 'constructor'])
  expect(usage.windows.slice(3).every(window => window.span === undefined)).toBe(true)
})
