import { settings as readSettings } from '../../src/config.mjs'
import { loadCatalog as readCatalog } from '../../src/models.mjs'
import { createQueries as makeQueries } from '../../src/transport.mjs'

export const BASE = 'https://test-relay.example/v1'
export const settings = (options = {}) => readSettings({ baseURL: BASE, ...options })
export const loadCatalog = (read, baseURL = BASE) => readCatalog(read, baseURL)
export const createQueries = () => {
  const query = makeQueries()
  return (path, auth, timeout, baseURL = BASE) => query(path, auth, timeout, baseURL)
}
export const auth = { type: 'api', key: 'test-key-A', metadata: { baseURL: BASE } }
export const catalog = { data: [{ id: 'gpt-6.1-sol', display_name: 'Sol' }] }
export const wallet = {
  isValid: true,
  mode: 'unrestricted',
  balance: 9999999443,
  usage: { today: { actual_cost: 0, requests: 0, total_tokens: 50 }, total: { cost: 555 }, rpm: 14 },
}
