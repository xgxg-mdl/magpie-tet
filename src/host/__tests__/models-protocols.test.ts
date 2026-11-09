import { expect, test } from 'bun:test'
import { settings } from '../../config/index.ts'
import { discoverModels } from '../model-presentation.ts'
import { parseCatalog } from '../../gateway/models.ts'
import type { ModelMetadata } from '../model-types.ts'
import { present } from '../../../test/support/assertions.ts'

const discover = (options: Record<string, unknown> = {}, existing: ModelMetadata = {}) =>
  present(
    discoverModels(
      parseCatalog({
        data: [{ id: 'custom-model', api: { url: 'https://foreign.example', npm: 'untrusted-package' } }],
      }).models,
      { 'custom-model': existing },
      settings({ baseURL: 'https://relay.example', ...options }),
    )['custom-model'],
  )

test('protocol defaults preserve Responses and allow an explicit site default', async () => {
  expect(discover().api.npm).toBe('@ai-sdk/openai')
  expect(discover({ defaultProtocol: 'openai-chat' }).api).toEqual({
    id: 'custom-model',
    url: 'https://relay.example/v1',
    npm: '@ai-sdk/openai-compatible',
  })
})

test('model protocol overrides trusted host metadata and host metadata precedes the default', () => {
  const existing = { api: { npm: '@ai-sdk/anthropic', url: 'https://foreign.example' } }
  expect(discover({ defaultProtocol: 'openai-chat' }, existing).api.npm).toBe('@ai-sdk/anthropic')
  const adapters: [string, string][] = [
    ['openai-responses', '@ai-sdk/openai'],
    ['openai-chat', '@ai-sdk/openai-compatible'],
    ['anthropic-messages', '@ai-sdk/anthropic'],
    ['google-generative-ai', '@ai-sdk/google'],
  ]
  for (const [protocol, npm] of adapters) {
    expect(discover({ modelOverrides: { 'custom-model': { protocol } } }, existing).api.npm).toBe(npm)
  }
})

test('modalities preserve host declarations and explicit lists replace each direction independently', () => {
  const existing = { capabilities: { input: { text: false, audio: true }, output: { text: false, image: true } } }
  expect(discover({}, existing).capabilities).toMatchObject(existing.capabilities)
  const result = discover(
    {
      modelOverrides: {
        'custom-model': {
          modalities: { input: ['text', 'pdf'], output: ['audio'] },
          imageInput: true,
        },
      },
    },
    existing,
  )
  expect(result.capabilities.input).toEqual({ text: true, pdf: true, image: false, audio: false, video: false })
  expect(result.capabilities.output).toEqual({ text: false, pdf: false, image: false, audio: true, video: false })
  expect(result.capabilities.attachment).toBe(true)
  expect(
    discover({ modelOverrides: { 'custom-model': { modalities: { input: [] } } } }, existing).capabilities.input.audio,
  ).toBe(false)
})

test('protocols and modalities reject invalid config and copy caller-owned arrays', () => {
  for (const defaultProtocol of ['unknown', ['openai-chat']])
    expect(() => settings({ defaultProtocol })).toThrow('protocol')
  for (const override of [
    { protocol: 'unknown' },
    { protocol: ['openai-chat'] },
    { modalities: null },
    { modalities: { input: 'image' } },
    { modalities: { output: ['unknown'] } },
    { modalities: { url: [] } },
  ])
    expect(() => settings({ modelOverrides: { model: override } })).toThrow()
  const input = ['image']
  const options = settings({ modelOverrides: { model: { modalities: { input } } } })
  input.push('audio')
  expect(present(present(options.modelOverrides.model).modalities).input).toEqual(['image'])
})
