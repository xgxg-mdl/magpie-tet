import { createHash } from 'node:crypto'
import type { CodePlaneAccount, CodePlaneLogin } from '../../src/auth/types.ts'
import { encodeAuth } from '../../src/auth/storage.ts'

export const codePlaneInputs = {
  baseURL: 'https://gateway.example',
  codePlaneURL: 'https://console.example',
  username: 'synthetic-user',
  password: 'synthetic-password',
} satisfies CodePlaneLogin

export const envelope = (data: unknown) => Response.json({ success: true, data })

type AccountOverrides = Partial<CodePlaneAccount['session']> & {
  apiKey?: string
  gatewayBaseURL?: string
  uid?: string
}

export function codePlaneAccount({
  apiKey = 'synthetic-key',
  gatewayBaseURL = 'https://gateway.example/v1',
  token = 'old-token',
  uid,
  ...session
}: AccountOverrides = {}): CodePlaneAccount {
  const normalizedSession = {
    baseURL: codePlaneInputs.codePlaneURL,
    token,
    expiresAt: Date.now() + 3600000,
    userId: '41',
    username: codePlaneInputs.username,
    password: codePlaneInputs.password,
    ...session,
  }
  return {
    kind: 'codeplane',
    gateway: { baseURL: gatewayBaseURL, apiKey },
    session: normalizedSession,
    uid:
      uid ??
      createHash('sha256')
        .update(JSON.stringify([normalizedSession.baseURL, normalizedSession.userId]))
        .digest('hex'),
  }
}

export const storedCodePlaneAuth = (overrides: AccountOverrides = {}) => encodeAuth(codePlaneAccount(overrides))
