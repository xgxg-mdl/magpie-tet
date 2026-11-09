import { expect, test } from 'bun:test'
import { parseUsage } from '../usage.ts'

test('invalid authentication is a domain state and malformed envelopes are rejected', () => {
  expect(parseUsage({ isValid: false, balance: 100 })).toEqual({ kind: 'invalid-key' })
  for (const value of [null, [], {}, { isValid: 'true' }]) expect(() => parseUsage(value)).toThrow('invalid usage')
})

test('wallet and measured key limits remain separate, preserving zero and unknown usage', () => {
  expect(
    parseUsage({
      isValid: true,
      mode: 'quota_limited',
      balance: 50.1234,
      quota: { used: 0, limit: 20.98765 },
      rate_limits: [{ window: '5h', used: -1, limit: 5, reset_at: '2099-01-01T00:00:00Z' }],
      subscription: { expires_at: '2000-01-01T00:00:00Z', daily_limit_usd: 1 },
    }),
  ).toEqual({
    kind: 'valid',
    plan: 'TET',
    unit: 'USD',
    wallet: 50.1234,
    allowances: [
      { kind: 'key-quota', period: '', used: 0, limit: 20.98765 },
      { kind: 'rate', period: '5h', limit: 5, resetsAt: '2099-01-01T00:00:00Z' },
    ],
    missingAccountUsage: false,
    stats: {},
  })
})

test('subscription normalization keeps the earlier expiry and only actual limits', () => {
  expect(
    parseUsage({
      isValid: true,
      expires_at: '2100-01-01T00:00:00Z',
      subscription: {
        expires_at: '2099-01-01T00:00:00Z',
        daily_limit_usd: 10,
        daily_usage_usd: 1.23456,
        weekly_limit_usd: 0,
        monthly_limit_usd: Number.NaN,
      },
    }),
  ).toEqual({
    kind: 'valid',
    plan: 'TET',
    unit: 'USD',
    allowances: [{ kind: 'subscription', period: 'daily', used: 1.23456, limit: 10 }],
    expiresAt: '2099-01-01T00:00:00Z',
    missingAccountUsage: false,
    stats: {},
  })
})

test('unusable remote statistics do not leak raw fields into the domain model', () => {
  expect(
    parseUsage({
      isValid: true,
      balance: '100',
      planName: 42,
      unit: {},
      usage: {
        today: { actual_cost: 0, cost: 100, requests: 12, total_tokens: '30' },
        total: { cost: Infinity },
        rpm: 0,
        tpm: '40',
      },
    }),
  ).toEqual({
    kind: 'valid',
    plan: 'TET',
    unit: 'USD',
    allowances: [],
    missingAccountUsage: true,
    stats: { today: { cost: 0, requests: 12 }, rpm: 0 },
  })
})
