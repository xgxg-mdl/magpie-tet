import { expect, test } from 'bun:test'
import { mapUsage } from '../../src/usage.mjs'

const earlier = '2099-01-01T00:00:00Z'
const later = '2100-01-01T00:00:00Z'
const expired = '2000-01-01T00:00:00Z'
const subscription = { daily_limit_usd: 10, daily_usage_usd: 2 }
test('usage chooses the earlier key or subscription expiry regardless of field order', () => {
  for (const [keyExpiry, subExpiry] of [
    [earlier, later],
    [later, earlier],
  ]) {
    const usage = mapUsage({
      isValid: true,
      expires_at: keyExpiry,
      subscription: { ...subscription, expires_at: subExpiry },
    })
    expect(usage.until).toBe(earlier)
    expect(usage.error).toBeUndefined()
  }
})

test('an expired key or subscription cannot be hidden by the other future expiry', () => {
  for (const [keyExpiry, subExpiry] of [
    [expired, later],
    [later, expired],
  ]) {
    const usage = mapUsage({
      isValid: true,
      expires_at: keyExpiry,
      subscription: { ...subscription, expires_at: subExpiry },
    })
    expect(usage.until).toBe(expired)
    expect(usage.error).toContain('expired')
    expect(usage.signIn).toBeUndefined()
  }
})

test('invalid or absent expiry values cannot overwrite a valid expiry', () => {
  for (const invalid of [undefined, null, '', 'not-a-time', 123, Infinity]) {
    expect(
      mapUsage({ isValid: true, expires_at: invalid, subscription: { ...subscription, expires_at: earlier } }).until,
    ).toBe(earlier)
    expect(
      mapUsage({ isValid: true, expires_at: earlier, subscription: { ...subscription, expires_at: invalid } }).until,
    ).toBe(earlier)
    const usage = mapUsage({
      isValid: true,
      expires_at: invalid,
      subscription: { ...subscription, expires_at: invalid },
    })
    expect(usage.until).toBeUndefined()
    expect(usage.error).toBeUndefined()
  }
})

test('quota status remains authoritative without inferring subscription constraints', () => {
  const usage = mapUsage({
    isValid: true,
    mode: 'quota_limited',
    status: 'expired',
    quota: { used: 1, limit: 10 },
    expires_at: later,
    subscription: { ...subscription, expires_at: expired },
  })
  expect(usage.until).toBe(later)
  expect(usage.error).toBe('API key has expired.')
  expect(usage.windows).toEqual([{ name: 'API key quota', amount: 1, limit: 10, unit: 'USD', used: 10 }])
})

test('empty or unusable subscription data does not suppress a real wallet', () => {
  for (const sub of [
    {},
    [],
    null,
    'subscription',
    0,
    { daily_usage_usd: 1 },
    { daily_limit_usd: 0 },
    { daily_limit_usd: -1 },
    { expires_at: 'not-a-time' },
  ]) {
    const usage = mapUsage({ isValid: true, balance: 12.34, subscription: sub })
    expect(usage.balance).toBe('12.34 USD')
    expect(usage.windows).toEqual([])
    expect(usage.error).toBeUndefined()
  }
})

test('unusable subscription data without a wallet reports missing usage information', () => {
  for (const sub of [{}, [], { daily_usage_usd: 1 }, { expires_at: 'not-a-time' }]) {
    const usage = mapUsage({ isValid: true, subscription: sub })
    expect(usage.windows).toEqual([])
    expect(usage.error).toContain('did not report a wallet or an active subscription')
  }
})

test('a real subscription limit or expiry remains displayable without a wallet', () => {
  const unknown = mapUsage({ isValid: true, subscription: { daily_limit_usd: 10 } })
  expect(unknown.error).toBeUndefined()
  expect(unknown.windows).toEqual([{ name: '1 day', display: 'Limit $10.00 · usage unavailable', span: 86400 }])
  const unlimited = mapUsage({ isValid: true, subscription: { expires_at: earlier } })
  expect(unlimited.until).toBe(earlier)
  expect(unlimited.error).toBeUndefined()
  expect(unlimited.windows).toEqual([])
})
