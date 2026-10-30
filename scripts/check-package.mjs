import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TetPlugin } from '../index.mjs'
const root = new URL('../', import.meta.url)
const files = ['index.mjs', ...(await readdir(new URL('src/', root))).filter(f => f.endsWith('.mjs')).map(f => 'src/' + f)]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
assert.equal(pkg.name, 'TET')
assert.equal(pkg.main, './index.mjs')
assert.equal(pkg.exports, './index.mjs')
assert(pkg.files.includes('assets/logo.svg'))
const icon = 'data:image/svg+xml;base64,' + (await readFile(new URL('assets/logo.svg', root))).toString('base64')
assert.equal(pkg.magpie.icon, icon)
const plugin = await TetPlugin()
assert.equal(plugin.auth.icon, icon)
assert.equal(plugin.auth.provider, 'tet')
assert.equal(plugin.auth.single, false)
assert.equal(plugin.provider.id, 'tet')
const cfg = {}
await plugin.config(cfg)
assert.equal(cfg.provider.tet.name, 'TET')
assert.deepEqual(Object.keys(await import('../index.mjs')), ['TetPlugin'])
console.log('Package, source syntax, identity and icons verified.')
