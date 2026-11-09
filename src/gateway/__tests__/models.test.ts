import { expect, test } from 'bun:test'
import { loadCatalog, parseCatalog } from '../models.ts'

const baseURL = 'https://gateway.example/v1'

test('catalog decoding keeps only valid identifiers and textual names', () => {
  expect(
    parseCatalog({
      data: [
        null,
        { id: '' },
        { id: '   ' },
        { id: 42 },
        { id: 'a', display_name: 42, name: 'Valid name', api: { npm: 'untrusted-package' } },
        { id: 'b', display_name: 'Display name', name: {} },
      ],
    }),
  ).toEqual({
    models: [
      { id: 'a', name: 'Valid name' },
      { id: 'b', displayName: 'Display name' },
    ],
    hasMore: false,
    lastID: 'b',
  })
  for (const value of [null, [], {}, { data: {} }]) expect(() => parseCatalog(value)).toThrow('invalid model list')
})

test('safe model pagination reads all pages and rejects other origins, endpoints and cycles', async () => {
  const paths: string[] = []
  const models = await loadCatalog(async path => {
    paths.push(path)
    return path === '/models' ? { data: [{ id: 'a' }], next: '?page=2' } : { data: [{ id: 'b' }] }
  }, baseURL)
  expect(models).toEqual([{ id: 'a' }, { id: 'b' }])
  expect(paths).toEqual(['/models', '/models?page=2'])
  for (const next of ['https://example.com/v1/models', '/v1/usage', '/v1/models']) {
    await expect(loadCatalog(async () => ({ data: [], next }), baseURL)).rejects.toThrow()
  }
})

test('cursor pagination requires progress', async () => {
  let calls = 0
  const result = await loadCatalog(
    async () => (++calls === 1 ? { data: [{ id: 'a' }], has_more: true } : { data: [{ id: 'b' }] }),
    baseURL,
  )
  expect(result.length).toBe(2)
  await expect(loadCatalog(async () => ({ data: [], has_more: true }), baseURL)).rejects.toThrow('cursor')
})
