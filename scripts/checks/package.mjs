import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout
}

run(process.execPath, ['--check', join(root, 'dist/index.mjs')])

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'TET')
assert.equal(pkg.main, './src/index.ts')
assert.equal(pkg.exports, './src/index.ts')
assert.deepEqual(pkg.files, ['src', 'assets/logo.svg', 'README.md', 'LICENSE'])
const icon = 'data:image/svg+xml;base64,' + (await readFile(join(root, 'assets/logo.svg'))).toString('base64')
assert.equal(pkg.magpie.icon, icon)

const temporary = await mkdtemp(join(tmpdir(), 'tet-package-'))
try {
  const release = join(root, '.release/package')
  const archive = join(root, '.release', `TET-v${pkg.version}.tar.gz`)
  const packed = run('tar', ['-tzf', archive]).trim().split('\n').filter(Boolean).sort()
  const expected = ['package.json', 'dist/index.mjs', 'dist/index.mjs.map', 'README.md', 'LICENSE']
    .map(file => 'package/' + file)
    .sort()
  assert.deepEqual(
    (await readdir(release, { recursive: true })).sort(),
    [...expected.map(path => path.slice('package/'.length)), 'dist'].sort(),
    'Release directory must match the explicit allowlist.',
  )
  assert.deepEqual(
    packed,
    [...expected, 'package/', 'package/dist/'].sort(),
    'Package contents must match the explicit release allowlist.',
  )
  run('tar', ['-xzf', archive, '-C', temporary])
  const manifest = JSON.parse(await readFile(join(temporary, 'package/package.json'), 'utf8'))
  const { scripts, devDependencies, packageManager, ...metadata } = pkg
  if (manifest.gitHead !== undefined) assert.equal(manifest.gitHead, run('git', ['rev-parse', 'HEAD']).trim())
  assert.deepEqual(manifest, {
    ...metadata,
    main: './dist/index.mjs',
    exports: './dist/index.mjs',
    files: ['dist', 'README.md', 'LICENSE'],
    ...(manifest.gitHead !== undefined ? { gitHead: manifest.gitHead } : {}),
  })
  for (const path of expected) {
    const file = path.slice('package/'.length)
    assert.deepEqual(
      await readFile(join(temporary, path)),
      await readFile(join(release, file)),
      `Archive differs: ${file}`,
    )
  }
  for (const file of ['dist/index.mjs', 'dist/index.mjs.map', 'README.md', 'LICENSE'])
    assert.deepEqual(
      await readFile(join(release, file)),
      await readFile(join(root, file)),
      `Stale release file: ${file}`,
    )
  const entry = pathToFileURL(join(temporary, 'package/dist/index.mjs')).href
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
  if (process.argv[2]) {
    run('bun', ['scripts/host/verify.mjs', process.argv[2], join(temporary, 'package')])
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log('Release archive, source contents and isolated Node package loading verified.')
