import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

async function modules(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(entry => {
        const path = directory + '/' + entry.name
        return entry.isDirectory() ? modules(path) : entry.isFile() && path.endsWith('.mjs') ? [path] : []
      }),
    )
  ).flat()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout
}

const source = await modules('src')
const files = ['index.mjs', ...source, ...(await modules('scripts'))]
for (const file of files) {
  run(process.execPath, ['--check', join(root, file)])
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'TET')
assert.equal(pkg.main, './index.mjs')
assert.equal(pkg.exports, './index.mjs')
assert.deepEqual(pkg.files, ['index.mjs', 'src', 'assets/logo.svg', 'README.md', 'LICENSE'])
const icon = 'data:image/svg+xml;base64,' + (await readFile(join(root, 'assets/logo.svg'))).toString('base64')
assert.equal(pkg.magpie.icon, icon)

const temporary = await mkdtemp(join(tmpdir(), 'tet-package-'))
try {
  // 跳过生命周期脚本，避免 prepack 再次调用本检查；只在临时目录生成产物。
  run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', temporary, '--quiet'])
  const archives = (await readdir(temporary)).filter(file => file.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(temporary, archives[0])
  const packed = run('tar', ['-tzf', archive]).trim().split('\n').filter(Boolean).sort()
  const expected = ['package.json', 'index.mjs', 'README.md', 'LICENSE', 'assets/logo.svg', ...source]
    .map(file => 'package/' + file)
    .sort()
  assert.deepEqual(packed, expected, 'Package contents must match the explicit release allowlist.')
  run('tar', ['-xzf', archive, '-C', temporary])
  const entry = pathToFileURL(join(temporary, 'package/index.mjs')).href
  // 使用当前 Node 进程验证真正的发布包，避免从工作区误读缺失文件。
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `import assert from 'node:assert/strict'
const exported = await import(process.argv[1])
assert.deepEqual(Object.keys(exported), ['TetPlugin'])
const plugin = await exported.TetPlugin()
assert.equal(plugin.auth.icon, process.argv[2])
assert.equal(plugin.auth.provider, 'tet')
assert.equal(plugin.auth.single, false)
assert.equal(plugin.provider.id, 'tet')
const config = {}
await plugin.config(config)
assert.equal(config.provider.tet.name, 'TET')`,
    entry,
    icon,
  ])
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log('Source syntax, release contents and isolated Node package loading verified.')
