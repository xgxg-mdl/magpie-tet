import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { checkLocalMaterials } from '../../scripts/checks/local-materials.mjs'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'tet-local-materials-'))
  try {
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0)
    await writeFile(join(root, '.gitignore'), 'docs/local/\n')
    await writeFile(join(root, '.prettierignore'), 'docs/local/\n')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('local materials checks work without the private directory on disk', async () => {
  await fixture(root => checkLocalMaterials(root))
})

test('missing and overridden ignore rules fail the existing repository check', async () => {
  for (const file of ['.gitignore', '.prettierignore']) {
    await fixture(async root => {
      await writeFile(join(root, file), '')
      await assert.rejects(checkLocalMaterials(root), /must ignore the whole/)
      await writeFile(join(root, file), 'docs/local/\n!docs/local/\n')
      await assert.rejects(checkLocalMaterials(root))
    })
  }
})

test('force-adding local files is rejected even when the ignore rules are present', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'docs/local'), { recursive: true })
    await writeFile(join(root, 'docs/local/synthetic.md'), 'Synthetic local fixture\n')
    await checkLocalMaterials(root)
    assert.equal(spawnSync('git', ['add', '--force', 'docs/local/synthetic.md'], { cwd: root }).status, 0)
    await assert.rejects(checkLocalMaterials(root), /tracked or staged/)
  })
})

test('pre-commit rejects forced local materials before formatting staged files', async () => {
  await fixture(async root => {
    const project = new URL('../../', import.meta.url)
    const pkg = JSON.parse(await readFile(new URL('package.json', project), 'utf8'))
    await mkdir(join(root, 'scripts/checks'), { recursive: true })
    await cp(new URL('scripts/checks/local-materials.mjs', project), join(root, 'scripts/checks/local-materials.mjs'))
    await symlink(new URL('node_modules', project), join(root, 'node_modules'), 'dir')
    await cp(new URL('.husky/pre-commit', project), join(root, 'pre-commit'))
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          'check:local-materials': pkg.scripts['check:local-materials'],
          'lint-staged': "node --eval \"require('node:fs').writeFileSync('formatted', 'yes')\"",
          check: 'node --version',
          test: 'node --version',
        },
      }),
    )
    const hook = () => spawnSync('sh', ['-e', 'pre-commit'], { cwd: root, encoding: 'utf8' })
    const clean = hook()
    assert.equal(clean.status, 0, clean.stderr)
    await access(join(root, 'formatted'))
    await rm(join(root, 'formatted'))
    await mkdir(join(root, 'docs/local'), { recursive: true })
    await writeFile(join(root, 'docs/local/synthetic.md'), 'Synthetic local fixture\n')
    assert.equal(spawnSync('git', ['add', '--force', 'docs/local/synthetic.md'], { cwd: root }).status, 0)
    const blocked = hook()
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /tracked or staged/)
    await assert.rejects(access(join(root, 'formatted')), { code: 'ENOENT' })
  })
})
