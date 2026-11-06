import { afterEach, expect, spyOn, test } from 'bun:test'
import { createCodePlane } from '../../src/codeplane/index.mjs'
import { presentCodePlaneUsage } from '../../src/codeplane/presentation.mjs'
import { envelope, legacyAuth } from '../helpers/codeplane.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const group = { id: 7, name: '示例分组', accounts: [{ id: 5 }], capacity: { used: 2, max: 10 } }
async function fixture() {
  const client = createCodePlane()
  return { client, auth: legacyAuth({ token: 'session-a' }) }
}
function readings(url) {
  return String(url).endsWith('/credits')
    ? { availableResetCount: 1 }
    : {
        fiveHour: { utilization: 0 },
        sevenDay: { utilization: 55, resetsAt: '2099-01-01T00:00:00Z' },
      }
}

test('shared upstreams are queried once across groups and failures stay local', async () => {
  const { client, auth } = await fixture()
  const calls = []
  globalThis.fetch = async url => {
    const path = String(url)
    calls.push(path)
    if (path.includes('?pageNum='))
      return envelope({
        content: [group, { ...group, id: 8, name: 'Other', accounts: [{ id: 5 }, { id: 6 }] }],
        totalElements: 2,
      })
    if (path.includes('/6/usage')) return new Response('private-detail', { status: 503 })
    return envelope(readings(url))
  }
  const result = await client.read(auth, 1000)
  expect(calls).toHaveLength(5)
  expect(calls.filter(url => url.includes('/5/usage'))).toHaveLength(1)
  expect(result.groups[0].accounts[0].usage.sevenDay.utilization).toBe(55)
  expect(result.groups[1].accounts[1].usageError).toContain('HTTP 503')
  expect(result.groups[1].accounts[1].credits.availableResetCount).toBe(1)
  expect(JSON.stringify(result)).not.toContain('private-detail')
  const shown = presentCodePlaneUsage({ windows: [] }, result)
  expect(shown.windows.filter(w => w.name.endsWith('并发'))).toHaveLength(2)
  expect(shown.windows.find(w => w.name === 'Other · 上游 6 · 7d').used).toBeUndefined()
  expect(shown.windows.find(w => w.name === '示例分组 · 7d').used).toBe(55)
})

test('different TET CodePlane sessions never share reads', async () => {
  const { client, auth } = await fixture()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return envelope({ content: [], totalElements: 0 })
  }
  const other = { metadata: { ...auth.metadata, management: { ...auth.metadata.management, token: 'session-b' } } }
  await Promise.all([client.read(auth, 1000), client.read(other, 1000)])
  expect(calls).toBe(2)
})

test('zero visible groups does not prevent login', async () => {
  const client = createCodePlane()
  globalThis.fetch = async url =>
    envelope(
      String(url).endsWith('/login')
        ? { userId: 7, apiKey: 'synthetic-key', token: 'session-a', tokenExpiresAt: Date.now() / 1000 + 3600 }
        : { content: [], totalElements: 0 },
    )
  const { metadata } = await client.authorizeAccount(
    {
      baseURL: 'https://gateway.example',
      managementURL: 'https://console.example',
      managementUsername: 'synthetic-user',
      managementPassword: 'synthetic-password',
    },
    1000,
  )
  const auth = { type: 'api', key: 'synthetic-key', metadata }
  expect((await client.read(auth, 1000)).groups).toEqual([])
  expect(auth.metadata.management.groupId).toBeUndefined()
})

test('multiple upstreams keep period pairs and subsequent groups aligned in native columns', () => {
  for (const count of [2, 3, 4]) {
    const accounts = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      usage: readings('/usage'),
      credits: readings('/credits'),
    }))
    const shown = presentCodePlaneUsage(
      { windows: [] },
      {
        groups: [
          { ...group, accounts },
          { ...group, id: 8, name: 'Next', accounts: [accounts[0]] },
        ],
      },
    )
    for (const account of accounts) {
      const five = shown.windows.findIndex(w => w.name === '示例分组 · 上游 ' + account.id + ' · 5h')
      expect(five % 2).toBe(0)
      expect(shown.windows[five + 1].name).toBe('示例分组 · 上游 ' + account.id + ' · 7d')
    }
    expect(shown.windows.findIndex(w => w.name === 'Next · 5h') % 2).toBe(0)
    expect(shown.windows.filter(w => w.name === '示例分组 · 并发')).toHaveLength(1)
    expect(shown.windows.every(w => w.display !== '' && typeof w.name === 'string')).toBe(true)
    expect(shown.windows.filter(w => w.name.includes('可用重置'))).toHaveLength(count + 1)
  }
})

test('single-sided statistics and odd key limits do not shift TET CodePlane pairs', () => {
  const account = { id: 5, usage: readings('/usage'), credits: readings('/credits') }
  for (const windows of [
    [{ name: 'Today', aside: true }],
    [
      { name: 'Total', aside: true },
      { name: 'Usage', aside: true },
    ],
    [{ name: 'Key limit' }, { name: 'Today', aside: true }, { name: 'Total', aside: true }],
  ]) {
    const shown = presentCodePlaneUsage({ windows }, { groups: [{ ...group, accounts: [account] }] })
    const five = shown.windows.findIndex(window => window.name === '示例分组 · 5h')
    expect(five % 2).toBe(0)
    expect(shown.windows[five + 1].name).toBe('示例分组 · 7d')
    expect(shown.windows[five + 2]).toEqual({ name: '示例分组 · 并发', display: '2 / 10', aside: true })
    expect(shown.windows[five + 3].name).toBe('示例分组 · 可用重置')
    expect(shown.windows.slice(0, windows.length)).toEqual(windows)
    if (windows.length % 2) {
      expect(shown.windows[five - 1]).toEqual({ name: 'TET CodePlane 来源', display: '示例分组', aside: true })
    }
    expect(windows.some(window => window.name === 'TET CodePlane 来源')).toBe(false)
  }
})

test('natural names cannot collide with generated group or upstream labels', () => {
  const account = { id: 5, name: '上游 6', usage: readings('/usage'), credits: readings('/credits') }
  const shown = presentCodePlaneUsage(
    { windows: [] },
    {
      groups: [
        { ...group, name: 'X', accounts: [account, { ...account, id: 6, name: '' }] },
        { ...group, id: 8, name: 'X', accounts: [account] },
        { ...group, id: 9, name: 'X #7', accounts: [account] },
      ],
    },
  )
  const names = shown.windows.map(window => window.name)
  expect(new Set(names).size).toBe(names.length)
  expect(shown.windows.filter(window => window.name.endsWith('5h'))).toHaveLength(4)
  expect(shown.windows.filter(window => window.name.endsWith('并发'))).toHaveLength(3)
})

test('hierarchy separators in natural names cannot collide across groups and upstreams', () => {
  const account = { id: 5, name: 'Y', usage: readings('/usage'), credits: readings('/credits') }
  const shown = presentCodePlaneUsage(
    { windows: [] },
    {
      groups: [
        { ...group, name: 'X', accounts: [account, { ...account, id: 6, name: 'Z' }] },
        { ...group, id: 8, name: 'X · Y', accounts: [account] },
        { ...group, id: 9, name: 'X / Y', accounts: [account] },
      ],
    },
  )
  const names = shown.windows.map(window => window.name)
  expect(new Set(names).size).toBe(names.length)
  expect(names).toContain('X · Y · 5h')
  expect(names).toContain('X / Y #8 · 5h')
  expect(names).toContain('X / Y #9 · 5h')
})

test('queued upstreams share a total deadline with at most four HTTP queries at once', async () => {
  const { client, auth } = await fixture()
  const deadlines = []
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    deadlines.push({ ms, controller })
    return controller.signal
  })
  let active = 0
  let calls = 0
  let ready
  const started = new Promise(resolve => {
    ready = resolve
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('?pageNum='))
      return envelope({
        content: [{ ...group, accounts: [1, 2, 3, 4, 5].map(id => ({ id })) }],
        totalElements: 1,
      })
    active++
    calls++
    expect(active).toBeLessThanOrEqual(4)
    if (active === 4) ready()
    return new Promise((resolve, reject) =>
      init.signal.addEventListener(
        'abort',
        () => {
          active--
          reject(init.signal.reason)
        },
        { once: true },
      ),
    )
  }
  let work
  try {
    work = client.read(auth, 60000)
    await started
    expect(deadlines.every(d => d.ms <= 5000)).toBe(true)
    deadlines[0].controller.abort(new DOMException('Timed out', 'TimeoutError'))
    const result = await work
    expect(calls).toBe(4)
    expect(result.groups[0].accounts).toHaveLength(5)
    expect(result.groups[0].accounts.every(a => a.usageError === 'TET CodePlane 查询超时或连接失败')).toBe(true)
  } finally {
    deadlines.forEach(d => d.controller.abort())
    if (work) await work
    timeout.mockRestore()
  }
})

test('same-named groups and unnamed upstreams remain distinct without summing percentages', () => {
  const account = { id: 5, name: 'Primary', usage: readings('/usage'), credits: readings('/credits') }
  const codePlane = {
    groups: [
      { ...group, accounts: [account] },
      {
        ...group,
        id: 8,
        accounts: [
          { ...account, id: 6, name: '' },
          { ...account, id: 7, name: '' },
        ],
      },
    ],
  }
  const shown = presentCodePlaneUsage({ windows: [] }, codePlane)
  const names = shown.windows.map(w => w.name)
  expect(new Set(names).size).toBe(names.length)
  expect(names).toContain('示例分组 #7 · 并发')
  expect(names).toContain('示例分组 #8 · 上游 6 · 5h')
  expect(shown.windows.filter(w => w.name.endsWith('7d')).map(w => w.used)).toEqual([55, 55, 55])
})

test('refresh follows rename, migration, addition and removal despite legacy binding fields', async () => {
  const { client, auth } = await fixture()
  Object.assign(auth.metadata.management, { groupId: 999, accountId: 999, groupName: 'Old' })
  let groups = [group]
  const calls = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    return envelope(
      String(url).includes('?pageNum=') ? { content: groups, totalElements: groups.length } : readings(url),
    )
  }
  expect((await client.read(auth, 1000)).groups[0].accounts[0].id).toBe(5)
  calls.length = 0
  groups = [
    { ...group, name: 'Renamed', accounts: [{ id: 6 }] },
    { ...group, id: 8, name: 'New', accounts: [] },
  ]
  const next = await client.read(auth, 1000)
  expect(next.groups.map(item => item.name)).toEqual(['Renamed', 'New'])
  expect(next.groups[0].accounts[0].id).toBe(6)
  expect(calls.some(url => url.includes('/5/'))).toBe(false)
  expect(calls.some(url => url.includes('/6/usage?active=false'))).toBe(true)
  groups = []
  const empty = await client.read(auth, 1000)
  expect(empty.groups).toEqual([])
  expect(presentCodePlaneUsage({ windows: [] }, empty).windows[0].display).toBe('暂无可见分组')
})
