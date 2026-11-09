import { settings as readSettings } from '../../src/config/index.ts'
import { loadCatalog as readCatalog } from '../../src/gateway/models.ts'
import type { GatewayAccess } from '../../src/auth/types.ts'

export const BASE = 'https://test-relay.example/v1'
export const settings = (options: Record<string, unknown> = {}) => readSettings({ baseURL: BASE, ...options })
export const loadCatalog = (read: (path: string) => Promise<unknown>, baseURL = BASE) => readCatalog(read, baseURL)
export const auth = { type: 'api', key: 'test-key-A', metadata: { baseURL: BASE } }
export const access: GatewayAccess = { baseURL: BASE, apiKey: auth.key }
export const catalog = { data: [{ id: 'gpt-6.1-sol', display_name: 'Sol' }] }
export const wallet = {
  isValid: true,
  mode: 'unrestricted',
  balance: 9999999443,
  usage: { today: { actual_cost: 0, requests: 0, total_tokens: 50 }, total: { cost: 555 }, rpm: 14 },
}
