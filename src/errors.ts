import { record } from './validation.ts'

const CATEGORIES = [
  'authentication',
  'rate_limit',
  'upstream',
  'request',
  'model_unavailable',
  'timeout',
  'network',
  'protocol',
] as const
/** 可向宿主展示的固定错误分类，不携带上游原始文本。 */
export type ErrorCategory = (typeof CATEGORIES)[number]
/** 经过白名单筛选的诊断字段，可附加到安全错误或用量结果。 */
export interface DiagnosticDetails {
  /** 已知失败类别，未知类别不向外传递。 */
  category?: ErrorCategory
  /** HTTP 失败状态码；safeDetails 仅保留 400–599 的整数。 */
  status?: number
  /** Retry-After：最多八位数字秒数，或符合 IMF-fixdate 形状且可被解析的日期字符串。 */
  retryAfter?: string
  /** 仅明确的模型不存在代码可向外传递。 */
  code?: 'model_not_found'
}

function retryAfter(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const date =
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw) && Number.isFinite(Date.parse(raw))
  return /^\d{1,8}$/.test(raw) || date ? raw : undefined
}

/**
 * 从 HTTP 失败响应提取分类、状态码及校验后的重试时间，不读取正文。
 * @param response 调用方已经判定为非成功的 HTTP 响应。
 * @returns 不包含 URL、正文或任意响应头的诊断字段。
 */
export function httpDetails(response: Response): DiagnosticDetails {
  const status = response.status
  const category =
    status === 401 || status === 403
      ? 'authentication'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'upstream'
          : 'request'
  const retry = retryAfter(response.headers.get('retry-after'))
  return { status, category, ...(retry ? { retryAfter: retry } : {}) }
}

/**
 * 从未知错误筛选允许展示的诊断字段，不复制任意错误属性。
 * @param error 捕获的异常、诊断对象或其他未知值。
 * @returns 已知分类、失败状态、合法重试时间与允许的错误代码。
 */
export function safeDetails(error: unknown): DiagnosticDetails {
  const out: DiagnosticDetails = {}
  if (!record(error)) return out
  const category = CATEGORIES.find(value => value === error.category)
  if (category) out.category = category
  if (typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599)
    out.status = error.status
  const retry = retryAfter(error.retryAfter)
  if (retry) out.retryAfter = retry
  if (error.code === 'model_not_found') out.code = error.code
  return out
}

/**
 * 取得 Error 的消息，为非 Error 值提供固定回退文本。
 * @param error 已经由调用模块进行安全处理的异常；此函数本身不脱敏 Error.message。
 * @returns Error.message 或固定查询失败提示。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'TET request failed. Retry later.'
}
