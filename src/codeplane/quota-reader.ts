import { decodeGroupPage, decodeQuotaReadings } from './decoders.ts'
import type { CodePlaneQuery, ListedQuotaGroup, QuotaGroup, QuotaReadings } from './types.ts'

const GROUPS = '/api/costs/llm-quotas'
const message = (error: unknown): string => (error instanceof Error ? error.message : 'TET CodePlane 服务异常')

async function listGroups(query: CodePlaneQuery, timeoutMs: number, signal: AbortSignal): Promise<ListedQuotaGroup[]> {
  const groups = new Map<number, ListedQuotaGroup>()
  for (let page = 1; page <= 20; page++) {
    const data = decodeGroupPage(await query(GROUPS + '?pageNum=' + page + '&pageSize=100', { timeoutMs, signal }))
    for (const group of data.groups) {
      if (groups.has(group.id)) throw new Error('TET CodePlane 分组分页重复')
      groups.set(group.id, group)
    }
    if (groups.size >= data.total) return [...groups.values()]
    if (!data.groups.length) break
  }
  throw new Error('TET CodePlane 分组列表不完整或过大')
}

/**
 * 读取当前完整分组与共享指标，跨分组相同上游只查询一次。
 * 最多同时处理两个上游、四个指标请求；单个指标失败仅影响该读数。
 * @param query 已绑定站点与会话恢复逻辑的请求函数，错误文本必须适合安全展示。
 * @param options 毫秒超时与整轮取消信号，列表分页及排队请求共用此信号。
 * @returns 当前分组快照及归一化读数，不跨调用缓存。
 * @throws 分组分页重复、不完整、超过 20 页或列表读取失败时抛出错误。
 */
export async function readQuotas(
  query: CodePlaneQuery,
  {
    timeoutMs,
    signal,
  }: {
    /** 单次请求超时，单位毫秒；整轮预算由 signal 同时约束。 */
    timeoutMs: number
    /** 分页、排队与指标请求共用的取消信号。 */
    signal: AbortSignal
  },
): Promise<{
  /** 当前读取到的完整分组及各来源的独立指标。 */
  groups: QuotaGroup[]
}> {
  const groups = await listGroups(query, timeoutMs, signal)
  const ids = [...new Set(groups.flatMap(group => group.accounts.map(account => account.id)))]
  const readings = new Map<number, QuotaReadings>()
  let next = 0
  const read = async (id: number, kind: 'usage' | 'credits'): Promise<Record<string, unknown>> => {
    if (signal.aborted) throw new Error('TET CodePlane 查询超时或连接失败')
    return query(GROUPS + '/' + id + '/' + kind + (kind === 'usage' ? '?active=false' : ''), { timeoutMs, signal })
  }
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      if (id === undefined) break
      const [usage, credits] = await Promise.allSettled([read(id, 'usage'), read(id, 'credits')])
      readings.set(
        id,
        decodeQuotaReadings({
          ...(usage.status === 'fulfilled' ? { usage: usage.value } : { usageError: message(usage.reason) }),
          ...(credits.status === 'fulfilled' ? { credits: credits.value } : { creditsError: message(credits.reason) }),
        }),
      )
    }
  }
  // 最多同时查询两个上游，每个上游两个只读接口。
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, worker))
  return {
    groups: groups.map(group => ({
      ...group,
      accounts: group.accounts.map(account => {
        const reading = readings.get(account.id)
        if (!reading) throw new Error('TET CodePlane 上游读数缺失')
        return { ...account, readings: reading }
      }),
    })),
  }
}
