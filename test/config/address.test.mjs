import { expect, test } from 'bun:test'
import { apiBase } from '../../src/config.mjs'

test('API roots gain v1 while explicit prefixes are preserved', () => {
  for (const input of ['https://relay.example', ' https://relay.example/// ', 'https://relay.example/v1/']) {
    expect(apiBase(input)).toBe('https://relay.example/v1')
    expect(apiBase(apiBase(input))).toBe(apiBase(input))
  }
  for (const path of ['/proxy/openai', '/proxy/v1', '/v2', '/v1beta']) {
    expect(apiBase('https://relay.example' + path + '/')).toBe('https://relay.example' + path)
  }
})
