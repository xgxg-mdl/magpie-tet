export const PROTOCOLS = Object.freeze({
  'openai-responses': '@ai-sdk/openai',
  'openai-chat': '@ai-sdk/openai-compatible',
  'anthropic-messages': '@ai-sdk/anthropic',
  'google-generative-ai': '@ai-sdk/google',
})

export const DEFAULT_PROTOCOL = 'openai-responses'
export const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf']

export function modelProtocol(existing, override, options) {
  return (
    override.protocol ??
    Object.keys(PROTOCOLS).find(protocol => PROTOCOLS[protocol] === existing?.api?.npm) ??
    options.defaultProtocol ??
    DEFAULT_PROTOCOL
  )
}

export function requestProtocol(path) {
  if (['/responses', '/responses/compact'].includes(path)) return 'openai-responses'
  if (path === '/chat/completions') return 'openai-chat'
  if (path === '/messages') return 'anthropic-messages'
  if (/^\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) return 'google-generative-ai'
}
