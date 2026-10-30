import { readFileSync } from 'node:fs'
import { NAME, PROVIDER, SDK, settings, apiBase, accountBase } from './src/config.mjs'
import { credentials, forward, createQueries } from './src/transport.mjs'
import { discoverModels, loadCatalog } from './src/models.mjs'
import { mapUsage } from './src/usage.mjs'
import { safeDetails } from './src/errors.mjs'

const icon = 'data:image/svg+xml;base64,' + readFileSync(new URL('./assets/logo.svg', import.meta.url)).toString('base64')

export const TetPlugin = async (input = {}, options = {}) => {
  const query = createQueries()
  const configured = settings(options)
  /** 只有供应商开关从宿主实时读取，结构化包选项由重载生效。 */
  const currentSettings = () => {
    const showTraffic = input.magpie?.option?.(PROVIDER, 'show-traffic') ?? configured.showTraffic
    if (typeof showTraffic !== 'boolean') throw new Error('showTraffic must be boolean.')
    return { ...configured, showTraffic }
  }
  currentSettings()
  return {
    async config(cfg) {
      cfg.provider ??= {}
      const { baseURL } = currentSettings()
      cfg.provider[PROVIDER] ??= { name: NAME, npm: SDK, ...(baseURL ? { api: baseURL } : {}), models: {} }
    },
    auth: {
      provider: PROVIDER, icon,
      single: false,
      options: [{ key: 'show-traffic', label: 'Show traffic statistics', description: 'Include request counts, tokens and RPM/TPM.', default: configured.showTraffic }],
      methods: [{ type: 'api', label: 'TET API key', placeholder: 'sk-…',
        prompts: [{ type: 'text', key: 'baseURL', message: 'API base URL', placeholder: 'https://relay.example',
          validate(value) { try { apiBase(value) } catch (error) { return error.message } } }],
        async authorize(inputs) {
          return { type: 'success', metadata: { baseURL: apiBase(inputs.baseURL) } }
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        const baseURL = accountBase(auth, currentSettings())
        return { baseURL, apiKey: credentials(auth), async fetch(input, init) {
          const current = await getAuth()
          /** 地址变更时旧请求不能携带新站点的 Key 发往旧站点。 */
          if (accountBase(current, currentSettings()) !== baseURL) throw new Error('TET account URL changed. Reload the request.')
          return forward(input, init, async () => current, baseURL)
        } }
      },
      async usage(getAuth) {
        try {
          const opts = currentSettings()
          const auth = await getAuth()
          credentials(auth)
          const payload = await query('/usage', auth, opts.queryTimeoutMs, accountBase(auth, opts))
          return mapUsage(payload, opts)
        } catch (error) {
          return { error: error.message, windows: [], ...safeDetails(error), ...(error.signIn ? { signIn: error.signIn } : {}) }
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return {}
        const opts = currentSettings()
        opts.baseURL = accountBase(auth, opts)
        /** 让宿主保留账号自己的缓存并显示刷新错误，避免悄悄伪装成刷新成功。 */
        return discoverModels(await loadCatalog(path => query(path, auth, opts.queryTimeoutMs, opts.baseURL), opts.baseURL), provider, opts)
      },
    },
  }
}
