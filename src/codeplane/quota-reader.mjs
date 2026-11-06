const GROUPS = '/api/costs/llm-quotas'

async function listGroups(query, timeoutMs, signal) {
  const groups = new Map()
  for (let page = 1; page <= 20; page++) {
    const data = await query(GROUPS + '?pageNum=' + page + '&pageSize=100', { timeoutMs, signal })
    if (!Array.isArray(data.content) || !Number.isSafeInteger(data.totalElements) || data.totalElements < 0) {
      throw new Error('TET CodePlane 分组列表异常')
    }
    for (const item of data.content) {
      if (!Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== 'string' || !item.name.trim()) {
        throw new Error('TET CodePlane 分组数据异常')
      }
      if (groups.has(item.id)) throw new Error('TET CodePlane 分组分页重复')
      if (
        !Array.isArray(item.accounts) ||
        item.accounts.some(account => !Number.isSafeInteger(account?.id) || account.id <= 0)
      ) {
        throw new Error('TET CodePlane 上游账号列表异常')
      }
      groups.set(item.id, {
        id: item.id,
        name: item.name.trim(),
        accounts: [
          ...new Map(
            item.accounts.map(account => [
              account.id,
              {
                id: account.id,
                name: typeof account.name === 'string' ? account.name.trim() : '',
              },
            ]),
          ).values(),
        ],
        capacity: item.capacity,
      })
    }
    if (groups.size >= data.totalElements) return [...groups.values()]
    if (!data.content.length) break
  }
  throw new Error('TET CodePlane 分组列表不完整或过大')
}

/** 分页、排队和上游读取共用总预算；认证恢复与宿主持久化由调用方处理。 */
export async function readQuotas(query, { timeoutMs, signal }) {
  const groups = await listGroups(query, timeoutMs, signal)
  const ids = [...new Set(groups.flatMap(group => group.accounts.map(account => account.id)))]
  const readings = new Map()
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      const kinds = ['usage', 'credits']
      const values = await Promise.allSettled(
        kinds.map(kind => {
          if (signal.aborted) return Promise.reject(new Error('TET CodePlane 查询超时或连接失败'))
          return query(GROUPS + '/' + id + '/' + kind + (kind === 'usage' ? '?active=false' : ''), {
            timeoutMs,
            signal,
          })
        }),
      )
      readings.set(
        id,
        Object.fromEntries(
          values.map((result, index) => {
            const kind = kinds[index]
            return result.status === 'fulfilled' ? [kind, result.value] : [kind + 'Error', result.reason.message]
          }),
        ),
      )
    }
  }
  // 最多同时查询两个上游，每个上游两个只读接口。
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, worker))
  return {
    groups: groups.map(group => ({
      ...group,
      accounts: group.accounts.map(account => ({ ...account, ...readings.get(account.id) })),
    })),
  }
}
