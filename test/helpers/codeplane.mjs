export const codePlaneInputs = {
  baseURL: 'https://gateway.example',
  managementURL: 'https://console.example',
  managementUsername: 'synthetic-user',
  managementPassword: 'synthetic-password',
}

export const envelope = data => Response.json({ success: true, data })

/** TET CodePlane 更名后仍读取旧版 metadata.management 记录，持久化键不随模块名称迁移。 */
export function legacyAuth({ key = 'synthetic-key', token = 'old-token', ...binding } = {}) {
  const baseURL = 'https://gateway.example/v1'
  return {
    type: 'api',
    key,
    metadata: {
      baseURL,
      management: {
        url: codePlaneInputs.managementURL,
        token,
        expiresAt: Date.now() + 3600000,
        apiBaseURL: baseURL,
        username: codePlaneInputs.managementUsername,
        password: codePlaneInputs.managementPassword,
        ...binding,
      },
    },
  }
}
