import { expect, test } from 'bun:test'
import { readQuotas } from '../quota-reader.ts'
import type { CodePlaneQuery } from '../types.ts'
import { present } from '../../../test/support/assertions.ts'

const group = { id: 7, name: 'Shared', accounts: [{ id: 5 }], capacity: { used: 2, max: 10 } }
const options = () => ({ timeoutMs: 1000, signal: new AbortController().signal })
const metric = (path: string) =>
  path.endsWith('/credits')
    ? { availableResetCount: 1 }
    : { fiveHour: { utilization: 0 }, sevenDay: { utilization: 55, resetsAt: '2099-01-01T00:00:00Z' } }

test('shared upstreams are read once and metric failures remain local', async () => {
  const calls: string[] = []
  const query: CodePlaneQuery = async path => {
    calls.push(path)
    if (path.includes('?pageNum='))
      return {
        content: [group, { ...group, id: 8, name: 'Other', accounts: [{ id: 5 }, { id: 6 }] }],
        totalElements: 2,
      }
    if (path.includes('/6/usage')) throw new Error('safe upstream failure')
    return metric(path)
  }
  const result = await readQuotas(query, options())
  expect(calls).toHaveLength(5)
  expect(calls.filter(path => path.includes('/5/usage'))).toHaveLength(1)
  expect(present(present(result.groups[0]).accounts[0]).readings.periods.sevenDay).toEqual({
    kind: 'available',
    utilization: 55,
    resetsAt: '2099-01-01T00:00:00.000Z',
  })
  const failed = present(present(result.groups[1]).accounts[1]).readings
  expect(failed.periods.fiveHour).toEqual({ kind: 'unavailable', reason: 'request', message: 'safe upstream failure' })
  expect(failed.resets).toEqual({ kind: 'available', count: 1 })
})

test('group pagination rejects duplicate, incomplete and excessive snapshots', async () => {
  await expect(readQuotas(async () => ({ content: [group], totalElements: 2 }), options())).rejects.toThrow('分页重复')
  await expect(readQuotas(async () => ({ content: [], totalElements: 2 }), options())).rejects.toThrow('不完整')
  await expect(
    readQuotas(async path => {
      const page = Number(new URL(path, 'https://console.example').searchParams.get('pageNum'))
      return { content: [{ ...group, id: page }], totalElements: 21 }
    }, options()),
  ).rejects.toThrow('不完整')
})

test('each read follows current names, upstream associations, additions and removals', async () => {
  let groups = [group]
  const calls: string[] = []
  const query: CodePlaneQuery = async path => {
    calls.push(path)
    return path.includes('?pageNum=') ? { content: groups, totalElements: groups.length } : metric(path)
  }
  expect(present(present((await readQuotas(query, options())).groups[0]).accounts[0]).id).toBe(5)
  calls.length = 0
  groups = [
    { ...group, name: 'Renamed', accounts: [{ id: 6 }] },
    { ...group, id: 8, name: 'New', accounts: [] },
  ]
  const next = await readQuotas(query, options())
  expect(next.groups.map(item => item.name)).toEqual(['Renamed', 'New'])
  expect(present(present(next.groups[0]).accounts[0]).id).toBe(6)
  expect(calls.some(path => path.includes('/5/'))).toBe(false)
  groups = []
  expect((await readQuotas(query, options())).groups).toEqual([])
})

test('queued upstreams honor a shared signal with at most four metric requests in flight', async () => {
  const controller = new AbortController()
  let active = 0
  let calls = 0
  let start: (() => void) | undefined
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  const query: CodePlaneQuery = async (path, { signal }) => {
    if (path.includes('?pageNum='))
      return { content: [{ ...group, accounts: [1, 2, 3, 4, 5].map(id => ({ id })) }], totalElements: 1 }
    calls++
    active++
    expect(active).toBeLessThanOrEqual(4)
    if (active === 4) present(start)()
    return new Promise((resolve, reject) =>
      present(signal).addEventListener(
        'abort',
        () => {
          active--
          reject(new Error('TET CodePlane 查询超时或连接失败'))
        },
        { once: true },
      ),
    )
  }
  const work = readQuotas(query, { timeoutMs: 5000, signal: controller.signal })
  await started
  controller.abort()
  const result = await work
  expect(calls).toBe(4)
  expect(present(result.groups[0]).accounts).toHaveLength(5)
  expect(
    present(result.groups[0]).accounts.every(account => account.readings.periods.fiveHour.kind === 'unavailable'),
  ).toBe(true)
})
