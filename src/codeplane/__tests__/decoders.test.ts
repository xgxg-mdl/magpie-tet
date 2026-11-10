import { expect, test } from 'bun:test'
import { decodeCapacity, decodeGroupPage, decodeQuotaReadings } from '../decoders.ts'

const now = Date.parse('2030-01-01T00:00:00Z')
const soon = '2030-01-01T05:00:00.000Z'
const later = '2030-01-08T00:00:00.000Z'
const context = { now }
const usage = { fiveHour: { utilization: 0, resetsAt: soon }, sevenDay: { utilization: 100, resetsAt: later } }

test('capacity preserves zero, full and over-capacity snapshots without fabricating missing limits', () => {
  for (const used of [0, 2, 10, 12])
    expect(decodeCapacity({ used, max: 10 })).toEqual({ kind: 'available', used, limit: 10 })
  for (const used of [0, 2]) expect(decodeCapacity({ used, max: 0 })).toEqual({ kind: 'available', used, limit: 0 })
  expect(decodeCapacity(undefined)).toEqual({ kind: 'missing' })
  for (const value of [
    null,
    {},
    { used: -1, max: 10 },
    { used: 0, max: -1 },
    { used: 0 },
    { used: 0, max: null },
    { used: 0, max: '0' },
    { used: 0, max: 0.5 },
    { used: 0, max: Number.MAX_SAFE_INTEGER + 1 },
    { used: '2', max: 10 },
    { used: 1.5, max: 10 },
  ])
    expect(decodeCapacity(value)).toEqual({ kind: 'unavailable', reason: 'missing' })
})

test('known zero survives an expired or absent reset without creating a new cycle boundary', () => {
  for (const resetsAt of [undefined, 'invalid', '2029-12-31T23:59:59Z']) {
    expect(
      decodeQuotaReadings({ usage: { fiveHour: { utilization: 0, resetsAt } } }, context).periods.fiveHour,
    ).toEqual({ kind: 'available', utilization: 0, resetsAt: null })
  }
})

test('invalid period and reset readings remain unavailable while independent periods survive', () => {
  for (const invalid of [undefined, null, -1, NaN, Infinity, '12']) {
    const decoded = decodeQuotaReadings(
      {
        usage: { ...usage, fiveHour: { utilization: invalid, resetsAt: soon } },
        credits: { availableResetCount: invalid },
      },
      context,
    )
    expect(decoded.periods.fiveHour).toEqual({ kind: 'unavailable', reason: 'missing' })
    expect(decoded.periods.sevenDay).toEqual({ kind: 'available', utilization: 100, resetsAt: later })
    expect(decoded.resets).toEqual({ kind: 'unavailable', reason: 'missing' })
  }
  expect(decodeQuotaReadings({ credits: { availableResetCount: 1.5 } }, context).resets.kind).toBe('unavailable')
  expect(
    decodeQuotaReadings({ usage: { fiveHour: { utilization: 125, resetsAt: soon } } }, context).periods.fiveHour,
  ).toEqual({ kind: 'available', utilization: 125, resetsAt: soon })
})

test('nonzero readings require a future reset and normalize timezone offsets', () => {
  for (const resetsAt of [undefined, 'invalid'])
    expect(
      decodeQuotaReadings({ usage: { fiveHour: { utilization: 50, resetsAt } } }, context).periods.fiveHour,
    ).toEqual({ kind: 'unavailable', reason: 'reset-pending' })
  for (const resetsAt of ['2029-12-31T23:59:59Z', '2030-01-01T00:00:00Z'])
    expect(
      decodeQuotaReadings({ usage: { fiveHour: { utilization: 50, resetsAt } } }, context).periods.fiveHour,
    ).toEqual({ kind: 'unavailable', reason: 'expired' })
  expect(
    decodeQuotaReadings({ usage: { fiveHour: { utilization: 50, resetsAt: '2030-01-01T13:00:00+08:00' } } }, context)
      .periods.fiveHour,
  ).toEqual({ kind: 'available', utilization: 50, resetsAt: soon })
})

test('partial failures and degraded usage do not hide independent reset counts', () => {
  expect(decodeQuotaReadings({ usage, creditsError: 'safe failure' }, context).resets).toEqual({
    kind: 'unavailable',
    reason: 'request',
    message: 'safe failure',
  })
  const failure = decodeQuotaReadings({ usageError: 'safe failure', credits: { availableResetCount: 2 } }, context)
  expect(failure.periods.fiveHour).toEqual({ kind: 'unavailable', reason: 'request', message: 'safe failure' })
  expect(failure.resets).toEqual({ kind: 'available', count: 2 })
  const degraded = decodeQuotaReadings({ usage: { ...usage, degraded: true } }, context)
  expect(degraded.periods.fiveHour).toEqual({ kind: 'unavailable', reason: 'degraded' })
  expect(degraded.periods.sevenDay).toEqual({ kind: 'unavailable', reason: 'degraded' })
})

test('cache timestamps outside the freshness interval cannot create fresh usage history', () => {
  for (const updatedAt of ['2029-12-31T23:44:59Z', '2030-01-01T00:01:01Z', 'invalid', null]) {
    const decoded = decodeQuotaReadings({ usage: { ...usage, updatedAt } }, context)
    expect(decoded.periods.fiveHour).toEqual({ kind: 'unavailable', reason: 'stale' })
    expect(decoded.periods.sevenDay).toEqual({ kind: 'unavailable', reason: 'stale' })
  }
  for (const updatedAt of [undefined, '2029-12-31T23:45:00Z', '2030-01-01T00:01:00Z'])
    expect(decodeQuotaReadings({ usage: { ...usage, updatedAt } }, context).periods.fiveHour.kind).toBe('available')
})

test('reset cache timestamps use Unix seconds with the same inclusive freshness interval', () => {
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
  ])
    expect(decodeQuotaReadings({ credits: { availableResetCount: 2, fetchedAt } }, context).resets).toEqual({
      kind: 'unavailable',
      reason: 'stale',
    })
  for (const fetchedAt of [undefined, seconds, seconds - 900, seconds + 60])
    expect(decodeQuotaReadings({ credits: { availableResetCount: 0, fetchedAt } }, context).resets).toEqual({
      kind: 'available',
      count: 0,
    })
})

test('credit expiration selects the nearest valid future date and caps the count', () => {
  const credits = {
    availableResetCount: 3,
    resetCreditExpirations: [later, 'invalid', '2029-12-31T23:59:59Z', soon, soon],
  }
  expect(decodeQuotaReadings({ credits }, context).resets).toEqual({
    kind: 'available',
    count: 3,
    expiration: { at: soon, count: 2 },
  })
  expect(decodeQuotaReadings({ credits: { ...credits, availableResetCount: 1 } }, context).resets).toEqual({
    kind: 'available',
    count: 1,
    expiration: { at: soon, count: 1 },
  })
  expect(decodeQuotaReadings({ credits: { ...credits, availableResetCount: 0 } }, context).resets).toEqual({
    kind: 'available',
    count: 0,
  })
})

test('group decoder rejects malformed identities and deduplicates upstream IDs within a group', () => {
  for (const raw of [
    null,
    {},
    { content: [], totalElements: -1 },
    { content: [null], totalElements: 1 },
    { content: [{ id: 0, name: 'X', accounts: [] }], totalElements: 1 },
    { content: [{ id: 1, name: 'X', accounts: [{ id: '2' }] }], totalElements: 1 },
  ])
    expect(() => decodeGroupPage(raw)).toThrow()
  expect(
    decodeGroupPage({
      content: [
        {
          id: 1,
          name: ' X ',
          accounts: [
            { id: 2, name: ' A ' },
            { id: 2, name: 'B' },
          ],
        },
      ],
      totalElements: 1,
    }),
  ).toEqual({
    total: 1,
    groups: [{ id: 1, name: 'X', accounts: [{ id: 2, name: 'B' }], capacity: { kind: 'missing' } }],
  })
})
