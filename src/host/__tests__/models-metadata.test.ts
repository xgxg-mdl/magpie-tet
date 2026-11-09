import { expect, test } from 'bun:test'
import { discoverModels } from '../model-presentation.ts'
import { settings } from '../../config/index.ts'
import type { ModelMetadata } from '../model-types.ts'
import { present } from '../../../test/support/assertions.ts'

const modelID = 'gpt-6.1-sol'
const variants = { high: { reasoningEffort: 'high' } }
const model = (existing: ModelMetadata = {}, override: unknown = {}) =>
  present(
    discoverModels(
      [{ id: modelID }],
      { [modelID]: existing },
      settings({
        baseURL: 'https://synthetic.example/v1',
        excludeModels: [],
        modelOverrides: { [modelID]: override },
      }),
    )[modelID],
  )

test('effective reasoning=false clears inherited and explicitly configured variants', () => {
  const existing = { capabilities: { reasoning: false }, variants }
  for (const override of [{}, { reasoningLevels: ['high'] }]) {
    const result = model(existing, override)
    expect(result.capabilities.reasoning).toBe(false)
    expect(result.variants).toEqual({})
  }
  expect(model({ capabilities: { reasoning: true }, variants }, { reasoning: false }).variants).toEqual({})
})

test('explicitly enabling reasoning restores configured variants over inherited metadata', () => {
  const result = model({ capabilities: { reasoning: false }, variants }, { reasoning: true, reasoningLevels: ['low'] })
  expect(result.capabilities.reasoning).toBe(true)
  expect(result.variants).toEqual({ low: { reasoningEffort: 'low' } })
  expect(model({ capabilities: { reasoning: true }, variants }).variants).toEqual(variants)
})

test('temperature override takes precedence without changing inherited or default values', () => {
  expect(model({ capabilities: { temperature: true } }, { temperature: false }).capabilities.temperature).toBe(false)
  expect(model({ capabilities: { temperature: false } }, { temperature: true }).capabilities.temperature).toBe(true)
  expect(model({ capabilities: { temperature: false } }).capabilities.temperature).toBe(false)
  expect(model().capabilities.temperature).toBe(false)
})
