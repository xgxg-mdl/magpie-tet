/**
 * 在隔离宿主子进程中替换全局 fetch，提供合成账号、模型与用量响应。
 * @returns 无返回值；替换持续到子进程结束，不发送真实网络请求。
 * @throws 合成请求的地址或凭据不符合预期时，对应 fetch 拒绝。
 */
export function installHostUpstream() {
  let codePlaneLogins = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://console.example/')) {
      const envelope = data => Response.json({ success: true, data })
      if (url.endsWith('/api/auth/login') && JSON.parse(init.body).loginName === 'account-user')
        return envelope({
          userId: 42,
          apiKey: 'synthetic-key-B',
          token: 'account-session',
          tokenExpiresAt: Date.now() / 1000 + 60,
          codexGatewayUrl: 'https://second.example/api/v1',
        })
      if (url.endsWith('/api/auth/me') && new Headers(init?.headers).get('authorization') === 'Bearer account-session')
        return envelope({
          userId: 42,
          apiKey: 'synthetic-key-B',
          token: 'account-renewed',
          tokenExpiresAt: Date.now() / 1000 + 3600,
        })
      if (url.endsWith('/api/auth/login'))
        return envelope({
          userId: 41,
          apiKey: 'synthetic-key-A',
          token: 'test-session-' + ++codePlaneLogins,
          tokenExpiresAt: Date.now() / 1000 + (codePlaneLogins === 1 ? 60 : 3600),
        })
      if (url.endsWith('/api/auth/me')) return envelope({ userId: 41, tokenExpiresAt: 0 })
      if (
        !['Bearer test-session-2', 'Bearer account-renewed'].includes(new Headers(init?.headers).get('authorization'))
      )
        throw new Error('Wrong TET CodePlane credential')
      if (url.includes('?pageNum='))
        return envelope({
          content: [{ id: 7, name: 'Shared', accounts: [{ id: 5 }], capacity: { used: 2, max: 10 } }],
          totalElements: 1,
        })
      if (url.endsWith('/5/usage?active=false'))
        return envelope({
          fiveHour: { utilization: 0, resetsAt: '2000-01-01T00:00:00Z' },
          sevenDay: { utilization: 55, resetsAt: '2099-01-01T00:00:00Z' },
        })
      if (url.endsWith('/5/credits')) return envelope({ availableResetCount: 0 })
      throw new Error('Unexpected TET CodePlane endpoint')
    }
    const key = new Headers(init?.headers).get('authorization')
    const slot =
      key === 'Bearer synthetic-key-A'
        ? 'A'
        : key === 'Bearer synthetic-key-B'
          ? 'B'
          : key === 'Bearer synthetic-key-C'
            ? 'C'
            : key === 'Bearer synthetic-key-D'
              ? 'D'
              : key === 'Bearer synthetic-key-E'
                ? 'E'
                : key === 'Bearer synthetic-key-F'
                  ? 'F'
                  : null
    if (!slot) throw new Error('Unexpected test credential')
    await new Promise(resolve => setTimeout(resolve, slot === 'A' ? 20 : 5))
    if (url.endsWith('/models')) return Response.json({ data: [{ id: slot === 'B' ? 'gpt-6-luna' : 'gpt-6.1-sol' }] })
    if (url.endsWith('/usage') && slot === 'C')
      return Response.json({
        isValid: true,
        mode: 'quota_limited',
        balance: 0.0001,
        quota: { used: 12.3456, limit: 100 },
        rate_limits: [{ window: '1d', limit: 10 }],
      })
    if (url.endsWith('/usage') && slot === 'D')
      return Response.json({
        isValid: true,
        planName: 'Pro',
        balance: 5.6789,
        subscription: { daily_usage_usd: 0.012345, daily_limit_usd: 10, expires_at: '2099-01-01T00:00:00Z' },
      })
    if (url.endsWith('/usage') && slot === 'E')
      return Response.json({
        isValid: true,
        mode: 'quota_limited',
        quota: { used: 0, limit: 10 },
        rate_limits: [{ window: '5h', used: 0, limit: 5 }],
      })
    if (url.endsWith('/usage') && slot === 'F')
      return Response.json({ isValid: true, subscription: { daily_usage_usd: 0, daily_limit_usd: 10 } })
    if (url.endsWith('/usage'))
      return Response.json({
        isValid: true,
        mode: 'unrestricted',
        balance: slot === 'B' ? 56.78 : 12.34,
        usage: { today: { actual_cost: slot === 'B' ? 2 : 1, requests: 2, total_tokens: 50 }, rpm: 3 },
      })
    if (url.endsWith('/responses') || url.endsWith('/chat/completions'))
      return Response.json({ accountMarker: slot, received: JSON.parse(init.body || '{}') })
    throw new Error('Unexpected test endpoint')
  }
}
