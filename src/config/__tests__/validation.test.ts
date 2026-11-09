import { present } from '../../../test/support/assertions.ts'
import { expect, test } from 'bun:test'
import { TetPlugin } from '../../index.ts'
import { settings } from '../../../test/fixtures/gateway.ts'

test('configuration rejects routing overrides and impossible limits before discovery', async () => {
  for (const opts of [
    { modelOverrides: { m: { api: 'https://example.com' } } },
    { modelLimits: { m: { context: 1, output: 2 } } },
    { queryTimeoutMs: 0 },
    { showTraffic: 'yes' },
    { modelOverrides: { m: { reasoningLevels: ['guess'] } } },
  ]) {
    await expect(TetPlugin({}, opts)).rejects.toThrow()
  }
  expect(
    present(present(settings({ modelLimits: { m: { context: 10, output: 2 } } }).modelOverrides.m).limit).context,
  ).toBe(10)
})

test('API base validation rejects credentials and non-HTTP endpoints', () => {
  for (const baseURL of [
    '',
    123,
    'ftp://relay.example/v1',
    'https://u:p@relay.example/v1',
    'https://relay.example/v1?token=test',
    'https://relay.example/v1#fragment',
    '/v1',
  ]) {
    expect(() => settings({ baseURL })).toThrow()
  }
  expect(settings({ baseURL: ' https://relay.example/ ' }).baseURL).toBe('https://relay.example/v1')
})

test('legacy limits fill nullish override limits while explicit valid limits take precedence', () => {
  const legacy = { context: 100, output: 20 }
  for (const limit of [null, undefined]) {
    expect(
      present(settings({ modelOverrides: { model: { limit } }, modelLimits: { model: legacy } }).modelOverrides.model)
        .limit,
    ).toEqual(legacy)
    expect(() => settings({ modelOverrides: { model: { limit } } })).toThrow('Model limits')
  }
  const limit = { context: 200, output: 40 }
  expect(
    present(settings({ modelOverrides: { model: { limit } }, modelLimits: { model: 'ignored' } }).modelOverrides.model)
      .limit,
  ).toEqual(limit)
})
