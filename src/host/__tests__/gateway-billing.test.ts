import { expect, test } from 'bun:test'
import { mapUsage } from './gateway-fixtures.ts'
import { present } from '../../../test/support/assertions.ts'

test('known zero usage remains a measured allowance across key, rate and subscription limits', () => {
  const key = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    quota: { used: 0, limit: 10 },
    rate_limits: [{ window: '5h', used: 0, limit: 5 }],
  })
  const subscription = mapUsage({
    isValid: true,
    subscription: {
      daily_usage_usd: 0,
      daily_limit_usd: 10,
      weekly_limit_usd: 100,
      monthly_usage_usd: 120,
      monthly_limit_usd: 100,
    },
  })
  for (const window of [...key.windows, present(subscription.windows[0])]) {
    expect(window.used).toBe(0)
    expect(window.amount).toBe(0)
    expect(window.aside).toBeUndefined()
  }
  expect(present(subscription.windows[1]).used).toBeUndefined()
  expect(present(subscription.windows[1]).amount).toBeUndefined()
  expect(present(subscription.windows[2]).used).toBe(120)
})

test('a wallet and active subscription retain their separate scopes', () => {
  const usage = mapUsage({
    isValid: true,
    balance: 12.3456,
    planName: 'Pro',
    subscription: { daily_limit_usd: 10, daily_usage_usd: 1.23456, expires_at: '2099-01-01T00:00:00Z' },
  })
  expect(usage.balance).toBe('12.35 USD')
  expect(usage.plan).toBe('Pro')
  expect(usage.until).toBe('2099-01-01T00:00:00Z')
  expect(usage.windows).toEqual([
    { name: '1 day', amount: 1.23456, limit: 10, unit: 'USD', span: 86400, used: expect.any(Number) },
  ])
  expect(present(usage.windows[0]).used).toBeCloseTo(12.3456, 10)
})

test('a key-limited wallet shows both balance and key limits without activating residual subscription data', () => {
  const usage = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    balance: 50.1234,
    quota: { used: 1.23456, limit: 20.98765 },
    rate_limits: [{ window: '5h', used: 0.0001, limit: 5 }],
    subscription: { daily_usage_usd: 999, daily_limit_usd: 1, expires_at: '2000-01-01T00:00:00Z' },
  })
  expect(usage.balance).toBe('50.12 USD')
  expect(usage.error).toBeUndefined()
  expect(usage.until).toBeUndefined()
  expect(usage.windows).toEqual([
    { name: 'API key quota', amount: 1.23456, limit: 20.98765, unit: 'USD', used: expect.any(Number) },
    { name: '5 hours', amount: 0.0001, limit: 5, unit: 'USD', span: 18000, used: expect.any(Number) },
  ])
})

test('wallet funds do not hide an exhausted key or expired active subscription', () => {
  const key = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    balance: 100,
    quota: { used: 10, limit: 10 },
    status: 'quota_exhausted',
  })
  expect(key.balance).toBe('100.00 USD')
  expect(key.error).toBe('API key quota is exhausted.')
  const sub = mapUsage({ isValid: true, balance: 100, subscription: { expires_at: '2000-01-01T00:00:00Z' } })
  expect(sub.balance).toBe('100.00 USD')
  expect(sub.error).toContain('expired')
})

test('expiry-only subscriptions never fabricate a total or a progress bar', () => {
  for (const balance of [undefined, 12.34]) {
    const usage = mapUsage({ isValid: true, balance, subscription: { expires_at: '2099-01-01T00:00:00Z' } })
    expect(usage.windows).toEqual([])
    expect(usage.until).toBe('2099-01-01T00:00:00Z')
    expect(usage.error).toBeUndefined()
  }
})

test('formatting handles zero, negative adjustments and non-USD amounts consistently', () => {
  const cases: [number, string, string][] = [
    [0, '0.00 USD', '0.00 EUR'],
    [-0, '0.00 USD', '0.00 EUR'],
    [0.0001, '<0.01 USD', '<0.01 EUR'],
    [-0.0001, '>-0.01 USD', '>-0.01 EUR'],
    [0.01, '0.01 USD', '0.01 EUR'],
    [-0.01, '-0.01 USD', '-0.01 EUR'],
    [-1.234, '-1.23 USD', '-1.23 EUR'],
    [12.345, '12.35 USD', '12.35 EUR'],
    [12.3456, '12.35 USD', '12.35 EUR'],
    [-12.3456, '-12.35 USD', '-12.35 EUR'],
    [9999999385.337, '9,999,999,385.34 USD', '9,999,999,385.34 EUR'],
  ]
  for (const [value, usd, eur] of cases) {
    const amounts: [string, string][] = [
      ['USD', usd],
      ['EUR', eur],
    ]
    for (const [unit, expected] of amounts) {
      const wallet = mapUsage({ isValid: true, unit, balance: value })
      expect(wallet.balance).toBe(expected)
      expect(wallet.windows).toEqual([])
      const usage = mapUsage({ isValid: true, unit, balance: value, usage: { today: { cost: value } } })
      expect(usage.balance).toBe(expected)
      expect(present(usage.windows[0]).display).toBe(expected)
      expect(present(usage.windows[0]).aside).toBe(true)
    }
  }
})

test('unknown usage shows a formatted limit without rounding raw quota values', () => {
  const usage = mapUsage({ isValid: true, mode: 'quota_limited', balance: 1, quota: { limit: 12.3456 } })
  expect(usage.balance).toBe('1.00 USD')
  expect(usage.windows).toEqual([{ name: 'API key quota', display: 'Limit 12.35 USD · usage unavailable' }])
})
