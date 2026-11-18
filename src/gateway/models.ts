import { apiBase } from '../config/address.ts'
import { REASONING_LEVELS, type ReasoningLevel } from '../protocols.ts'
import { record } from '../validation.ts'
import type { CatalogModel, CatalogPage } from './types.ts'

const CODEX_CATALOG_CLIENT_VERSION = '0.169.1'

/**
 * 将单页外部目录转换为基础模型及分页线索，跳过无效模型标识。
 * @param payload 网关 JSON 响应，尚未经结构校验。
 * @returns 已校验的目录页；名称不构成能力或容量证据。
 * @throws 响应缺少数组 data，或未提供 next 且声明后续页却没有可用游标时抛出错误。
 */
export function parseCatalog(payload: unknown): CatalogPage {
  if (!record(payload) || !Array.isArray(payload.data)) throw new Error('TET returned an invalid model list.')
  const models: CatalogModel[] = []
  for (const raw of payload.data) {
    if (!record(raw) || typeof raw.id !== 'string' || !raw.id.trim()) continue
    models.push({
      id: raw.id,
      ...(typeof raw.display_name === 'string' ? { displayName: raw.display_name } : {}),
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    })
  }
  const next = typeof payload.next === 'string' && payload.next ? payload.next : undefined
  const hasMore = payload.has_more === true
  const last = payload.data.at(-1)
  const cursor = payload.last_id ?? (record(last) ? last.id : undefined)
  if (!next && hasMore && (typeof cursor !== 'string' || !cursor))
    throw new Error('TET model pagination has no cursor.')
  return { models, hasMore, ...(next ? { next } : {}), ...(typeof cursor === 'string' ? { lastID: cursor } : {}) }
}

/**
 * 读取完整模型目录，分页始终限制在同一网关的模型端点。
 * @param read 读取相对路径并返回未知 JSON 的查询函数。
 * @param baseURL 账号网关 API 地址，纯站点地址会补齐 /v1。
 * @returns 按服务端页序合并的基础模型，不推断能力或去重标识。
 * @throws 查询失败、目录格式异常、分页重复或越界、超过 20 页或累计 4 MiB 时抛出错误。
 */
export async function loadCatalog(read: (path: string) => Promise<unknown>, baseURL: string): Promise<CatalogModel[]> {
  baseURL = apiBase(baseURL)
  const rows: CatalogModel[] = []
  const visited = new Set<string>()
  let path: string | null = '/models'
  let bytes = 0
  while (path) {
    if (visited.has(path) || visited.size >= 20) throw new Error('TET model pagination is repeated or excessive.')
    visited.add(path)
    const payload = await read(path)
    const page = parseCatalog(payload)
    bytes += Buffer.byteLength(JSON.stringify(payload))
    if (bytes > 4 * 1024 * 1024) throw new Error('TET model catalog exceeds 4 MiB.')
    rows.push(...page.models)
    if (page.next) {
      const next: URL = new URL(page.next, baseURL + path)
      const endpoint = new URL(baseURL + '/models')
      if (
        next.origin !== endpoint.origin ||
        next.pathname !== endpoint.pathname ||
        next.username ||
        next.password ||
        next.hash
      ) {
        throw new Error('TET refused model pagination outside its model endpoint.')
      }
      path = '/models' + next.search
    } else if (page.hasMore) {
      const cursor = page.lastID
      if (typeof cursor !== 'string' || !cursor) throw new Error('TET model pagination has no cursor.')
      path = '/models?after_id=' + encodeURIComponent(cursor)
    } else path = null
  }
  return rows
}

/**
 * 以普通目录为准，按精确模型标识合并 Codex 目录的可选档位。
 * @param read 当前账号的有界网关查询函数。
 * @param baseURL 当前账号的网关 API 地址。
 * @returns 普通目录及有效档位；辅助查询失败或无有效声明时仍返回普通目录。
 * @throws 普通目录查询或分页校验失败时拒绝。
 */
export async function loadCatalogWithReasoning(
  read: (path: string) => Promise<unknown>,
  baseURL: string,
): Promise<CatalogModel[]> {
  const models = await loadCatalog(read, baseURL)
  if (!models.length) return models
  const payload = await read(`/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`).catch(() => undefined)
  if (!record(payload) || !Array.isArray(payload.models)) return models

  const levelsByID = new Map<string, ReasoningLevel[]>()
  for (const row of payload.models) {
    if (!record(row) || typeof row.slug !== 'string' || !Array.isArray(row.supported_reasoning_levels)) continue
    const levels = new Set<ReasoningLevel>()
    for (const entry of row.supported_reasoning_levels) {
      const level = record(entry) && REASONING_LEVELS.find(value => value === entry.effort)
      if (level) levels.add(level)
    }
    if (!levels.size) continue
    if (
      levels.size === 1 &&
      levels.has('none') &&
      !row.supported_reasoning_levels.every(entry => record(entry) && entry.effort === 'none')
    )
      continue
    levelsByID.set(row.slug, [...levels])
  }
  return models.map(model => {
    const reasoningLevels = levelsByID.get(model.id)
    return reasoningLevels ? { ...model, reasoningLevels } : model
  })
}
