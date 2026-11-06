import { expect, test } from 'bun:test'
import { discoverModels } from '../../src/models.mjs'
import { BASE, settings, loadCatalog, catalog } from '../helpers/plugin.mjs'

test('models only expose supported text families, exact IDs and known capacities', () => {
  const known = { limit: { context: 12345, output: 1000 }, cost: { input: 2 } }
  const payload = {
    data: [
      ...catalog.data,
      { id: 'gpt-image-2' },
      { id: 'gpt-6-audio' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'codex-auto-review' },
    ],
  }
  const models = discoverModels(payload, { models: { 'gpt-6.1-sol': known } }, settings())
  expect(Object.keys(models)).toEqual(['gpt-6.1-sol'])
  expect(models['gpt-6.1-sol']).toMatchObject({ name: 'Sol', providerID: 'tet', ...known })
  expect(models['gpt-6.1-sol'].api).toEqual({ id: 'gpt-6.1-sol', url: BASE, npm: '@ai-sdk/openai' })
})

test('model overrides configure verified capabilities and exclude exact IDs', () => {
  const opts = settings({
    modelOverrides: {
      'gpt-6.1-sol': {
        name: 'Custom Sol',
        imageInput: true,
        limit: { context: 10000, output: 1000 },
        reasoningLevels: ['low', 'high'],
      },
    },
  })
  const model = discoverModels(catalog, { models: {} }, opts)['gpt-6.1-sol']
  expect(model.name).toBe('Custom Sol')
  expect(model.capabilities.input.image).toBe(true)
  expect(Object.keys(model.variants)).toEqual(['low', 'high'])
  expect(discoverModels(catalog, { models: {} }, settings({ excludeModels: ['gpt-6.1-sol'] }))).toEqual({})
  expect(discoverModels(catalog, { models: {} }, settings())['gpt-6.1-sol'].limit.context).toBe(0)
})

test('safe model pagination reads all pages and rejects other origins, endpoints and cycles', async () => {
  const paths = []
  const payload = await loadCatalog(async path => {
    paths.push(path)
    return path === '/models' ? { data: [{ id: 'a' }], next: '?page=2' } : { data: [{ id: 'b' }] }
  })
  expect(payload.data.map(m => m.id)).toEqual(['a', 'b'])
  expect(paths).toEqual(['/models', '/models?page=2'])
  for (const next of ['https://example.com/v1/models', '/v1/usage', '/v1/models']) {
    await expect(loadCatalog(async () => ({ data: [], next }))).rejects.toThrow()
  }
})

test('cursor pagination requires progress', async () => {
  let calls = 0
  const result = await loadCatalog(async () =>
    ++calls === 1 ? { data: [{ id: 'a' }], has_more: true } : { data: [{ id: 'b' }] },
  )
  expect(result.data.length).toBe(2)
  await expect(loadCatalog(async () => ({ data: [], has_more: true }))).rejects.toThrow('cursor')
})
