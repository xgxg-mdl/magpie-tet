import assert from 'node:assert/strict'
import { afterEach, expect, test } from 'bun:test'
import { createCodePlane } from '../session.ts'
import { codePlaneAccount, codePlaneInputs, envelope } from '../../../test/fixtures/accounts.ts'
import { mockFetch } from '../../../test/support/fetch.ts'
import { present } from '../../../test/support/assertions.ts'
import type { CodePlaneAccount } from '../../auth/types.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function loginReply(overrides: Record<string, unknown> = {}) {
  return {
    userId: '7',
    apiKey: 'renewed-key',
    token: 'new-session',
    tokenExpiresAt: Date.now() / 1000 + 3600,
    codexGatewayUrl: 'https://gateway.example/v1',
    ...overrides,
  }
}

test('near-expiry and expired sessions share recovery while each reader saves its account', async () => {
  for (const expiresAt of [Date.now() + 60000, Date.now() - 60000]) {
    const client = createCodePlane()
    const account = codePlaneAccount({ expiresAt })
    let logins = 0
    globalThis.fetch = mockFetch(async (url, init) => {
      if (String(url).endsWith('/me')) return envelope({ userId: account.session.userId })
      if (String(url).endsWith('/login')) {
        logins++
        expect(JSON.parse(String(init.body))).toEqual({
          loginName: account.session.username,
          password: account.session.password,
        })
        return envelope(loginReply({ userId: account.session.userId }))
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer new-session')
      return envelope({ content: [], totalElements: 0 })
    })
    const saved: CodePlaneAccount[] = []
    const results = await Promise.all(
      [1, 2].map(() =>
        client.read(account, 1000, async next => {
          saved.push(next)
        }),
      ),
    )
    expect(results).toEqual([{ groups: [] }, { groups: [] }])
    expect(logins).toBe(1)
    expect(saved).toHaveLength(2)
    expect(saved.every(next => next.gateway.apiKey === 'renewed-key' && next.session.token === 'new-session')).toBe(
      true,
    )
    expect(account.session.token).not.toBe('new-session')
  }
})

test('a 401 before the recorded expiry recovers once and retries the query', async () => {
  const account = codePlaneAccount()
  const client = createCodePlane()
  let logins = 0
  let queries = 0
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith('/login')) {
      logins++
      return envelope(loginReply({ userId: account.session.userId }))
    }
    queries++
    return new Headers(init.headers).get('authorization') === 'Bearer ' + account.session.token
      ? new Response('', { status: 401 })
      : envelope({ content: [], totalElements: 0 })
  })
  const saved: CodePlaneAccount[] = []
  expect(
    await client.read(account, 1000, async next => {
      saved.push(next)
    }),
  ).toEqual({ groups: [] })
  expect(logins).toBe(1)
  expect(queries).toBe(3)
  expect(saved).toHaveLength(1)
})

test('failed recovery backs off and excludes private server details', async () => {
  const client = createCodePlane()
  const account = codePlaneAccount({ expiresAt: Date.now() - 1 })
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    return new Response('private-password-detail', { status: 401 })
  })
  const first = await client.read(account, 1000)
  expect(first).toEqual({ error: 'TET CodePlane 账号或密码有误' })
  expect(await client.read(account, 1000)).toEqual(first)
  expect(calls).toBe(2)
  expect(JSON.stringify(first)).not.toContain('private-')
})

test('simultaneous upstream 401 responses share one recovery and retry with the replacement token', async () => {
  const client = createCodePlane()
  const account = codePlaneAccount()
  let logins = 0
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith('/login')) {
      logins++
      await new Promise(resolve => setTimeout(resolve, 5))
      return envelope(loginReply({ userId: account.session.userId }))
    }
    if (String(url).includes('?pageNum='))
      return envelope({ content: [{ id: 7, name: 'Shared', accounts: [{ id: 5 }] }], totalElements: 1 })
    if (new Headers(init.headers).get('authorization') === 'Bearer ' + account.session.token)
      return new Response('', { status: 401 })
    return envelope(String(url).endsWith('/credits') ? { availableResetCount: 2 } : { fiveHour: { utilization: 0 } })
  })
  const result = await client.read(account, 1000)
  expect(logins).toBe(1)
  assert.ok('groups' in result)
  const reading = present(present(result.groups[0]).accounts[0]).readings
  expect(reading.periods.fiveHour).toEqual({ kind: 'available', utilization: 0, resetsAt: null })
  expect(reading.resets).toEqual({ kind: 'available', count: 2 })
})

test('a persistently rejected replacement token stops after one recovery', async () => {
  const client = createCodePlane()
  const account = codePlaneAccount()
  let logins = 0
  let reads = 0
  globalThis.fetch = mockFetch(async url => {
    if (String(url).endsWith('/login')) {
      logins++
      return envelope(loginReply({ userId: account.session.userId }))
    }
    reads++
    return new Response('', { status: 401 })
  })
  expect(await client.read(account, 1000)).toEqual({ error: 'TET CodePlane 登录已过期' })
  expect(logins).toBe(1)
  expect(reads).toBe(3)
})

test('a confirmed me renewal takes priority over password login and preserves gateway identity', async () => {
  const account = codePlaneAccount({ expiresAt: Date.now() + 60000 })
  const paths: string[] = []
  globalThis.fetch = mockFetch(async url => {
    paths.push(String(url))
    return envelope(loginReply({ userId: account.session.userId }))
  })
  const next = present(await createCodePlane().refresh(account, 1000))
  expect(paths).toEqual([account.session.baseURL + '/api/auth/me'])
  expect(next.session.token).toBe('new-session')
  expect(next.session.expiresAt).toBeGreaterThan(account.session.expiresAt)
  expect(next.uid).toBe(account.uid)
  expect(next.gateway.baseURL).toBe(account.gateway.baseURL)
})

test('renewal keeps the confirmed gateway when me or login advertises an invalid gateway', async () => {
  for (const renewedBy of ['me', 'login']) {
    const account = codePlaneAccount({ expiresAt: Date.now() + 60000 })
    const paths: string[] = []
    globalThis.fetch = mockFetch(async url => {
      paths.push(String(url))
      if (renewedBy === 'login' && String(url).endsWith('/me')) {
        return envelope({ userId: account.session.userId })
      }
      return envelope(loginReply({ userId: account.session.userId, codexGatewayUrl: 'not-a-url' }))
    })
    const next = present(await createCodePlane().refresh(account, 1000))
    expect(next.gateway.baseURL).toBe(account.gateway.baseURL)
    expect(next.session.token).toBe('new-session')
    expect(paths).toEqual([
      account.session.baseURL + '/api/auth/me',
      ...(renewedBy === 'login' ? [account.session.baseURL + '/api/auth/login'] : []),
    ])
  }
})

test('an unchanged me snapshot falls back to login and rotates the key without moving the gateway', async () => {
  const account = codePlaneAccount({ expiresAt: Date.now() + 60000 })
  const paths: string[] = []
  globalThis.fetch = mockFetch(async url => {
    paths.push(String(url))
    return envelope(
      String(url).endsWith('/me')
        ? {
            userId: account.session.userId,
            token: account.session.token,
            tokenExpiresAt: account.session.expiresAt / 1000,
          }
        : loginReply({ userId: account.session.userId, codexGatewayUrl: 'https://unexpected.example/v1' }),
    )
  })
  const next = present(await createCodePlane().refresh(account, 1000))
  expect(paths).toEqual([account.session.baseURL + '/api/auth/me', account.session.baseURL + '/api/auth/login'])
  expect(next.gateway).toEqual({ baseURL: account.gateway.baseURL, apiKey: 'renewed-key' })
})

test('renewal rejects a changed identity and falls back from an expired replacement token', async () => {
  for (const changedIdentity of [true, false]) {
    const account = codePlaneAccount({ expiresAt: Date.now() + 60000 })
    const paths: string[] = []
    globalThis.fetch = mockFetch(async url => {
      paths.push(String(url))
      return envelope(
        String(url).endsWith('/me')
          ? loginReply({ userId: changedIdentity ? 'other' : account.session.userId, tokenExpiresAt: 1 })
          : loginReply({ userId: account.session.userId }),
      )
    })
    const task = createCodePlane().refresh(account, 1000)
    if (changedIdentity) {
      await expect(task).rejects.toThrow('账号已变更')
      expect(paths).toHaveLength(1)
    } else {
      expect(present(await task).session.token).toBe('new-session')
      expect(paths).toHaveLength(2)
    }
  }
})

test('concurrent identical logins share the credential exchange', async () => {
  const client = createCodePlane()
  let calls = 0
  globalThis.fetch = mockFetch(async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 5))
    return envelope(loginReply())
  })
  const [a, b] = await Promise.all([client.login(codePlaneInputs, 1000), client.login(codePlaneInputs, 1000)])
  expect(calls).toBe(1)
  expect(a).toEqual(b)
})

test('login rejects an expiry that overflows when converted from seconds', async () => {
  globalThis.fetch = mockFetch(async () => envelope(loginReply({ tokenExpiresAt: Number.MAX_VALUE })))
  await expect(createCodePlane().login(codePlaneInputs, 1000)).rejects.toThrow('账号登录数据不完整')
})

test('me cannot renew with an invalid explicit expiry even when its token changes', async () => {
  const account = codePlaneAccount({ expiresAt: Date.now() + 60000 })
  const paths: string[] = []
  globalThis.fetch = mockFetch(async url => {
    paths.push(String(url))
    return envelope(
      String(url).endsWith('/me')
        ? loginReply({ userId: account.session.userId, token: 'unconfirmed-token', tokenExpiresAt: Number.MAX_VALUE })
        : loginReply({ userId: account.session.userId }),
    )
  })
  const next = present(await createCodePlane().refresh(account, 1000))
  expect(paths).toEqual([account.session.baseURL + '/api/auth/me', account.session.baseURL + '/api/auth/login'])
  expect(next.session.token).toBe('new-session')
})
