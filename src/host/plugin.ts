import { NAME, PROVIDER, settings, apiBase } from '../config/index.ts'
import { decodeAuth, decodeLogin, encodeAuth } from '../auth/storage.ts'
import { createQueries } from '../gateway/client.ts'
import { forward } from '../gateway/forwarding.ts'
import { loadCatalog } from '../gateway/models.ts'
import { discoverModels, PROTOCOLS } from './model-presentation.ts'
import { parseUsage } from '../gateway/usage.ts'
import { presentGatewayUsage } from './gateway-presentation.ts'
import { errorMessage, safeDetails } from '../errors.ts'
import { createCodePlane } from '../codeplane/session.ts'
import { presentCodePlaneUsage } from './codeplane-presentation.ts'
import { record } from '../validation.ts'
import type { HostInput, PluginHooks } from './types.ts'

// 源码测试直接读取图标；发布构建通过模块替换内嵌它，不依赖运行时资源路径。
import { icon } from '../icon.ts'

/**
 * 创建 TET 供应商的宿主适配钩子及账号作用域内的请求协调器。
 *
 * 包选项在创建时校验并固定；流量开关在调用时从宿主读取。
 * 实际登录与查询由宿主调用对应钩子触发，装配本身不发送网络请求。
 *
 * @param input 宿主的认证存储与动态选项能力，缺省为空能力集。
 * @param options 未校验的包选项，缺省使用项目默认配置。
 * @returns 配置、认证、会话恢复、模型发现和用量钩子。
 * @throws 包选项或宿主初始流量开关不合法时抛出配置错误。
 */
export const TetPlugin = async (input: HostInput = {}, options: unknown = {}) => {
  const query = createQueries()
  const codePlane = createCodePlane()
  const configured = settings(options)
  /** 只有供应商开关从宿主实时读取，结构化包选项由重载生效。 */
  const currentSettings = () => {
    const showTraffic = input.magpie?.option?.(PROVIDER, 'show-traffic') ?? configured.showTraffic
    if (typeof showTraffic !== 'boolean') throw new Error('showTraffic must be boolean.')
    return { ...configured, showTraffic }
  }
  currentSettings()
  return {
    /** 补齐供应商配置；用户已有的供应商项保持不变。 */
    async config(cfg) {
      cfg.provider ??= {}
      const { baseURL } = currentSettings()
      cfg.provider[PROVIDER] ??= {
        name: NAME,
        npm: PROTOCOLS[configured.defaultProtocol],
        ...(baseURL ? { api: baseURL } : {}),
        models: {},
      }
    },
    auth: {
      provider: PROVIDER,
      icon,
      single: false,
      refreshLead: 5 * 60 * 1000,
      /**
       * 恢复到期前五分钟内的 CodePlane 会话，返回由宿主保存的新认证。
       * @param rawAuth 当前账号认证；空值或 API Key 账号无需续期。
       * @returns 新认证或 undefined；保留相同身份的自定义账号标签。
       * @throws 认证不合法、恢复失败或身份变更时拒绝 Promise。
       */
      async refresh(rawAuth) {
        if (!rawAuth) return
        const account = decodeAuth(rawAuth, configured.baseURL)
        if (account.kind !== 'codeplane') return
        const next = await codePlane.refresh(account, currentSettings().queryTimeoutMs)
        return next ? encodeAuth(next, rawAuth) : undefined
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
          label: 'TET CodePlane 账号登录',
          prompts: [
            { type: 'text', key: 'codePlaneURL', message: 'TET CodePlane 地址' },
            { type: 'text', key: 'username', message: 'TET CodePlane 账号' },
            { type: 'password', key: 'password', message: 'TET CodePlane 密码' },
            { type: 'text', key: 'baseURL', message: '网关 API 地址（留空使用账号配置）' },
          ],
          /**
           * 校验账号并建立自动授权流程，取消信号参与整个登录预算。
           * @param inputs 宿主表单输入，在认证入口解析为内部登录模型。
           * @param context 宿主授权上下文，包含可选取消信号。
           * @returns 回调时交付完整存储数据的自动流程。
           * @throws 输入、账号响应或网关配置无效时拒绝 Promise。
           */
          async authorize(inputs, { signal } = {}) {
            const account = await codePlane.login(decodeLogin(inputs), currentSettings().queryTimeoutMs, signal)
            return {
              method: 'auto',
              instructions: '账号已验证，正在保存网关与 TET CodePlane 配置。',
              /** 返回已经验证的认证快照，不重复登录或直接写入宿主。 */
              async callback() {
                return { ...encodeAuth(account), type: 'success' }
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
                  return errorMessage(error)
                }
                return undefined
              },
            },
          ],
          /**
           * 校验 API Key 登录的网关地址，并清除当前登录项的 CodePlane 数据。
           * @param inputs 宿主表单输入；Key 由宿主单独采集。
           * @returns 授权成功标记与归一化元数据。
           * @throws 网关地址无效时拒绝 Promise。
           */
          async authorize(inputs) {
            return {
              type: 'success',
              metadata: {
                baseURL: apiBase(inputs.baseURL),
                codePlane: undefined,
              },
            }
          },
        },
      ],
      /**
       * 为当前账号建立网关访问器，每次转发重新读取最新认证。
       * @param getAuth 宿主当前账号作用域内的认证读取函数。
       * @returns 未登录时为空对象，否则包含网关地址、Key 与转发函数。
       * @throws 认证或网关地址不合法时拒绝 Promise。
       */
      async loader(getAuth) {
        const rawAuth = await getAuth()
        if (!rawAuth) return {}
        const account = decodeAuth(rawAuth, configured.baseURL)
        const { baseURL, apiKey } = account.gateway
        return {
          baseURL,
          apiKey,
          /** 透传支持的模型请求；切换网关后要求重新创建访问器。 */
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const current = decodeAuth(await getAuth(), configured.baseURL)
            return forward(input, init, async () => current.gateway, baseURL)
          },
        }
      },
      /**
       * 并发读取网关用量与可选共享额度，持久化本账号的恢复会话。
       * @param getAuth 宿主当前账号认证读取函数，也用于保存前检查登录是否变化。
       * @returns 安全用量快照；共享读取失败不隐藏健康钱包，网关失败返回错误快照。
       */
      async usage(getAuth) {
        try {
          const opts = currentSettings()
          const rawAuth = await getAuth()
          const account = decodeAuth(rawAuth, configured.baseURL)
          const [keyUsage, codePlaneUsage] = await Promise.allSettled([
            query('/usage', account.gateway, opts.queryTimeoutMs),
            account.kind === 'codeplane'
              ? codePlane.read(account, opts.queryTimeoutMs, async next => {
                  const current = await getAuth()
                  // 退出或替换登录后，旧查询不能覆盖新认证。
                  if (JSON.stringify(current) !== JSON.stringify(rawAuth)) return
                  if (!input.client?.auth?.set) throw new Error('宿主不支持保存 TET CodePlane 会话，请更新 Magpie')
                  try {
                    await input.client.auth.set({ path: { id: PROVIDER }, body: encodeAuth(next, rawAuth) })
                  } catch {
                    throw new Error('TET CodePlane 会话保存失败，请重试')
                  }
                })
              : Promise.resolve(null),
          ])
          if (keyUsage.status === 'rejected') throw keyUsage.reason
          const gatewayUsage = parseUsage(keyUsage.value)
          const usage = presentGatewayUsage(gatewayUsage, opts)
          if (gatewayUsage.kind === 'valid' && codePlaneUsage.status === 'fulfilled')
            return presentCodePlaneUsage(usage, codePlaneUsage.value)
          return usage
        } catch (error) {
          return {
            error: errorMessage(error),
            windows: [],
            ...safeDetails(error),
            ...(record(error) && typeof error.signIn === 'string' ? { signIn: error.signIn } : {}),
          }
        }
      },
    },
    provider: {
      id: PROVIDER,
      /**
       * 查询当前账号模型目录并映射为宿主模型，不进行生成请求或能力探测。
       * @param provider 宿主已有模型元数据快照。
       * @param context 当前账号的认证上下文。
       * @returns 无认证时为空目录，否则返回合并配置后的有效模型。
       * @throws 认证、目录查询或分页校验失败时拒绝，交由宿主保留已有缓存并展示错误。
       */
      async models(provider, { auth } = {}) {
        if (!auth) return {}
        const opts = currentSettings()
        const account = decodeAuth(auth, configured.baseURL)
        const baseURL = account.gateway.baseURL
        return discoverModels(
          await loadCatalog(path => query(path, account.gateway, opts.queryTimeoutMs), baseURL),
          provider.models ?? {},
          { ...opts, baseURL },
        )
      },
    },
  } satisfies PluginHooks
}
