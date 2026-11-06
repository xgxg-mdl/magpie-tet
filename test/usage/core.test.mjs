import { expect, test } from 'bun:test'
import { mapUsage } from '../../src/usage.mjs'
import { wallet } from '../helpers/plugin.mjs'

test('wallet does not invent percentage; costs and traffic are informational', () => {
  const result = mapUsage(wallet)
  expect(result.balance).toBe('9,999,999,443.00 USD')
  expect(result.windows.some(w => w.balance !== undefined)).toBe(false)
  expect(result.windows[0]).toEqual({ name: 'Today', display: '0.00 USD · 0 req / 50 tok', aside: true })
  expect(result.windows.at(-1)).toEqual({ name: '实时速率', display: '14 RPM', aside: true })
  expect(result.windows.every(w => w.used === undefined)).toBe(true)
  expect(mapUsage(wallet, { showTraffic: false }).windows[0].display).toBe('0.00 USD')
  expect(mapUsage({ isValid: true }).error).toContain('did not report')
  expect(() => mapUsage({})).toThrow()
})

test('quota enforces actual limits; missing usage stays unknown instead of becoming zero', () => {
  const result = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    quota: { used: 101, limit: 100 },
    rate_limits: [null, { window: '5h', limit: 10, reset_at: '2030-11-01T00:00:00Z' }],
    expires_at: '2030-12-01T00:00:00Z',
  })
  expect(result.windows[0]).toMatchObject({ amount: 101, limit: 100 })
  expect(result.windows[1]).toMatchObject({ span: 18000, resetsAt: '2030-11-01T00:00:00Z' })
  expect(result.windows[1].amount).toBeUndefined()
  expect(result.windows[1].limit).toBeUndefined()
  expect(result.windows[1].display).toContain('usage unavailable')
  expect(result.windows[1].aside).toBeUndefined()
  expect(result.until).toBe('2030-12-01T00:00:00Z')
})

test('subscription respects server resets and omits unconfigured limits and guessed month spans', () => {
  const result = mapUsage({
    isValid: true,
    subscription: {
      daily_usage_usd: 4,
      daily_limit_usd: 10,
      daily_reset_at: '2030-11-01T00:00:00Z',
      weekly_limit_usd: null,
      monthly_usage_usd: 6,
      monthly_limit_usd: 100,
    },
  })
  expect(result.windows[0]).toEqual({
    name: '1 day',
    amount: 4,
    limit: 10,
    unit: 'USD',
    span: 86400,
    resetsAt: '2030-11-01T00:00:00Z',
    used: 40,
  })
  expect(result.windows[1].span).toBeUndefined()
  expect(result.windows[1].resetsAt).toBeUndefined()
})

test('invalid sign-in and business expiry remain distinct', () => {
  expect(mapUsage({ isValid: false }).signIn).toBe('expired')
  const expired = mapUsage({ isValid: true, balance: 5, expires_at: '2000-01-01' })
  expect(expired.error).toContain('expired')
  expect(expired.signIn).toBeUndefined()
})
