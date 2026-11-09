import { httpDetails, safeDetails } from '../../src/errors.ts'

const MAX_BYTES = 4 * 1024 * 1024

/** 诊断失败，仅携带固定文本与经过白名单筛选的错误详情。 */
export class ProbeError extends Error {
  /**
   * @param message 不含上游正文、地址或凭据的安全错误文本。
   * @param details 交由 safeDetails 筛选的错误分类与状态信息。
   */
  constructor(message, details = {}) {
    super(message)
    Object.assign(this, safeDetails(details))
  }
}

/**
 * 以阶段名和安全诊断详情构造失败结果，不透传原始异常文本。
 * @param stage 固定的诊断阶段名称。
 * @param error 待筛选的异常或诊断详情。
 * @returns 包含允许的分类、HTTP 状态及重试时间的 ProbeError。
 */
export function failure(stage, error) {
  const details = safeDetails(error)
  return new ProbeError(
    stage +
      (details.category ? ' [' + details.category + ']' : '') +
      (details.status ? ' HTTP ' + details.status : '') +
      (details.retryAfter ? '; Retry-After: ' + details.retryAfter : '') +
      '.',
    details,
  )
}

/** 错误体只限量读取 JSON，且仅允许模型不可用这一固定代码。 */
async function responseFailure(response, signal) {
  const details = httpDetails(response)
  const size = response.headers.get('content-length')
  if (response.status === 400 || response.status === 404) {
    if (
      (size === null || (/^\d+$/.test(size) && Number(size) <= 8192)) &&
      response.headers.get('content-type')?.includes('application/json')
    ) {
      const reader = response.body?.getReader()
      if (reader) {
        try {
          const chunks = []
          let bytes = 0
          for (;;) {
            const { value, done } = await abortable(reader.read(), signal)
            if (done) break
            bytes += value.byteLength
            if (bytes > 8192) break
            chunks.push(value)
          }
          if (bytes <= 8192 && JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.code === 'model_not_found') {
            details.category = 'model_unavailable'
            details.code = 'model_not_found'
          }
        } catch {
        } finally {
          try {
            void reader.cancel().catch(() => {})
          } catch {}
          reader.releaseLock()
        }
      }
    }
  }
  try {
    void response.body?.cancel().catch(() => {})
  } catch {}
  return failure('TET Responses returned', details)
}

/** 即使合成响应没有实现 fetch 的取消约定，也不能让诊断无限等待。 */
async function abortable(task, signal) {
  let abort
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        abort = () => reject(new ProbeError('TET generation probe timed out.', { category: 'timeout' }))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * 检查 Responses JSON 是否已完成并包含至少一段非空文本。
 * @param response 待验证的服务响应对象。
 * @returns 结构、状态及文本均有效时为 true；推理内容本身不计入文本。
 */
export function completed(response) {
  return (
    response?.object === 'response' &&
    typeof response.id === 'string' &&
    response.id.length > 0 &&
    response.status === 'completed' &&
    !response.error &&
    Array.isArray(response.output) &&
    response.output.some(
      item =>
        item?.type === 'message' &&
        Array.isArray(item.content) &&
        item.content.some(
          part => part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim().length > 0,
        ),
    )
  )
}

function completedEvent(frame) {
  const lines = frame.split(/\r\n|\r|\n/)
  const event = lines
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim()
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n')
  const failed = new Set(['error', 'response.failed', 'response.incomplete'])
  if (failed.has(event)) throw new ProbeError('TET SSE reported ' + event + '.')
  if (!data || data === '[DONE]') return false
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    throw new ProbeError('TET SSE returned invalid event data.')
  }
  if (failed.has(payload?.type)) throw new ProbeError('TET SSE reported ' + payload.type + '.')
  if (event && event !== 'message' && event !== payload?.type)
    throw new ProbeError('TET SSE returned inconsistent event types.')
  if (payload?.type !== 'response.completed') return false
  if (!completed(payload.response)) throw new ProbeError('TET SSE returned an invalid completed response.')
  return true
}

/**
 * 发送一次 Responses 探测并验证 JSON 完成态或 SSE 终止事件。
 * @param loader 已绑定网关地址与认证转发函数的插件加载器。
 * @param model 显式选择的模型 ID。
 * @param stream 是否要求 SSE；开启时必须收到有效的 response.completed。
 * @param timeoutMs 请求及正文读取共用的毫秒预算。
 * @param extra 覆盖默认正文的能力探测参数。
 * @param verify 非流式能力断言；省略时验证普通文本完成态。
 * @returns 非流式验证成功时返回 JSON；流式成功时返回 undefined。
 * @throws HTTP、网络、超时、正文超过 4 MiB 或语义验证失败时拒绝为 ProbeError。
 */
export async function generationProbe(loader, model, stream, timeoutMs, extra = {}, verify) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    const response = await abortable(
      loader.fetch(loader.baseURL + '/responses', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify({ model, input: 'Reply only with OK.', max_output_tokens: 128, stream, ...extra }),
      }),
      controller.signal,
    )
    if (!response.ok) {
      throw await responseFailure(response, controller.signal)
    }
    reader = response.body?.getReader()
    if (!reader) throw new ProbeError('TET Responses returned an empty body.')
    if (stream && !/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new ProbeError('TET SSE did not return an event stream.')
    }
    const decoder = new TextDecoder()
    let text = '',
      bytes = 0
    for (;;) {
      const { done, value } = await abortable(reader.read(), controller.signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) throw new ProbeError('TET generation response exceeds 4 MiB.')
      text += decoder.decode(value, { stream: true })
      if (!stream) continue
      let boundary
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(text))) {
        const frame = text.slice(0, boundary.index)
        text = text.slice(boundary.index + boundary[0].length)
        if (completedEvent(frame)) return
      }
    }
    if (stream) throw new ProbeError('TET SSE ended without response.completed.')
    text += decoder.decode()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ProbeError('TET Responses returned invalid JSON.')
    }
    if (payload?.object === 'response' && ['failed', 'incomplete'].includes(payload.status)) {
      throw new ProbeError('TET Responses reported ' + payload.status + '.')
    }
    if (verify) {
      if (payload?.object !== 'response' || payload.status !== 'completed' || payload.error || !verify(payload)) {
        throw new ProbeError('TET capability verification failed.', { category: 'protocol' })
      }
    } else if (!completed(payload)) throw new ProbeError('TET Responses did not return a completed response.')
    return payload
  } catch (error) {
    throw error instanceof ProbeError
      ? error
      : new ProbeError('TET generation request failed or timed out.', {
          category: controller.signal.aborted ? 'timeout' : 'network',
        })
  } finally {
    clearTimeout(timer)
    if (reader) {
      try {
        void reader.cancel().catch(() => {})
      } catch {}
      reader.releaseLock()
    }
  }
}

/**
 * 按输出顺序拼接 Responses 消息中的文本片段。
 * @param payload 已经过结构验证的 Responses JSON。
 * @returns 拼接后的文本；没有文本片段时返回空字符串。
 */
export function outputText(payload) {
  return (payload.output ?? [])
    .flatMap(item => (item.type === 'message' ? (item.content ?? []) : []))
    .filter(item => item.type === 'output_text')
    .map(item => item.text ?? '')
    .join('')
}
