import { expect, test } from 'bun:test'
import { discoverModels } from '../model-presentation.ts'
import { parseCatalog } from '../../gateway/models.ts'
import { BASE, settings, catalog } from '../../../test/fixtures/gateway.ts'
import { present } from '../../../test/support/assertions.ts'

test('models preserve catalog IDs across versions, brands and modalities without inferring support', () => {
  const known = { limit: { context: 12345, output: 1000 }, cost: { input: 2 } }
  const payload = {
    data: [
      ...catalog.data,
      { id: 'gpt-image-2' },
      { id: 'gpt-6-audio' },
      { id: 'gpt-4o-audio-preview' },
      { id: 'codex-auto-review' },
      { id: 'gpt-7' },
      { id: 'claude-custom' },
      { id: '' },
      { id: '   ' },
      { id: null },
      null,
    ],
  }
  const models = discoverModels(parseCatalog(payload).models, { 'gpt-6.1-sol': known }, settings())
  expect(Object.keys(models)).toEqual([
    'gpt-6.1-sol',
    'gpt-image-2',
    'gpt-6-audio',
    'gpt-4o-audio-preview',
    'codex-auto-review',
    'gpt-7',
    'claude-custom',
  ])
  expect(models['gpt-6.1-sol']).toMatchObject({ name: 'Sol', providerID: 'tet', ...known })
  expect(present(models['gpt-6.1-sol']).api).toEqual({ id: 'gpt-6.1-sol', url: BASE, npm: '@ai-sdk/openai' })
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
  const model = present(discoverModels(parseCatalog(catalog).models, {}, opts)['gpt-6.1-sol'])
  expect(model.name).toBe('Custom Sol')
  expect(model.capabilities.input.image).toBe(true)
  expect(Object.keys(model.variants)).toEqual(['low', 'high'])
  expect(discoverModels(parseCatalog(catalog).models, {}, settings({ excludeModels: ['gpt-6.1-sol'] }))).toEqual({})
  expect(present(discoverModels(parseCatalog(catalog).models, {}, settings())['gpt-6.1-sol']).limit.context).toBe(0)
})

test('untrusted model names cannot pass non-string metadata into the host', () => {
  const models = discoverModels(
    parseCatalog({
      data: [
        { id: 'fallback-name', display_name: 42, name: 'Valid model' },
        { id: 'host-name', display_name: {}, name: [] },
        { id: 'fallback-id', display_name: false, name: null },
      ],
    }).models,
    { 'host-name': { name: 'Known model' } },
    settings(),
  )
  expect(present(models['fallback-name']).name).toBe('Valid model')
  expect(present(models['host-name']).name).toBe('Known model')
  expect(present(models['fallback-id']).name).toBe('fallback-id')
})
