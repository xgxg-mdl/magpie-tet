import { expect, test } from 'bun:test'
import { decodeAuth, decodeLogin, encodeAuth } from '../storage.ts'
import { codePlaneAccount, codePlaneInputs, storedCodePlaneAuth } from '../../../test/fixtures/accounts.ts'
import type { ApiKeyAccount } from '../types.ts'

test('new CodePlane storage round-trips without duplicate session fields', () => {
  const account = codePlaneAccount()
  const stored = encodeAuth(account)
  expect(decodeAuth(stored)).toEqual(account)
  expect(stored.access).toBe(account.session.token)
  expect(stored.expires).toBe(account.session.expiresAt)
  expect(stored.metadata.codePlane).toEqual({
    baseURL: account.session.baseURL,
    userId: account.session.userId,
    username: account.session.username,
    password: account.session.password,
  })
  expect(stored.metadata).not.toHaveProperty('management')
  expect(stored.metadata.codePlane).not.toHaveProperty('token')
  expect(stored.metadata.codePlane).not.toHaveProperty('expiresAt')
})

test('API key storage and an explicit fallback URL remain usable', () => {
  const account: ApiKeyAccount = {
    kind: 'api-key',
    gateway: { baseURL: 'https://gateway.example/v1', apiKey: 'fixture-key' },
  }
  expect(decodeAuth(encodeAuth(account))).toEqual(account)
  expect(decodeAuth({ type: 'api', key: ' fixture-key ' }, 'https://gateway.example')).toEqual(account)
  expect(
    decodeAuth(
      { type: 'api', key: 'fixture-key', metadata: { baseURL: 'https://account.example' } },
      'https://package.example',
    ),
  ).toEqual({ ...account, gateway: { ...account.gateway, baseURL: 'https://account.example/v1' } })
})

test('encoding preserves a custom host label only for the same CodePlane identity', () => {
  const account = codePlaneAccount()
  const previous = { ...encodeAuth(account), accountId: 'Work account' }
  expect(encodeAuth(account, previous).accountId).toBe('Work account')
  expect(encodeAuth(account).accountId).toBe(account.session.username)
  expect(encodeAuth(account, { ...previous, uid: 'another-account' }).accountId).toBe(account.session.username)
  for (const accountId of ['', '   ', null, 123]) {
    expect(encodeAuth(account, { ...previous, accountId }).accountId).toBe(account.session.username)
  }
  expect(decodeAuth(previous)).toEqual(account)
})

test('management records are rejected rather than migrated or treated as plain API keys', () => {
  for (const type of ['api', 'oauth']) {
    expect(() =>
      decodeAuth({
        ...storedCodePlaneAuth(),
        type,
        metadata: { baseURL: 'https://gateway.example/v1', management: { token: 'old-session' } },
      }),
    ).toThrow('重新登录')
  }
})

test('CodePlane storage rejects missing or malformed session fields', () => {
  const stored = storedCodePlaneAuth()
  for (const patch of [
    { access: '' },
    { access: 'bad token' },
    { expires: Infinity },
    { expires: 0 },
    { uid: '' },
    { uid: 'invalid-format', refresh: 'invalid-format' },
    { refresh: '' },
    { refresh: 'another-account' },
    { metadata: { baseURL: stored.metadata.baseURL } },
    { metadata: { ...stored.metadata, codePlane: { ...stored.metadata.codePlane, userId: '' } } },
    { metadata: { ...stored.metadata, codePlane: { ...stored.metadata.codePlane, username: '' } } },
    { metadata: { ...stored.metadata, codePlane: { ...stored.metadata.codePlane, password: '' } } },
  ])
    expect(() => decodeAuth({ ...stored, ...patch })).toThrow()
  expect(() => decodeAuth({ type: 'oauth', key: 'key', access: 'token' })).toThrow()
})

test('invalid credentials and unsafe URLs fail while decoding', () => {
  for (const raw of [
    null,
    {},
    { type: 'api', key: '' },
    { type: 'other', key: 'key' },
    { type: 'api', key: 'key\nheader', metadata: { baseURL: 'https://gateway.example' } },
    { type: 'api', key: 'key', metadata: { baseURL: 'https://user@gateway.example' } },
    { ...storedCodePlaneAuth(), metadata: { baseURL: 'file:///tmp/no', codePlane: {} } },
  ])
    expect(() => decodeAuth(raw)).toThrow()
})

test('login decoding accepts only the new fields and normalizes addresses and username', () => {
  expect(
    decodeLogin({ ...codePlaneInputs, codePlaneURL: ' https://console.example/prefix/// ', username: ' user ' }),
  ).toEqual({
    ...codePlaneInputs,
    codePlaneURL: 'https://console.example/prefix',
    username: 'user',
    baseURL: 'https://gateway.example/v1',
  })
  expect(
    decodeLogin({ codePlaneURL: 'https://console.example', username: 'user', password: 'pass', baseURL: '' }),
  ).toEqual({ codePlaneURL: 'https://console.example', username: 'user', password: 'pass' })
  for (const input of [
    {},
    { managementURL: 'https://console.example', managementUsername: 'user', managementPassword: 'pass' },
    { ...codePlaneInputs, username: '' },
    { ...codePlaneInputs, password: '' },
    { ...codePlaneInputs, codePlaneURL: 'file:///tmp/no' },
  ])
    expect(() => decodeLogin(input)).toThrow()
})
