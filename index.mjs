import { readFileSync } from 'node:fs'
import { NAME, PROVIDER, SDK, settings, apiBase, accountBase } from './src/config.mjs'
import { credentials, forward, createQueries } from './src/transport.mjs'
import { discoverModels, loadCatalog } from './src/models.mjs'
import { mapUsage } from './src/usage.mjs'
import { safeDetails } from './src/errors.mjs'
import { createManagement } from './src/management.mjs'
import { presentManagementUsage } from './src/management-usage.mjs'

const icon =
  'data:image/svg+xml;base64,' + readFileSync(new URL('./assets/logo.svg', import.meta.url)).toString('base64')

export const TetPlugin = async (input = {}, options = {}) => {
  const query = createQueries()
  const management = createManagement()
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
      provider: PROVIDER,
      icon,
      single: false,
      refreshLead: 5 * 60 * 1000,
      async refresh(auth) {
        if (auth?.type !== 'oauth' || !auth.metadata?.management?.accountLogin) return
        return management.refresh(auth, currentSettings().queryTimeoutMs)
      },
      options: [
        {
          key: 'show-traffic',
          label: 'Show traffic statistics',
          description: 'Include request counts, tokens and RPM/TPM.',
          default: configured.showTraffic,
        },
      ],
      methods: [
        {
          type: 'oauth',
          label: '账号登录',
          prompts: [
            { type: 'text', key: 'managementURL', message: '管理台地址' },
            { type: 'text', key: 'managementUsername', message: '管理台账号' },
            { type: 'password', key: 'managementPassword', message: '管理台密码' },
            { type: 'text', key: 'baseURL', message: '网关 API 地址（留空使用账号配置）' },
          ],
          async authorize(inputs, { signal } = {}) {
            const result = await management.authorizeAccount(inputs, currentSettings().queryTimeoutMs, signal)
            return {
              method: 'auto',
              instructions: '账号已验证，正在保存网关与管理台配置。',
              async callback() {
                return result
              },
            }
          },
        },
        {
          type: 'api',
          label: 'API Key',
          placeholder: 'sk-…',
          prompts: [
            {
              type: 'text',
              key: 'baseURL',
              message: 'API base URL',
              placeholder: 'https://relay.example',
              validate(value) {
                try {
                  apiBase(value)
                } catch (error) {
                  return error.message
                }
              },
            },
          ],
          async authorize(inputs) {
            return {
              type: 'success',
              metadata: {
                baseURL: apiBase(inputs.baseURL),
                management: undefined,
                managementURL: undefined,
                managementUsername: undefined,
                managementPassword: undefined,
                managementGroup: undefined,
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        const baseURL = accountBase(auth, currentSettings())
        return {
          baseURL,
          apiKey: credentials(auth),
          async fetch(input, init) {
            const current = await getAuth()
            /** 地址变更时旧请求不能携带新站点的 Key 发往旧站点。 */
            if (accountBase(current, currentSettings()) !== baseURL)
              throw new Error('TET account URL changed. Reload the request.')
            return forward(input, init, async () => current, baseURL)
          },
        }
      },
      async usage(getAuth) {
        try {
          const opts = currentSettings()
          const auth = await getAuth()
          credentials(auth)
          const [keyUsage, groupUsage] = await Promise.allSettled([
            query('/usage', auth, opts.queryTimeoutMs, accountBase(auth, opts)),
            management.read(auth, opts.queryTimeoutMs, async next => {
              const current = await getAuth()
              // 用户退出或替换登录后，旧查询不能覆盖新认证。
              if (JSON.stringify(current) !== JSON.stringify(auth)) return
              if (!input.client?.auth?.set) throw new Error('宿主不支持保存管理台会话，请更新 Magpie')
              try {
                await input.client.auth.set({ path: { id: PROVIDER }, body: next })
              } catch {
                throw new Error('管理台会话保存失败，请重试')
              }
            }),
          ])
          if (keyUsage.status === 'rejected') throw keyUsage.reason
          const payload = keyUsage.value
          const usage = mapUsage(payload, opts)
          if (payload.isValid && groupUsage.status === 'fulfilled') {
            return presentManagementUsage(usage, groupUsage.value)
          }
          return usage
        } catch (error) {
          return {
            error: error.message,
            windows: [],
            ...safeDetails(error),
            ...(error.signIn ? { signIn: error.signIn } : {}),
          }
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
        return discoverModels(
          await loadCatalog(path => query(path, auth, opts.queryTimeoutMs, opts.baseURL), opts.baseURL),
          provider,
          opts,
        )
      },
    },
  }
}
