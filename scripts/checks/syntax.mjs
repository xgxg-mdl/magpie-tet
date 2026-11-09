import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scripts = join(root, 'scripts')
const files = (await readdir(scripts, { recursive: true })).filter(file => file.endsWith('.mjs')).sort()
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(scripts, file)], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
}
console.log('Script syntax verified with Node.js.')
