function retryAfter(raw) {
  if (typeof raw !== 'string') return undefined
  const date = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) && Number.isFinite(Date.parse(raw))
  return /^\d{1,8}$/.test(raw) || date ? raw : undefined
}

/** 只传递固定分类和经过校验的重试时间，不携带响应正文、URL 或任意错误文本。 */
export function httpDetails(response) {
  const status = response.status
  const category = status === 401 || status === 403 ? 'authentication'
    : status === 429 ? 'rate_limit' : status >= 500 ? 'upstream' : 'request'
  const retry = retryAfter(response.headers.get('retry-after'))
  return { status, category, ...(retry ? { retryAfter: retry } : {}) }
}

export function safeDetails(error) {
  const out = {}
  if (['authentication', 'rate_limit', 'upstream', 'request', 'model_unavailable', 'timeout', 'network', 'protocol'].includes(error?.category)) out.category = error.category
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) out.status = error.status
  const retry = retryAfter(error?.retryAfter)
  if (retry) out.retryAfter = retry
  if (error?.code === 'model_not_found') out.code = error.code
  return out
}
