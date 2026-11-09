import { expect, test } from 'bun:test'
import { TetPlugin } from '../../index.ts'
import type { HostConfig } from '../types.ts'
import { present } from '../../../test/support/assertions.ts'

test('provider config uses the configured gateway protocol adapter', async () => {
  const config: HostConfig = {}
  await (await TetPlugin({}, { defaultProtocol: 'openai-chat' })).config(config)
  expect(present(present(config.provider).tet).npm).toBe('@ai-sdk/openai-compatible')
})
