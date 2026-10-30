import { apiBase, PROVIDER, SDK } from './config.mjs'

/** 服务只返回模型标识；未核实的容量和推理档位保持未知，能力由已有元数据或显式配置补充。 */
export function discoverModels(payload, provider, options) {
  if (!Array.isArray(payload?.data)) throw new Error('TET returned an invalid model list.')
  const excluded = new Set(options.excludeModels)
  return Object.fromEntries(payload.data
    .filter(model => typeof model?.id === 'string' && /^gpt-[56](?:[.-]|$)/.test(model.id) &&
      !/(?:image|audio|realtime)/i.test(model.id) && !excluded.has(model.id))
    .map(model => {
      const existing = Object.hasOwn(provider.models ?? {}, model.id) ? provider.models[model.id] : {}
      const override = Object.hasOwn(options.modelOverrides, model.id) ? options.modelOverrides[model.id] : {}
      const capabilities = existing?.capabilities ?? {}
      /** 目录名称不是能力证据；显式档位可开启推理，已有禁用声明仍优先。 */
      const reasoning = override.reasoning ?? capabilities.reasoning ?? Boolean(override.reasoningLevels?.length)
      return [model.id, {
        ...existing,
        id: model.id, providerID: PROVIDER, status: 'active',
        name: override.name ?? model.display_name ?? model.name ?? existing?.name ?? model.id,
        api: { id: model.id, url: options.baseURL, npm: SDK },
        limit: override.limit ?? existing?.limit ?? { context: 0, output: 0 },
        capabilities: {
          ...capabilities,
          temperature: override.temperature ?? capabilities.temperature ?? false,
          reasoning,
          toolcall: override.toolCall ?? capabilities.toolcall ?? false,
          attachment: override.imageInput ?? capabilities.input?.image ?? false,
          input: { ...capabilities.input, text: true, image: override.imageInput ?? capabilities.input?.image ?? false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
        },
        variants: !reasoning ? {} : override.reasoningLevels ?
          Object.fromEntries(override.reasoningLevels.map(level => [level, { reasoningEffort: level }])) : existing?.variants ?? {},
      }]
    }))
}

/** 分页只能留在配置地址的模型端点；总页数和累计数据量都有界。 */
export async function loadCatalog(read, baseURL) {
  baseURL = apiBase(baseURL)
  const rows = []
  const visited = new Set()
  let path = '/models'
  let bytes = 0
  while (path) {
    if (visited.has(path) || visited.size >= 20) throw new Error('TET model pagination is repeated or excessive.')
    visited.add(path)
    const payload = await read(path)
    if (!Array.isArray(payload?.data)) throw new Error('TET returned an invalid model list.')
    bytes += Buffer.byteLength(JSON.stringify(payload))
    if (bytes > 4 * 1024 * 1024) throw new Error('TET model catalog exceeds 4 MiB.')
    rows.push(...payload.data)
    if (typeof payload.next === 'string' && payload.next) {
      const next = new URL(payload.next, baseURL + path)
      const endpoint = new URL(baseURL + '/models')
      if (next.origin !== endpoint.origin || next.pathname !== endpoint.pathname || next.username || next.password || next.hash) {
        throw new Error('TET refused model pagination outside its model endpoint.')
      }
      path = '/models' + next.search
    } else if (payload.has_more === true) {
      const cursor = payload.last_id ?? payload.data.at(-1)?.id
      if (typeof cursor !== 'string' || !cursor) throw new Error('TET model pagination has no cursor.')
      path = '/models?after_id=' + encodeURIComponent(cursor)
    } else path = null
  }
  return { data: rows }
}
