import { expect, test } from 'bun:test'
import { decodeGatewayConfiguration, decodeSessionInfo, decodeSessionReply } from '../session-decoder.ts'

test('login response decoding converts remote fields into typed session information', () => {
  const decoded = decodeSessionReply({
    token: 'fixture-session',
    tokenExpiresAt: 2000000000,
    user: { id: 7 },
    apiKey: 'fixture-key',
    codexGatewayUrl: 'https://gateway.example',
    privateField: 'must-not-escape',
  })
  expect(decoded).toEqual({
    token: 'fixture-session',
    expiresAt: 2000000000000,
    userId: '7',
    apiKey: 'fixture-key',
    gatewayURL: 'https://gateway.example/v1',
  })
  expect(decoded).not.toHaveProperty('data')
  expect(decoded).not.toHaveProperty('privateField')
})

test('me snapshots distinguish missing expiry from invalid or overflowing expiry', () => {
  expect(decodeSessionInfo({ userId: '7' }).expiresAt).toBeUndefined()
  for (const tokenExpiresAt of [null, '2000000000', Infinity, Number.MAX_VALUE]) {
    expect(decodeSessionInfo({ token: 'replacement', tokenExpiresAt }).expiresAt).toBeNull()
  }
  expect(decodeSessionInfo({ tokenExpiresAt: 0 }).expiresAt).toBe(0)
})

test('missing login fields stay unavailable while malformed DTOs fail with fixed text', () => {
  expect(decodeSessionInfo({})).toEqual({
    token: undefined,
    expiresAt: undefined,
    userId: undefined,
    apiKey: undefined,
    gatewayURL: undefined,
  })
  for (const raw of [null, [], { token: '' }, { token: 'bad token' }, { token: 'valid', userId: {} }]) {
    expect(() => decodeSessionReply(raw)).toThrow('TET CodePlane 登录数据异常')
  }
})

test('gateway configuration decoding validates key and address without retaining response data', () => {
  expect(
    decodeGatewayConfiguration({ apiKey: 'configured-key', gatewayPublicBaseUrl: 'https://gateway.example/proxy/v1/' }),
  ).toEqual({ apiKey: 'configured-key', gatewayURL: 'https://gateway.example/proxy/v1' })
  expect(decodeGatewayConfiguration({ apiKey: 'bad key' }).apiKey).toBeUndefined()
  for (const codexGatewayUrl of ['not-a-url', 'file:///private-detail', { invalid: true }]) {
    expect(decodeGatewayConfiguration({ apiKey: 'configured-key', codexGatewayUrl })).toEqual({
      apiKey: 'configured-key',
      gatewayURL: undefined,
    })
  }
  expect(() => decodeGatewayConfiguration(null)).toThrow('TET CodePlane 账号登录数据不完整')
})
