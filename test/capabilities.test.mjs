import { expect, test } from 'bun:test'
import { discoverModels } from '../src/models.mjs'
import { settings } from '../src/config.mjs'

const id = 'gpt-6-luna'
const discover = (existing = {}, override = {}) => discoverModels({ data: [{ id }] },
  { models: { [id]: existing } }, settings({ baseURL: 'https://relay.example', modelOverrides: { [id]: override } }))[id]

test('catalog names do not advertise unverified optional capabilities', () => {
  const model = discover()
  expect(model.capabilities).toMatchObject({ temperature: false, reasoning: false, toolcall: false,
    attachment: false, input: { text: true, image: false } })
  expect(model.variants).toEqual({})
})

test('trusted host metadata and explicit overrides preserve verified capabilities', () => {
  const capabilities = { temperature: true, reasoning: true, toolcall: true, input: { image: true } }
  expect(discover({ capabilities }).capabilities).toMatchObject(capabilities)
  const model = discover({ capabilities }, { temperature: false, reasoning: false, toolCall: false, imageInput: false })
  expect(model.capabilities).toMatchObject({ temperature: false, reasoning: false, toolcall: false, input: { image: false } })
  expect(discover({}, { reasoningLevels: ['low'] }).variants).toEqual({ low: { reasoningEffort: 'low' } })
})

test('capability discovery never probes or permanently blacklists catalog models', () => {
  const models = discoverModels({ data: [{ id: 'gpt-5.4-mini' }, { id }] }, {}, settings())
  expect(Object.keys(models)).toEqual(['gpt-5.4-mini', id])
})
