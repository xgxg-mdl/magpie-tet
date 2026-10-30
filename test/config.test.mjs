import { expect, test } from 'bun:test'
import { TetPlugin } from '../index.mjs'
import { settings } from '../src/config.mjs'

test('unset host options preserve the package traffic default', async () => {
  let visible
  const plugin = await TetPlugin({ magpie: { option: () => visible } }, { showTraffic: false })
  expect(plugin.auth.options[0].default).toBe(false)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ isValid: true, balance: 1,
    usage: { today: { cost: 1, requests: 2, total_tokens: 3 } } })
  try {
    const getAuth = async () => ({ type: 'api', key: 'synthetic-key', metadata: { baseURL: 'https://test.example/v1' } })
    expect((await plugin.auth.usage(getAuth)).windows[1].display).toBe('1 USD')
    visible = true
    expect((await plugin.auth.usage(getAuth)).windows[1].display).toContain('3 tokens')
    visible = false
    expect((await plugin.auth.usage(getAuth)).windows[1].display).toBe('1 USD')
    visible = 'invalid'
    expect((await plugin.auth.usage(getAuth)).error).toBe('showTraffic must be boolean.')
  } finally { globalThis.fetch = originalFetch }
})

test('package options are validated before spreading and cannot change after initialization', async () => {
  await expect(TetPlugin({}, [])).rejects.toThrow('options must be an object')
  const levels = ['low']
  const options = { baseURL: 'https://first.example/v1', modelOverrides: { model: { reasoningLevels: levels } } }
  const configured = settings(options)
  const plugin = await TetPlugin({}, options)
  options.baseURL = 'https://second.example/v1'
  levels.push('high')
  expect(configured.modelOverrides.model.reasoningLevels).toEqual(['low'])
  const cfg = {}
  await plugin.config(cfg)
  expect(cfg.provider.tet.api).toBe('https://first.example/v1')
})

test('temperature overrides are boolean and preserve explicit false', () => {
  expect(settings({ modelOverrides: { model: { temperature: false } } }).modelOverrides.model.temperature).toBe(false)
  expect(() => settings({ modelOverrides: { model: { temperature: 'false' } } })).toThrow('temperature must be boolean')
})
