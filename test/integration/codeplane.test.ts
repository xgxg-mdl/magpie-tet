import { afterEach, expect, spyOn, test } from 'bun:test'
import { TetPlugin } from '../../src/index.ts'
import { createCodePlane } from '../../src/codeplane/session.ts'
import { presentCodePlaneUsage } from '../../src/host/codeplane-presentation.ts'
import { mockFetch } from '../support/fetch.ts'
import { codePlaneAccount, storedCodePlaneAuth, envelope, codePlaneInputs } from '../fixtures/accounts.ts'
import { present, rejected } from '../support/assertions.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const group = { id: 7, name: 'Shared', accounts: [{ id: 5 }], capacity: { used: 2, max: 10 } }
const token = 'synthetic-session'
const upstream = (calls: string[] = []) =>
  mockFetch(async (url, init) => {
    calls.push(String(url))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + token)
    if (String(url).includes('?pageNum=')) return envelope({ content: [group], totalElements: 1 })
    if (String(url).endsWith('/credits')) return envelope({ availableResetCount: 0 })
    return envelope({ fiveHour: { utilization: 0 }, sevenDay: { utilization: 55, resetsAt: '2099-01-01T00:00:00Z' } })
  })

test('gateway Key and CodePlane session remain isolated while traffic options preserve shared quotas', async () => {
  const calls: string[] = []
  const read = upstream(calls)
  const auth = storedCodePlaneAuth({ token })
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).startsWith('https://gateway.example/')) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ' + auth.key)
      return Response.json({ isValid: true, balance: 12, usage: { today: { actual_cost: 1, requests: 2 } } })
    }
    return read(url, init)
  })
  const plugin = await TetPlugin({}, { showTraffic: false })
  const shown = await plugin.auth.usage(async () => auth)
  expect(shown.balance).toBe('12.00 USD')
  expect(present(shown.windows.find(window => window.name === 'Today')).display).toBe('1.00 USD')
  expect(present(shown.windows.find(window => window.name === '5 hours')).used).toBe(0)
  expect(present(shown.windows.find(window => window.name === '7 days')).used).toBe(55)
  expect(shown.windows.find(window => window.name === '并发')).toEqual({ name: '并发', display: '2 / 10', aside: true })
  expect(calls.some(path => path.includes('/7/usage'))).toBe(false)
})

test('CodePlane authentication failures never hide a healthy gateway wallet or expire its Key', async () => {
  globalThis.fetch = mockFetch(async url =>
    String(url).startsWith('https://gateway.example/')
      ? Response.json({ isValid: true, balance: 12 })
      : new Response('private-server-detail', { status: 401 }),
  )
  const shown = await (await TetPlugin()).auth.usage(async () => storedCodePlaneAuth({ token }))
  expect(shown.balance).toBe('12.00 USD')
  expect(shown.signIn).toBeUndefined()
  expect(shown.error).toBeUndefined()
  expect(shown.windows.at(-1)?.name).toBe('分组')
  expect(JSON.stringify(shown)).not.toContain('private-server-detail')
})

test('short CodePlane deadlines preserve a completed wallet under a longer gateway budget', async () => {
  const deadlines: { ms: number; controller: AbortController }[] = []
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    deadlines.push({ ms, controller })
    return controller.signal
  })
  let begin: (() => void) | undefined
  const started = new Promise<void>(resolve => {
    begin = resolve
  })
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).startsWith('https://gateway.example/')) return Response.json({ isValid: true, balance: 12 })
    return new Promise<Response>((resolve, reject) => {
      const signal = present(init.signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      present(begin)()
    })
  })
  const plugin = await TetPlugin({}, { queryTimeoutMs: 60000 })
  let task: ReturnType<typeof plugin.auth.usage> | undefined
  try {
    task = plugin.auth.usage(async () => storedCodePlaneAuth({ token }))
    await started
    for (const deadline of deadlines.filter(item => item.ms !== 60000)) {
      expect(deadline.ms).toBeLessThanOrEqual(5000)
      deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'))
    }
    const shown = await task
    expect(shown.balance).toBe('12.00 USD')
    expect(shown.error).toBeUndefined()
    expect(shown.windows.at(-1)).toEqual({ name: '分组', display: 'TET CodePlane 查询超时或连接失败', aside: true })
    expect(deadlines.some(item => item.ms === 60000)).toBe(true)
  } finally {
    deadlines.forEach(item => item.controller.abort())
    if (task) await task
    timeout.mockRestore()
  }
})

test('same-session concurrent reads share a snapshot while different sessions remain isolated', async () => {
  const client = createCodePlane()
  const calls: string[] = []
  const read = upstream(calls)
  globalThis.fetch = mockFetch(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return read(...args)
  })
  const account = codePlaneAccount({ token })
  const [a, b] = await Promise.all([
    client.read(account, 1000),
    client.read({ ...account, gateway: { ...account.gateway, apiKey: 'another-key' } }, 1000),
  ])
  expect(calls).toHaveLength(3)
  expect(a).toEqual(b)
  await client.read(account, 1000)
  expect(calls).toHaveLength(6)
  calls.length = 0
  globalThis.fetch = mockFetch(async () => {
    calls.push('groups')
    return envelope({ content: [], totalElements: 0 })
  })
  await Promise.all([client.read(account, 1000), client.read(codePlaneAccount({ token: 'other-session' }), 1000)])
  expect(calls).toHaveLength(2)
})

test('group list failure produces one safe status and no stale quota windows', async () => {
  globalThis.fetch = mockFetch(async () => new Response('private-detail', { status: 503 }))
  const result = await createCodePlane().read(codePlaneAccount({ token }), 1000)
  const shown = presentCodePlaneUsage({ windows: [] }, result)
  expect(shown.windows).toEqual([{ name: '分组', display: 'TET CodePlane 服务异常（HTTP 503）', aside: true }])
  expect(JSON.stringify(shown)).not.toContain('private-detail')
})

test('login transport failures and malformed responses never expose raw server details', async () => {
  for (const response of [
    () => {
      throw new Error('private-network-secret')
    },
    () => new Response('private-body-secret'),
    () => Response.json({ success: false, message: 'private-body-secret' }),
    () => new Response('private-body-secret', { status: 403 }),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
  ]) {
    globalThis.fetch = mockFetch(async () => response())
    const error = await rejected(createCodePlane().login(codePlaneInputs, 1000))
    expect(error.message).not.toContain('private-')
  }
})
